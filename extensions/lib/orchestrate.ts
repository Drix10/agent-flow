/**
 * `agent-flow run`: the Orchestrator skill as code.
 *
 * One issue goes Implementer → classify → Reviewer → gates → QA → PR, each role a separate process, handing files to
 * the next. This module is only the loop. Every decision that matters (state transitions and the round cap, risk,
 * report validation, gates, the completion binding) is made by the same `agent-flow` subcommands the skill uses; they are
 * called through the injected `af`, so the two cannot drift and a test can run the whole loop against a fake agent.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Spawner } from "./launch.js";
import { issueCost } from "./state.js";

export type Role = "implementer" | "reviewer" | "qa";
export interface CmdResult {
  status: number;
  stdout: string;
  stderr: string;
}
/** Runs an `agent-flow` subcommand from the repo root. */
export type Af = (args: string[]) => CmdResult;
/** Runs any other program (git, gh). */
export type Sh = (cmd: string, args: string[], cwd: string) => CmdResult;

export interface RunEvent {
  kind: "step" | "info" | "warn";
  text: string;
}

export interface RunInput {
  root: string;
  issue: number;
  title: string;
  body: string;
  /** True when the text came from a GitHub issue (adds `Closes #N` to the PR). */
  fromGitHub: boolean;
  af: Af;
  sh: Sh;
  spawner: Spawner;
  log: (e: RunEvent) => void;
  /** Push the branch and open a pull request. Off: stop with the work ready in its worktree. */
  pr: boolean;
  timeoutSec: number;
  /** The test commands QA runs, `;`-separated, or "none". */
  commands: string;
  /** Honor pipeline.auto_merge_low_risk after opening the PR. Explicit opt-in from the CLI. */
  autoMerge?: boolean;
}

export type Outcome = "pr" | "ready" | "completed" | "needs_me" | "error";

export interface RunOutcome {
  status: Outcome;
  issue: number;
  round: number;
  /** For needs_me: `<category>: <brief>`. For error: what went wrong before anything ran. */
  reason?: string;
  category?: string;
  risk?: string;
  branch?: string;
  worktree?: string;
  pr?: string;
  artifacts: string;
  cost_usd?: number;
  unreported_runs?: number;
}

/** The order a round moves through; `publish` is recorded once QA has passed, so a later `run N --pr` skips straight to publishing. */
const PHASE_ORDER = ["implement", "review", "qa", "publish"];
const ROLE_PHASE: Record<Role, string> = { implementer: "implement", reviewer: "review", qa: "qa" };
const fileFor = (role: Role) => (role === "reviewer" ? "review" : role);
/** QA is told the commands inline up to this length; longer lists go in a file (a command line has a hard length limit on Windows). */
const INLINE_COMMANDS_MAX = 800;
const json = (s: string): any => JSON.parse(s);
const readJson = (p: string): any => JSON.parse(readFileSync(p, "utf-8"));
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
/** Keep issue data inside its wrapper even when it contains markup that looks like a closing tag. */
const xmlText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Text that goes into a command line: one line, bounded, so a long or multi-line message can't break the launch. */
const oneLine = (s: string, max = 1200) => s.replace(/\s+/g, " ").trim().slice(0, max);
const SESSION_ID = /^[A-Za-z0-9_-]{8,80}$/;
/** What `state update` records in `reason` begins with its category: `budget_exceeded: …`, `SPEC_ERROR: …`. */
const categoryOf = (reason: unknown, fallback: string) => {
  const m = /^([A-Za-z_]+):/.exec(String(reason ?? ""));
  return m ? m[1] : fallback;
};

class Stop extends Error {
  constructor(public outcome: RunOutcome) {
    super(outcome.reason ?? outcome.status);
  }
}

/** SHA-256 of a file's bytes, read in 1 MiB pieces so a large build output can't exhaust memory. */
function hashFile(path: string): string {
  const h = createHash("sha256");
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return "missing";
  }
  if (st.isSymbolicLink()) h.update("link:").update(readlinkSync(path, { encoding: "buffer" }));
  else if (st.isFile()) {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.allocUnsafe(1 << 20);
      for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) h.update(buf.subarray(0, n));
    } finally {
      closeSync(fd);
    }
  } else h.update(`special:${st.mode}`); // a directory (a nested repository) or a device: never read it
  return h.digest("hex");
}

