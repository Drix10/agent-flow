/**
 * `agent-flow run`: the Orchestrator skill as code.
 *
 * One issue goes Implementer → classify → Reviewer → gates → QA → PR, each role a separate process, handing files to
 * the next. This module is only the loop. Every decision that matters (state transitions and the round cap, risk,
 * report validation, gates, the completion binding) is made by the same `agent-flow` subcommands the skill uses; they are
 * called through the injected `af`, so the two cannot drift and a test can run the whole loop against a fake agent.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  /** Honor pipeline.auto_merge_low_risk after opening the PR. Default true; false for trial runs. */
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

const PHASE_ORDER = ["implement", "review", "qa"];
const fileFor = (role: Role) => (role === "reviewer" ? "review" : role);
const json = (s: string): any => JSON.parse(s);
const readJson = (p: string): any => JSON.parse(readFileSync(p, "utf-8"));
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

class Stop extends Error {
  constructor(public outcome: RunOutcome) {
    super(outcome.reason ?? outcome.status);
  }
}

export function claudeArgs(role: Role, p: { prompt: string; model?: string }): string[] {
  const base = ["claude", "-p", ...(p.model ? ["--model", p.model] : [])];
  if (role === "implementer") return [...base, "--permission-mode", "acceptEdits", "--allowedTools", "Bash,Skill", "--output-format", "json", p.prompt];
  if (role === "reviewer") return [...base, "--permission-mode", "plan", "--disallowedTools", "Write,Edit,MultiEdit,NotebookEdit,Bash,Skill", "--output-format", "json", p.prompt];
  return [...base, "--allowedTools", "Bash,Skill", "--output-format", "json", p.prompt];
}