const heldLocks = new Map<string, () => void>();
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
};
/** A running `run` refreshes its lock this often. */
const LOCK_BEAT_MS = 30_000;
/**
 * A lock nobody has refreshed for this long belongs to a process that is gone, even if its pid has since been reused.
 * Far longer than the refresh interval, because the blocking git and gate calls between refreshes can take a while.
 */
const LOCK_STALE_MS = 6 * 3600_000;
const LINK_UNSUPPORTED = new Set(["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EINVAL"]);

/**
 * Delete `path` only if it still holds exactly `expected`: a lock judged stale may have been taken over by another
 * process a moment ago, and that new lock must not be deleted. Returns whether it was removed.
 */
export function removeIfUnchanged(path: string, expected: string): boolean {
  try {
    if (readFileSync(path, "utf-8") !== expected) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

const lockOwner = (path: string): number | null => {
  try {
    const pid = JSON.parse(readFileSync(path, "utf-8")).pid;
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
};

/**
 * One `run` per issue at a time: two would race on the worktree, the state file and the report files.
 * The lock file is created already holding its content (written to a temp file, then hard-linked into place), so a
 * second process can never see it half-written and mistake it for a leftover. A lock whose process is gone, or that
 * has not been refreshed for hours, is taken over. Returns a release function, or who holds it.
 */
export function acquireRunLock(dir: string, now = Date.now()): { release: () => void } | { heldBy: number; path: string } {
  const path = join(dir, "run.lock");
  const content = () => JSON.stringify({ pid: process.pid, at: Date.now() });
  const create = (): boolean => {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, content());
    try {
      linkSync(tmp, path);
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (code === "EEXIST") return false;
      if (!LINK_UNSUPPORTED.has(code)) throw e;
      // A filesystem without hard links (some removable drives): fall back to exclusive create.
      try {
        const fd = openSync(path, "wx");
        try {
          writeSync(fd, content());
        } finally {
          closeSync(fd);
        }
        return true;
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw e2;
      }
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* nothing to clean */
      }
    }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (create()) {
      const beat = setInterval(() => {
        // Refresh only a lock that is still ours; if it was taken over, stop (never overwrite the new holder's).
        if (lockOwner(path) !== process.pid) {
          clearInterval(beat);
          return;
        }
        const tmp = `${path}.${process.pid}.beat`;
        try {
          writeFileSync(tmp, content());
          renameSync(tmp, path);
        } catch {
          try {
            unlinkSync(tmp);
          } catch {
            /* skip this beat */
          }
        }
      }, LOCK_BEAT_MS);
      beat.unref();
      const release = () => {
        clearInterval(beat);
        heldLocks.delete(path);
        if (lockOwner(path) === process.pid) {
          try {
            unlinkSync(path);
          } catch {
            /* already gone */
          }
        }
      };
      heldLocks.set(path, release);
      return { release };
    }
    let raw = "";
    let held: { pid?: number; at?: number } = {};
    try {
      raw = readFileSync(path, "utf-8");
      held = JSON.parse(raw);
    } catch {
      /* unreadable or not ours: judged stale below */
    }
    const live = Number.isInteger(held.pid) && (held.pid as number) > 0 && pidAlive(held.pid as number) && typeof held.at === "number" && now - held.at < LOCK_STALE_MS;
    if (live) return { heldBy: held.pid as number, path };
    removeIfUnchanged(path, raw);
  }
  return { heldBy: 0, path };
}

/** Drop every lock this process holds. Called when a run is interrupted, where `finally` blocks don't run. */
export function releaseHeldLocks(): void {
  for (const release of [...heldLocks.values()]) release();
}

/**
 * The report that ended round `r`, for the Implementer of round r+1 to act on. A later stage only runs when the earlier
 * ones passed, so at most one of these fails per round; checked from the last stage back.
 */
export function findingsFor(dir: string, r: number): string {
  const read = (name: string): any => {
    try {
      return JSON.parse(readFileSync(join(dir, name), "utf-8"));
    } catch {
      return null;
    }
  };
  const qa = read(`qa-r${r}.json`);
  if (qa && qa.status === "failed") return join(dir, `qa-r${r}.json`);
  const gates = read(`gates-r${r}.json`);
  if (gates && gates.ok === false) return join(dir, `gates-r${r}.json`);
  const review = read(`review-r${r}.json`);
  if (review && review.status === "request_changes") return join(dir, `review-r${r}.json`);
  for (const name of [`dirty-r${r}.json`, `policy-r${r}.json`]) if (existsSync(join(dir, name))) return join(dir, name);
  return "none";
}

/**
 * The tool lists per role. Windows offers Claude a separate `PowerShell` tool beside `Bash`: if only Bash is allowed, the
 * model's first instinct (`cd <worktree>; git status` in PowerShell) is denied and a turn is wasted; and a Reviewer whose
 * deny-list names only Bash would still have a shell. The guard hook judges PowerShell writes like Bash ones.
 */
/** `dirs` are the issue folder and the worktree. A role that `cd`s into its worktree would otherwise lose permission to read the issue and packet in it (Claude Code scopes tool access to its working directory). */
export function claudeArgs(role: Role, p: { prompt: string; model?: string; dirs?: string[] }): string[] {
  const base = ["claude", "-p", ...(p.model ? ["--model", p.model] : []), ...(p.dirs?.length ? ["--add-dir", ...p.dirs] : [])];
  if (role === "implementer") return [...base, "--permission-mode", "acceptEdits", "--allowedTools", "Bash,PowerShell,Skill", "--output-format", "json", p.prompt];
  if (role === "reviewer") return [...base, "--permission-mode", "plan", "--disallowedTools", "Write,Edit,MultiEdit,NotebookEdit,Bash,PowerShell,Skill", "--output-format", "json", p.prompt];
  return [...base, "--allowedTools", "Bash,PowerShell,Skill", "--output-format", "json", p.prompt];
}

/** The same command resumed in the same Claude session, asked to fix its report; without a session, the prompt gets the sentence appended. */
export function retryArgs(argv: string[], sessionId: string | undefined, problems: string[]): string[] {
  const sentence = `Your report was rejected by the validator: ${oneLine(problems.join("; "))}. Print only the corrected JSON report.`;
  const out = [...argv];
  // The id comes from the harness's own output and lands on a command line: only a plain token is used.
  if (sessionId && SESSION_ID.test(sessionId)) {
    out.splice(2, 0, "--resume", sessionId);
    out[out.length - 1] = sentence;
  } else out[out.length - 1] = `${out[out.length - 1]}\n\n${sentence}`;
  return out;
}

export async function runIssue(i: RunInput): Promise<RunOutcome> {
  const { root, issue: N, af, sh, log } = i;
  const A = join(root, ".agent-flow", "artifacts", `issue-${N}`);
  const WT = join(root, ".worktrees", `issue-${N}`);
  const branch = `agent/issue-${N}`;
  mkdirSync(A, { recursive: true });
  let round = 0;
  let risk: string | undefined;
  const done = (o: Partial<RunOutcome> & { status: Outcome }): RunOutcome => {
    const c = issueCost(root, N);
    return { issue: N, round, artifacts: A, branch, worktree: WT, risk, cost_usd: c.total, unreported_runs: c.unreported_runs, ...o };
  };
  const afJson = (args: string[]): any => {
    const r = af([...args, "--json"]);
    try {
      return json(r.stdout);
    } catch {
      throw new Stop(done({ status: "error", reason: `agent-flow ${args.slice(0, 2).join(" ")} gave no usable answer (exit ${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 300)}` }));
    }
  };
  const updatePhase = (phase: string, roundNumber: number): void => {
    const u = af(["state", "update", "--issue", String(N), "--state", "Working", "--phase", phase, "--round", String(roundNumber), "--json"]);
    if (u.status === 3) {
      // The state machine says which cap it was (rounds or budget) in the reason it recorded.
      const current = afJson(["state", "show", "--issue", String(N)]);
      throw new Stop(done({ status: "needs_me", category: categoryOf(current.reason, "max_rounds_exceeded"), reason: current.reason ?? "max_rounds_exceeded: the review-round cap was reached" }));
    }
    if (u.status !== 0) throw new Stop(done({ status: "error", reason: `could not record phase ${phase}: ${(u.stderr || u.stdout).trim().slice(0, 300)}` }));
  };
  const escalate = (category: string, brief: string): never => {
    const reason = `${category}: ${brief}`.slice(0, 900);
    const u = af(["state", "update", "--issue", String(N), "--state", "Needs Me", "--reason", reason]);
    if (u.status !== 0) throw new Stop(done({ status: "error", reason: `could not save the escalation (${u.status}): ${(u.stderr || u.stdout).trim().slice(0, 300)}` }));
    throw new Stop(done({ status: "needs_me", category, reason }));
  };
  const cfg = (key: string): string => {
    const r = af(["config", "get", key]);
    return r.status === 0 ? r.stdout.trim() : "";
  };

  const lock = acquireRunLock(A);
  if ("heldBy" in lock) {
    return done({ status: "error", reason: `another \`agent-flow run\` for issue #${N} is already working on it${lock.heldBy ? ` (process ${lock.heldBy})` : ""}. Wait for it, or stop it, then run again. If you are sure nothing is running, delete ${lock.path}.` });
  }
  try {
    // ---- Step 0: prepare ---------------------------------------------------------------
    log({ kind: "step", text: `issue #${N}: ${i.title}` });
    const st = afJson(["state", "show", "--issue", String(N)]);
    if (st.state === "Completed") throw new Stop(done({ status: "completed", reason: st.reason ?? "already completed" }));
    if (st.state === "Needs Me") throw new Stop(done({ status: "needs_me", reason: st.reason ?? "waiting on a decision", category: categoryOf(st.reason, "needs_me") }));
    const LIMIT = Number(st.max_review_rounds ?? 2);
    if (!(LIMIT >= 1)) throw new Stop(done({ status: "error", reason: "pipeline.max_review_rounds is below 1; set it to at least 1 in CONTEXT_MANIFEST.json" }));
    const resuming = st.state === "Working";
    const storedPhase = st.phase;
    if (resuming && (typeof storedPhase !== "string" || !PHASE_ORDER.includes(storedPhase))) {
      throw new Stop(done({ status: "error", reason: `saved phase ${JSON.stringify(storedPhase)} is not valid; expected ${PHASE_ORDER.join(", ")}. Inspect AGENT_STATE.md and repair the session before resuming.` }));
    }
    let R = resuming ? Math.max(1, Number(st.round) || 1) : 1;
    if (resuming) log({ kind: "info", text: `resuming at round ${R}, ${storedPhase}` });
    /**
     * How far the saved round got. A report is trusted only if its role finished before that phase: a person who sends
     * an escalated issue back to `implement` gets every role run again, not a stale (or rejected) result replayed.
     */
    const phaseReached = (rr: number): number => (resuming && rr === Number(st.round) ? PHASE_ORDER.indexOf(storedPhase) : 0);

    const wt = afJson(["worktree", "create", String(N)]);
    if (wt.error && wt.error !== "worktree_exists") throw new Stop(done({ status: "error", reason: `worktree: ${wt.error}` }));
    const recordedBase = sh("git", ["config", "--get", `branch.${branch}.agentflowbase`], root).stdout.trim();
    const BASE: string = wt.base ?? (recordedBase || cfg("default_branch") || "main");
    // The task text is rewritten whenever the caller supplies it. Resuming by number supplies none, so the saved text stands;
    // without this rule a second, different task could inherit the files of an earlier attempt that never registered.
    if (i.body || !existsSync(join(A, "issue.md"))) {
      writeFileSync(join(A, "issue.md"), `<untrusted_issue number="${N}">\n# ${xmlText(i.title)}\n\n${xmlText(i.body)}\n</untrusted_issue>\n`);
      writeFileSync(join(A, "title.txt"), `${i.title.replace(/\r?\n.*/s, "")}\n`);
    }
    if (i.fromGitHub) writeFileSync(join(A, "from-github"), "1\n");
    const FAST = cfg("pipeline.models.fast");
    const HIGH = cfg("pipeline.models.high_reasoning");
    const gatesDefined = (afJson(["gates", "list"]).gates ?? []).length > 0;
    let findings = R > 1 ? findingsFor(A, R - 1) : "none";
    /**
     * Lines `git status` showed that the Implementer is not to blame for: what gates and QA wrote (coverage, build output)
     * when a round ended. Refreshed after them each round. Resuming at or after review means the Implementer's work was
     * already checked, so whatever is dirty now is generated; resuming at implement starts with none, so a crashed
     * Implementer's uncommitted files are still sent back to be committed.
     */
    const statusLines = (): Set<string> => new Set(sh("git", ["-C", WT, "status", "--porcelain"], root).stdout.split("\n").filter(Boolean));
    let dirtyBaseline: Set<string> = resuming && phaseReached(R) >= 1 ? statusLines() : new Set();

    // ---- Step 1: the round loop --------------------------------------------------------
    for (;;) {
      round = R;
      const phaseNow = phaseReached(R);
      const at = (p: string) => PHASE_ORDER.indexOf(p) >= phaseNow;
      const roundTag = `round ${R}${LIMIT ? ` of ${LIMIT}` : ""}`;

      // Files from an abandoned attempt at this round, for phases we are about to run again, are set aside: they must
      // neither be replayed nor outrank this attempt's own report when the next round looks for what went wrong.
      for (const [name, phaseIndex] of [["implementer", 0], ["dirty", 0], ["policy", 0], ["review", 1], ["gates", 2], ["qa", 2]] as const) {
        const stale = join(A, `${name}-r${R}.json`);
        if (phaseIndex >= phaseNow && existsSync(stale)) renameSync(stale, `${stale}.prev`);
      }

      // 1a. open the round (the state machine, not this loop, decides whether it may start)
      if (at("implement")) updatePhase("implement", R);

      // 1b. Implementer
      const impl = await runRole("implementer", R, { findings, model: R === LIMIT && HIGH ? HIGH : FAST, announce: `${roundTag}: implementing` });
      if (impl.status === "needs_me") {
        escalate(String(impl.category ?? "IMPL_ERROR"), `${impl.what_failed ?? "the Implementer stopped"}. Decide: ${impl.suggested_next_step ?? "how to proceed"}`);
      }

      // 1c. Work left uncommitted would be reviewed and tested here but missing from the branch that gets pushed.
      const leftover = [...statusLines()].filter((l) => !dirtyBaseline.has(l));
      if (leftover.length) {
        log({ kind: "warn", text: `the Implementer left ${leftover.length} uncommitted change(s)` });
        writeFileSync(join(A, `dirty-r${R}.json`), `${JSON.stringify({ problem: "Uncommitted changes in the worktree. Commit the work (the pipeline reviews and publishes commits only).", files: leftover.slice(0, 50) }, null, 2)}\n`);
        findings = join(A, `dirty-r${R}.json`);
        R = nextRound(R);
        continue;
      }

      // 1d. classify (mechanical, and authoritative)
      const cls = afJson(["classify", "--issue", String(N)]);
      writeFileSync(join(A, "classification.json"), `${JSON.stringify(cls, null, 2)}\n`);
      const diff = sh("git", ["-C", WT, "diff", `${cls.base ?? BASE}...HEAD`], root);
      writeFileSync(join(A, "diff.patch"), diff.stdout);
      risk = cls.risk_level;
      log({ kind: "info", text: `risk ${cls.risk_level}, ${(cls.files ?? []).length} file(s) changed` });
      if (!(cls.files ?? []).length) {
        escalate("no_changes", `the Implementer reported ready_for_review, but the branch has no changes against ${cls.base ?? BASE}. Decide: whether this task needs no change, or restate it with clearer criteria.`);
      }
      if ((cls.protected_violations ?? []).length) {
        escalate("protected_path", `protected path modified: ${cls.protected_violations.join(", ")}. Decide: whether a human makes this change.`);
      }
      if ((cls.policy_violations ?? []).length) {
        const msgs = cls.policy_violations.map((v: any) => v.message ?? String(v));
        log({ kind: "warn", text: `policy: ${msgs.join("; ")}` });
        writeFileSync(join(A, `policy-r${R}.json`), `${JSON.stringify({ policy_violations: msgs }, null, 2)}\n`);
        findings = join(A, `policy-r${R}.json`);
        dirtyBaseline = statusLines();
        R = nextRound(R);
        continue;
      }

      // 1d. Reviewer
      if (at("review")) updatePhase("review", R);
      const rev = await runRole("reviewer", R, {
        model: cls.reviewer_tier === "high-reasoning" ? HIGH || FAST : FAST,
        limit: LIMIT,
        announce: `${roundTag}: reviewing (${cls.reviewer_tier})`,
        warn: cls.reviewer_tier === "high-reasoning" && !HIGH ? "this change is critical, but pipeline.models.high_reasoning is not set, so the review runs on the same model as everything else" : undefined,
      });
      const f: any[] = Array.isArray(rev.findings) ? rev.findings : [];
      if ((rev.permission_violations ?? []).length) escalate("permission_violation", `the Reviewer reported: ${rev.permission_violations.join("; ")}. Decide: whether a role overstepped.`);
      if (f.some((x) => x.category === "SPEC_ERROR")) escalate("SPEC_ERROR", `${f.find((x) => x.category === "SPEC_ERROR").issue}. Decide: clarify the acceptance criteria.`);
      if (f.some((x) => x.category === "ARCH_ERROR")) escalate("ARCH_ERROR", `${f.find((x) => x.category === "ARCH_ERROR").issue}. Decide: the design question.`);
      const disputes: any[] = Array.isArray(impl.disputes) ? impl.disputes : [];
      const withdrawn: string[] = (rev.withdrawn ?? []).map(norm);
      for (const d of disputes) {
        const again = f.find((x) => {
          const a = norm(String(x.issue ?? ""));
          const b = norm(String(d.finding ?? ""));
          return a.length > 11 && b.length > 11 && (a.includes(b) || b.includes(a)) && !withdrawn.some((w) => w && (a.includes(w) || w.includes(a)));
        });
        if (again) escalate("disputed_finding", `the Implementer disputed "${d.finding}" (${d.evidence}) and the Reviewer raised it again: "${again.issue}". Decide: who is right.`);
      }
      if (rev.status === "request_changes") {
        findings = join(A, `review-r${R}.json`);
        dirtyBaseline = statusLines();
        log({ kind: "warn", text: `review asked for changes (${f.length} finding${f.length === 1 ? "" : "s"})` });
        R = nextRound(R);
        continue;
      }

      // 1e. gates, then QA
      // Reaching the qa phase means the gates already passed this round; the binding at completion re-checks that
      // they were run on the commit being published, so a resume does not pay for them a second time.
      if (gatesDefined && phaseNow < 2) {
        log({ kind: "step", text: `${roundTag}: running gates` });
        const g = af(["gates", "run", "--issue", String(N), "--json"]);
        writeFileSync(join(A, `gates-r${R}.json`), g.stdout);
        if (g.status === 2) escalate("qa_environment", "a gate could not start (a missing tool or a bad path). Decide: fix the environment, then resume.");
        if (g.status === 1) {
          findings = join(A, `gates-r${R}.json`);
          dirtyBaseline = statusLines();
          log({ kind: "warn", text: "a required gate failed" });
          R = nextRound(R);
          continue;
        }
      }
      if (at("qa")) updatePhase("qa", R);
      const pre = snapshot();
      const qa = await runRole("qa", R, { model: FAST, announce: `${roundTag}: QA` });
      if (snapshot() !== pre) escalate("qa_mutated_tree", "QA changed the files it was testing, so its result is invalid. Decide: re-run QA.");
      if (qa.status === "failed" && !qa.reason) {
        findings = join(A, `qa-r${R}.json`);
        dirtyBaseline = statusLines();
        log({ kind: "warn", text: "QA found failures" });
        R = nextRound(R);
        continue;
      }
      if (qa.status === "failed") escalate("qa_environment", `QA could not run the checks: ${qa.reason}. Decide: fix the environment, then resume.`);

      // ---- Step 2: PR ------------------------------------------------------------------
      if (at("publish")) updatePhase("publish", R);
      return await finish(rev, qa, cls, LIMIT);

      /**
       * A fingerprint of everything QA could have changed: the commit, which blobs are staged, what git reports as
       * changed, and the bytes of every modified or untracked file (streamed, never held whole). Compared before and after QA.
       */
      function snapshot(): string {
        const git = (...a: string[]) => sh("git", ["-C", WT, ...a], root).stdout;
        const names = [...new Set(git("ls-files", "-m", "-o", "--exclude-standard", "-z").split("\0").filter(Boolean))].sort();
        const parts = [
          git("rev-parse", "HEAD").trim(),
          createHash("sha256").update(git("ls-files", "-s", "-z")).digest("hex"),
          git("status", "--porcelain", "-z", "--untracked-files=all"),
          names.map((name) => [name, hashFile(join(WT, name))]),
        ];
        return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
      }
    }

    function nextRound(r: number): number {
      return r + 1;
    }

    // ---- role launch + validation ------------------------------------------------------
    async function runRole(role: Role, rr: number, o: { findings?: string; model?: string; limit?: number; announce?: string; warn?: string }): Promise<any> {
      const stem = join(A, `${fileFor(role)}-r${rr}`);
      if (existsSync(`${stem}.json`) && PHASE_ORDER.indexOf(ROLE_PHASE[role]) < phaseReached(rr)) {
        log({ kind: "info", text: `${role}: using the report from the earlier run` });
        try {
          return readJson(`${stem}.json`);
        } catch {
          log({ kind: "warn", text: `${role}: the saved report is unreadable; running it again` });
        }
      }
      if (o.announce) log({ kind: "step", text: o.announce });
      if (o.warn) log({ kind: "warn", text: o.warn });
      let commands = i.commands;
      if (commands.length > INLINE_COMMANDS_MAX || /[%"\r\n]/.test(commands)) {
        writeFileSync(join(A, "commands.txt"), `${commands}\n`);
        commands = `listed, one per line separated by ";", in ${join(A, "commands.txt")}`;
      }
      const prompts: Record<Role, string> = {
        implementer: `Use the implementer skill. Round ${rr}. Issue: ${A}/issue.md. Worktree: ${WT} (cd into it first). Findings to address: ${o.findings ?? "none"}`,
        reviewer: `Round ${rr} of ${o.limit}. Read .claude/skills/reviewer/SKILL.md and follow it. Packet: ${A}/ (issue.md, diff.patch, classification.json, implementer-r${rr}.json, and review-r${rr - 1}.json if it exists). Worktree for reading context: ${WT}`,
        qa: `Use the qa skill. Issue ${N}. Worktree: ${WT} (cd into it first). Commands: ${commands}`,
      };
      const env: Record<string, string> = { AGENT_FLOW_ROLE: role };
      if (role === "implementer") env.AGENT_FLOW_WORKTREE = WT;
      let argv = claudeArgs(role, { prompt: prompts[role], model: o.model, dirs: [A, WT] });
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await i.spawner({ argv, env, cwd: root, base: stem, timeoutSec: i.timeoutSec });
        const rep = af([
          "report", role, `${stem}.raw`, "--out", `${stem}.json`, "--json", "--harness", "claude", ...(o.model ? ["--model", o.model] : []),
          "--issue", String(N), "--round", String(rr), "--exit", String(res.exit), "--seconds", String(res.seconds), "--argv-file", `${stem}.argv`,
        ]);
        let chk: any = {};
        try {
          chk = json(rep.stdout);
        } catch {
          chk = { ok: false, problems: [(rep.stderr || rep.stdout || "no report output").trim().slice(0, 300)] };
        }
        if (res.exit === 124) escalate("role_timeout", `the ${role} ran out of time (${i.timeoutSec}s) in round ${rr}. Decide: raise the limit or split the issue.`);
        if (res.exit === 127) escalate("role_failed", `could not start \`claude\` for the ${role}. Decide: install it or fix PATH.`);
        const problems: string[] = chk.problems ?? [];
        if (problems.some((p) => p.startsWith("harness error:"))) escalate("role_failed", `${role}: ${problems.find((p) => p.startsWith("harness error:"))}`);
        if (chk.ok) return readJson(`${stem}.json`);
        if (attempt === 1) escalate("malformed_report", `the ${role}'s report was invalid twice: ${problems.slice(0, 3).join("; ")}.`);
        log({ kind: "warn", text: `${role} report invalid (${problems[0] ?? "unknown"}); asking once to correct it` });
        argv = retryArgs(argv, chk.harness?.session_id, problems);
      }
      throw new Error("unreachable");
    }

    // ---- PR ---------------------------------------------------------------------------
    async function finish(rev: any, qa: any, cls: any, LIMIT: number): Promise<RunOutcome> {
      if (!i.pr) {
        log({ kind: "info", text: `ready on ${branch} (worktree .worktrees/issue-${N}); not pushed` });
        return done({ status: "ready", reason: "reviewed, gated and tested; nothing was pushed" });
      }
      const flaky: any[] = qa.flaky ?? [];
      const stale: any[] = rev.context_stale_flags ?? [];
      const body = [
        i.fromGitHub || existsSync(join(A, "from-github")) ? `Closes #${N}` : `Agent-flow run #${N}`,
        "",
        `**Risk:** ${cls.risk_level} (${(cls.reasons ?? []).slice(0, 5).join("; ")})`,
        `**Review:** ${rev.status}: ${rev.summary ?? ""}`,
        `**QA:** ${qa.status}${flaky.length ? ` (flaky: ${flaky.map((x: any) => x.test ?? x.name ?? JSON.stringify(x)).join(", ")})` : ""}`,
        ...(stale.length ? ["", "**Context may be stale:**", ...stale.map((s: any) => `- ${s.file}: ${s.claim} → ${s.reality}`)] : []),
        "",
        "🤖 Opened by `agent-flow run`",
      ].join("\n");
      writeFileSync(join(A, "pr.md"), body);
      log({ kind: "step", text: `pushing ${branch}` });
      const push = sh("git", ["-C", WT, "push", "-u", "origin", branch], root);
      if (push.status !== 0) escalate("push_failed", `${(push.stderr || push.stdout).trim().slice(0, 300)}. The branch is kept locally. Decide: fix the remote or auth, then resume.`);
      let pr = sh("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url"], root);
      let url = "";
      try {
        url = json(pr.stdout)[0]?.url ?? "";
      } catch {
        /* none */
      }
      if (!url) {
        const title = `${readFileSync(join(A, "title.txt"), "utf-8").split("\n")[0]} (#${N})`;
        // classify may name the base as `origin/main`; a pull request needs the branch name.
        const prBase = (cls.base ?? BASE).replace(/^origin\//, "");
        const created = sh("gh", ["pr", "create", "--base", prBase, "--head", branch, "--title", title, "--body-file", join(A, "pr.md"), ...(cls.risk_level === "critical" ? ["--draft"] : [])], root);
        if (created.status !== 0) escalate("push_failed", `could not open the pull request: ${(created.stderr || created.stdout).trim().slice(0, 300)}`);
        url = created.stdout.trim().split("\n").pop() ?? "";
      }
      log({ kind: "info", text: `pull request: ${url}` });
      if (cls.human_approval_required) {
        const saved = af(["state", "update", "--issue", String(N), "--state", "Needs Me", "--reason", `critical_change_needs_human: critical change, human review required on ${url}`]);
        if (saved.status !== 0) throw new Stop(done({ status: "error", reason: `critical PR opened at ${url}, but its human-review state could not be saved: ${(saved.stderr || saved.stdout).trim().slice(0, 300)}`, pr: url }));
        return done({ status: "needs_me", category: "critical_change_needs_human", reason: `critical_change_needs_human: critical change, human review required on ${url}`, pr: url });
      }
      const c = af(["state", "update", "--issue", String(N), "--state", "Completed", "--reason", `PR ${url}`, "--json"]);
      if (c.status === 3) {
        const s3 = afJson(["state", "show", "--issue", String(N)]);
        return done({ status: "needs_me", category: "unreviewed_commits", reason: s3.reason ?? "unreviewed_commits", pr: url });
      }
      if (c.status !== 0) throw new Stop(done({ status: "error", reason: `PR opened at ${url}, but completion could not be recorded: ${(c.stderr || c.stdout).trim().slice(0, 300)}`, pr: url }));
      if (i.autoMerge === true && cfg("pipeline.auto_merge_low_risk") === "true" && cls.risk_level === "low" && qa.status !== "failed") {
        const m = sh("gh", ["pr", "merge", url, "--auto", "--squash"], root);
        log({ kind: m.status === 0 ? "info" : "warn", text: m.status === 0 ? "auto-merge enabled (waits for CI)" : `auto-merge not enabled: ${(m.stderr || m.stdout).trim().slice(0, 200)}` });
      }
      const removed = af(["worktree", "remove", String(N)]);
      if (removed.status !== 0) log({ kind: "warn", text: `PR is open; worktree cleanup failed: ${(removed.stderr || removed.stdout).trim().slice(0, 200)}` });
      return done({ status: "pr", pr: url });
    }
  } catch (e) {
    if (e instanceof Stop) return e.outcome;
    return done({ status: "error", reason: e instanceof Error ? e.message : String(e) });
  } finally {
    lock.release();
  }
  return done({ status: "error", reason: "the run ended without a result" });
}

/**
 * Does this task say how to tell it is done? The skill escalates (SPEC_ERROR) rather than let the Implementer guess,
 * and a heuristic is all code can offer: an explicit criteria cue, a checklist or list of at least two items, or a
 * sentence with a verifiable "should/must/when/then". It is deliberately generous; the Reviewer judges the real thing.
 */
export function hasCriteria(text: string): boolean {
  if (/acceptance|criteria|definition of done|done when|expected (result|behaviou?r)|so that/i.test(text)) return true;
  const items = text.split(/\r?\n/).filter((l) => /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)\S/.test(l));
  if (items.length >= 2) return true;
  return /\b(should|must|shall|returns?|prints?|fails?|passes?|exits?|raises?|throws?)\b/i.test(text) && text.trim().split(/\s+/).length >= 8;
}

/** Lowest unused number at or above 100000, the range inline (no GitHub issue) tasks use. */
export function nextInlineIssue(used: number[]): number {
  let n = 100000;
  const set = new Set(used);
  while (set.has(n)) n++;
  return n;
}