/** The same command resumed in the same Claude session, asked to fix its report; without a session, the prompt gets the sentence appended. */
export function retryArgs(argv: string[], sessionId: string | undefined, problems: string[]): string[] {
  const sentence = `Your report was rejected by the validator: ${problems.join("; ")}. Print only the corrected JSON report.`;
  const out = [...argv];
  if (sessionId) {
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
  const escalate = (category: string, brief: string): never => {
    const reason = `${category}: ${brief}`.slice(0, 900);
    af(["state", "update", "--issue", String(N), "--state", "Needs Me", "--reason", reason]);
    throw new Stop(done({ status: "needs_me", category, reason }));
  };
  const cfg = (key: string): string => {
    const r = af(["config", "get", key]);
    return r.status === 0 ? r.stdout.trim() : "";
  };

  try {
    // ---- Step 0: prepare ---------------------------------------------------------------
    log({ kind: "step", text: `issue #${N}: ${i.title}` });
    const st = afJson(["state", "show", "--issue", String(N)]);
    if (st.state === "Completed") throw new Stop(done({ status: "completed", reason: st.reason ?? "already completed" }));
    if (st.state === "Needs Me") throw new Stop(done({ status: "needs_me", reason: st.reason ?? "waiting on a decision", category: String(st.reason ?? "").split(":")[0] }));
    const LIMIT = Number(st.max_review_rounds ?? 2);
    if (!(LIMIT >= 1)) throw new Stop(done({ status: "error", reason: "pipeline.max_review_rounds is below 1; set it to at least 1 in CONTEXT_MANIFEST.json" }));
    const resuming = st.state === "Working";
    const storedPhase = typeof st.phase === "string" ? st.phase : "implement";
    let R = resuming ? Math.max(1, Number(st.round) || 1) : 1;
    if (resuming) log({ kind: "info", text: `resuming at round ${R}, ${storedPhase}` });

    const wt = afJson(["worktree", "create", String(N)]);
    if (wt.error && wt.error !== "worktree_exists") throw new Stop(done({ status: "error", reason: `worktree: ${wt.error}` }));
    const BASE: string = wt.base ?? (cfg("default_branch") || "main");
    if (!existsSync(join(A, "issue.md"))) {
      writeFileSync(join(A, "issue.md"), `<untrusted_issue number="${N}">\n# ${i.title}\n\n${i.body}\n</untrusted_issue>\n`);
      writeFileSync(join(A, "title.txt"), `${i.title.replace(/\r?\n.*/s, "")}\n`);
    }
    const FAST = cfg("pipeline.models.fast");
    const HIGH = cfg("pipeline.models.high_reasoning");
    const gatesDefined = (afJson(["gates", "list"]).gates ?? []).length > 0;
    let findings = "none";

    // ---- Step 1: the round loop --------------------------------------------------------
    for (;;) {
      round = R;
      const phaseNow = resuming && R === Number(st.round) ? PHASE_ORDER.indexOf(storedPhase) : 0;
      const at = (p: string) => PHASE_ORDER.indexOf(p) >= phaseNow;
      const roundTag = `round ${R}${LIMIT ? ` of ${LIMIT}` : ""}`;

      // 1a. open the round (the state machine, not this loop, decides whether it may start)
      if (at("implement")) {
        const u = af(["state", "update", "--issue", String(N), "--state", "Working", "--phase", "implement", "--round", String(R), "--json"]);
        if (u.status === 3) {
          const s2 = afJson(["state", "show", "--issue", String(N)]);
          throw new Stop(done({ status: "needs_me", category: "max_rounds_exceeded", reason: s2.reason ?? "max_rounds_exceeded: the review-round cap was reached" }));
        }
        if (u.status !== 0) throw new Stop(done({ status: "error", reason: `state update refused: ${(u.stderr || u.stdout).trim().slice(0, 300)}` }));
      }

      // 1b. Implementer
      log({ kind: "step", text: `${roundTag}: implementing` });
      const impl = await runRole("implementer", R, { findings, model: R === LIMIT && HIGH ? HIGH : FAST });
      if (impl.status === "needs_me") {
        escalate(String(impl.category ?? "IMPL_ERROR"), `${impl.what_failed ?? "the Implementer stopped"}. Decide: ${impl.suggested_next_step ?? "how to proceed"}`);
      }

      // 1c. classify (mechanical, and authoritative)
      const cls = afJson(["classify", "--issue", String(N)]);
      writeFileSync(join(A, "classification.json"), `${JSON.stringify(cls, null, 2)}\n`);
      const diff = sh("git", ["-C", WT, "diff", `${cls.base ?? BASE}...HEAD`], root);
      writeFileSync(join(A, "diff.patch"), diff.stdout);
      risk = cls.risk_level;
      log({ kind: "info", text: `risk ${cls.risk_level}, ${(cls.files ?? []).length} file(s) changed` });
      if ((cls.protected_violations ?? []).length) {
        escalate("protected_path", `protected path modified: ${cls.protected_violations.join(", ")}. Decide: whether a human makes this change.`);
      }
      if ((cls.policy_violations ?? []).length) {
        const msgs = cls.policy_violations.map((v: any) => v.message ?? String(v));
        log({ kind: "warn", text: `policy: ${msgs.join("; ")}` });
        writeFileSync(join(A, `policy-r${R}.json`), `${JSON.stringify({ policy_violations: msgs }, null, 2)}\n`);
        findings = join(A, `policy-r${R}.json`);
        R = nextRound(R);
        continue;
      }

      // 1d. Reviewer
      if (at("review")) af(["state", "update", "--issue", String(N), "--state", "Working", "--phase", "review", "--round", String(R), "--json"]);
      log({ kind: "step", text: `${roundTag}: reviewing (${cls.reviewer_tier})` });
      const rev = await runRole("reviewer", R, { model: cls.reviewer_tier === "high-reasoning" ? HIGH || FAST : FAST, limit: LIMIT });
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
        log({ kind: "warn", text: `review asked for changes (${f.length} finding${f.length === 1 ? "" : "s"})` });
        R = nextRound(R);
        continue;
      }

      // 1e. gates, then QA
      if (gatesDefined) {
        log({ kind: "step", text: `${roundTag}: running gates` });
        const g = af(["gates", "run", "--issue", String(N), "--json"]);
        writeFileSync(join(A, `gates-r${R}.json`), g.stdout);
        if (g.status === 2) escalate("qa_environment", "a gate could not start (a missing tool or a bad path). Decide: fix the environment, then resume.");
        if (g.status === 1) {
          findings = join(A, `gates-r${R}.json`);
          log({ kind: "warn", text: "a required gate failed" });
          R = nextRound(R);
          continue;
        }
      }
      af(["state", "update", "--issue", String(N), "--state", "Working", "--phase", "qa", "--round", String(R), "--json"]);
      log({ kind: "step", text: `${roundTag}: QA` });
      const pre = snapshot();
      const qa = await runRole("qa", R, { model: FAST });
      if (snapshot() !== pre) escalate("qa_mutated_tree", "QA changed the files it was testing, so its result is invalid. Decide: re-run QA.");
      if (qa.status === "failed" && !qa.reason) {
        findings = join(A, `qa-r${R}.json`);
        log({ kind: "warn", text: "QA found failures" });
        R = nextRound(R);
        continue;
      }
      if (qa.status === "failed") escalate("qa_environment", `QA could not run the checks: ${qa.reason}. Decide: fix the environment, then resume.`);

      // ---- Step 2: PR ------------------------------------------------------------------
      return await finish(rev, qa, cls, LIMIT);

      function snapshot(): string {
        const s = sh("git", ["-C", WT, "status", "--porcelain"], root).stdout;
        const h = sh("git", ["-C", WT, "rev-parse", "HEAD"], root).stdout.trim();
        return `${h}\n${s}`;
      }
    }

    function nextRound(r: number): number {
      return r + 1;
    }

    // ---- role launch + validation ------------------------------------------------------
    async function runRole(role: Role, rr: number, o: { findings?: string; model?: string; limit?: number }): Promise<any> {
      const stem = join(A, `${fileFor(role)}-r${rr}`);
      if (existsSync(`${stem}.json`)) {
        log({ kind: "info", text: `${role}: using the report from the earlier run` });
        return readJson(`${stem}.json`);
      }
      const prompts: Record<Role, string> = {
        implementer: `Use the implementer skill. Round ${rr}. Issue: ${A}/issue.md. Worktree: ${WT} (cd into it first). Findings to address: ${o.findings ?? "none"}`,
        reviewer: `Round ${rr} of ${o.limit}. Read .claude/skills/reviewer/SKILL.md and follow it. Packet: ${A}/ (issue.md, diff.patch, classification.json, implementer-r${rr}.json, and review-r${rr - 1}.json if it exists). Worktree for reading context: ${WT}`,
        qa: `Use the qa skill. Issue ${N}. Worktree: ${WT} (cd into it first). Commands: ${i.commands}`,
      };
      const env: Record<string, string> = { AGENT_FLOW_ROLE: role };
      if (role === "implementer") env.AGENT_FLOW_WORKTREE = WT;
      let argv = claudeArgs(role, { prompt: prompts[role], model: o.model });
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
        i.fromGitHub ? `Closes #${N}` : `Agent-flow run #${N}`,
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
        const created = sh("gh", ["pr", "create", "--base", BASE, "--head", branch, "--title", title, "--body-file", join(A, "pr.md"), ...(cls.risk_level === "critical" ? ["--draft"] : [])], root);
        if (created.status !== 0) escalate("push_failed", `could not open the pull request: ${(created.stderr || created.stdout).trim().slice(0, 300)}`);
        url = created.stdout.trim().split("\n").pop() ?? "";
      }
      log({ kind: "info", text: `pull request: ${url}` });
      if (cls.human_approval_required) {
        af(["state", "update", "--issue", String(N), "--state", "Needs Me", "--reason", `critical_change_needs_human: critical change, human review required on ${url}`]);
        return done({ status: "needs_me", category: "critical_change_needs_human", reason: `critical_change_needs_human: critical change, human review required on ${url}`, pr: url });
      }
      const c = af(["state", "update", "--issue", String(N), "--state", "Completed", "--reason", `PR ${url}`, "--json"]);
      if (c.status === 3) {
        const s3 = afJson(["state", "show", "--issue", String(N)]);
        return done({ status: "needs_me", category: "unreviewed_commits", reason: s3.reason ?? "unreviewed_commits", pr: url });
      }
      if (i.autoMerge !== false && cfg("pipeline.auto_merge_low_risk") === "true" && cls.risk_level === "low" && qa.status !== "failed") {
        const m = sh("gh", ["pr", "merge", url, "--auto", "--squash"], root);
        log({ kind: m.status === 0 ? "info" : "warn", text: m.status === 0 ? "auto-merge enabled (waits for CI)" : `auto-merge not enabled: ${(m.stderr || m.stdout).trim().slice(0, 200)}` });
      }
      af(["worktree", "remove", String(N)]);
      return done({ status: "pr", pr: url });
    }
  } catch (e) {
    if (e instanceof Stop) return e.outcome;
    return done({ status: "error", reason: e instanceof Error ? e.message : String(e) });
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
