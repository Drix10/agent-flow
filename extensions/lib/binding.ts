/**
 * Verdict binding: a review, a gate run and a QA run only count for the commit they judged.
 *
 * `report --harness` and `gates run --issue` record the tip of agent/issue-N in their audit lines. Before an
 * issue may become `Completed`, the latest review, QA and required-gate results for the current round must all
 * name the tip that is about to be pushed. A commit made after the approval (a resumed run, a manual fix in the
 * worktree, an orchestrator slip) therefore can't ship under an "approved" record it never had.
 *
 * Enforced only for issues whose audit lines carry a `head` (runs made with this version onward): older runs
 * have nothing to compare, and the pipeline that skips `report --harness` is FM-18, not something this can see.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultBase, defaultBranch, git } from "./git.js";
import { branchFor } from "./worktree.js";
import { AUDIT_LOG } from "./state.js";
import type { GateSpec } from "./gates.js";

/** The commit at the tip of agent/issue-N, or null when the branch doesn't exist. */
export function branchTip(root: string, issue: number | undefined): string | null {
  if (!issue) return null;
  const r = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branchFor(issue)}`], root, 10_000);
  return r.ok && /^[0-9a-f]{40,64}$/.test(r.stdout) ? r.stdout : null;
}

/**
 * The default-branch ref that holds commit `head`'s change, or null. Either `head` is an ancestor (a merge or
 * fast-forward), or a commit there has the same patch as `head` against its merge-base (a squash merge, which is
 * what `run --pr --auto-merge` asks for). A rebase that changed the patch proves nothing and returns null.
 */
export function mergedInto(root: string, head: string): string | null {
  if (!/^[0-9a-f]{40,64}$/.test(head) || !git(["cat-file", "-e", `${head}^{commit}`], root, 10_000).ok) return null;
  const branch = (() => {
    try {
      return defaultBranch(root);
    } catch {
      return "main";
    }
  })();
  const refs = [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`].filter((r) => git(["rev-parse", "--verify", "--quiet", `${r}^{commit}`], root, 10_000).ok);
  for (const ref of refs) {
    if (git(["merge-base", "--is-ancestor", head, ref], root, 10_000).ok) return ref;
  }
  for (const ref of refs) {
    const base = git(["merge-base", head, ref], root, 10_000);
    if (!base.ok || !base.stdout) continue;
    const [want] = patchIds(root, ["diff", "--no-color", "--full-index", "--binary", base.stdout, head]);
    if (!want) continue;
    // One pass over the commits merged since: `git log -p` piped through patch-id gives "<patch-id> <commit>" per commit.
    if (patchIds(root, ["log", "-p", "--no-merges", "--no-color", "--full-index", "--binary", "--max-count=500", `${base.stdout}..${ref}`]).includes(want)) return ref;
  }
  return null;
}

/** The stable patch-ids of the patches `git <args>` prints. */
function patchIds(root: string, args: string[]): string[] {
  const d = git(args, root, 60_000);
  if (!d.ok || !d.stdout.trim()) return [];
  const r = spawnSync("git", ["patch-id", "--stable"], { cwd: root, input: `${d.stdout}\n`, encoding: "utf-8", timeout: 60_000, maxBuffer: 50 * 1024 * 1024 });
  return r.status === 0 ? r.stdout.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean) : [];
}

interface AuditLine {
  event?: string;
  issue?: number;
  role?: string;
  round?: number;
  ok?: boolean;
  verdict?: string;
  gate?: string;
  head?: string | null;
}

function readAudit(root: string): AuditLine[] {
  const path = join(root, AUDIT_LOG);
  if (!existsSync(path)) return [];
  const out: AuditLine[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn line is `audit verify`'s business */
    }
  }
  return out;
}

export interface BindingResult {
  /** false when there is nothing to compare (no bound runs): the caller does not enforce. */
  enforced: boolean;
  ok: boolean;
  problems: string[];
  tip: string | null;
}

/** Can issue N be marked Completed at `round`? `gates` are the trusted manifest's gates. */
export function checkBinding(root: string, issue: number, round: number, gates: GateSpec[]): BindingResult {
  const lines = readAudit(root).filter((l) => l.issue === issue);
  // A `head` key (even null: the branch did not exist yet) marks a run made with binding in mind.
  const bound = lines.some((l) => (l.event === "role_run" || l.event === "gate_run") && "head" in l);
  if (!bound) return { enforced: false, ok: true, problems: [], tip: null };

  const latest = (pred: (l: AuditLine) => boolean) => [...lines].reverse().find(pred);
  const review = latest((l) => l.event === "role_run" && l.role === "reviewer" && l.round === round && l.ok === true);

  // A merged pull request usually takes its branch with it. The approved commit then stands in for the tip, but only
  // once the default branch is shown to hold exactly that change: everything below must still name that commit.
  let tip = branchTip(root, issue);
  if (!tip) {
    const merged = review?.verdict === "approved" && review.head ? mergedInto(root, review.head) : null;
    if (!merged) return { enforced: true, ok: false, tip, problems: [`the branch ${branchFor(issue)} does not exist, and the approved commit${review?.head ? ` ${review.head.slice(0, 8)}` : ""} isn't on the default branch, so the reviewed commit can't be compared with anything`] };
    tip = review!.head!;
  }

  const problems: string[] = [];
  const short = (h?: string | null) => (h ? h.slice(0, 8) : "unrecorded");

  if (!review) problems.push(`no valid reviewer run recorded for round ${round}`);
  else if (review.verdict !== "approved") problems.push(`the round ${round} review is "${review.verdict ?? "unknown"}", not approved`);
  else if (review.head !== tip) problems.push(`the approved review judged ${short(review.head)}, but the branch tip is ${short(tip)}`);

  const qa = latest((l) => l.event === "role_run" && l.role === "qa" && l.round === round && l.ok === true);
  if (!qa) problems.push(`no valid QA run recorded for round ${round}`);
  else if (qa.verdict !== "passed" && qa.verdict !== "passed_with_flaky") problems.push(`the round ${round} QA result is "${qa.verdict ?? "unknown"}", not passed`);
  else if (qa.head !== tip) problems.push(`QA ran on ${short(qa.head)}, but the branch tip is ${short(tip)}`);

  // A gate whose `os` excludes this machine is skipped here (reported as skipped, never as passed): CI on its platform judges it.
  for (const g of gates.filter((x) => x.required !== false && !(Array.isArray(x.os) && x.os.length && !x.os.includes(process.platform)))) {
    const run = latest((l) => l.event === "gate_run" && l.gate === g.name);
    if (!run) problems.push(`required gate "${g.name}" has not run for this issue`);
    else if (run.ok !== true) problems.push(`required gate "${g.name}" failed on its latest run`);
    else if (run.head !== tip) problems.push(`gate "${g.name}" passed on ${short(run.head)}, but the branch tip is ${short(tip)}`);
  }
  return { enforced: true, ok: problems.length === 0, problems, tip };
}

export interface CompletionParams {
  issue: number;
  state: string;
  round?: number;
  reason?: string;
  [k: string]: unknown;
}

/**
 * For a `Completed` request: null when it may proceed, else the params that record Needs Me
 * `unreviewed_commits` instead. Shared by the CLI and the Pi tool so neither is a way around the other.
 */
export function bindingEscalation<T extends CompletionParams>(root: string, p: T, session: { round?: number } | undefined, gates: GateSpec[]): { params: T; binding: BindingResult } | null {
  if (p.state !== "Completed") return null;
  const b = checkBinding(root, p.issue, p.round ?? session?.round ?? 0, gates);
  if (!b.enforced || b.ok) return null;
  const reason = `unreviewed_commits: ${b.problems.join("; ")}. Decide: re-run the missing role(s) on the current tip, or reset the branch to the reviewed commit.`;
  return { params: { ...p, state: "Needs Me", reason }, binding: b };
}

/** The newest commit the audit log names for each of these issues (a role run or a gate run records the tip it judged). */
function lastReviewedHeads(root: string, issues: Set<number>): Map<number, string> {
  const out = new Map<number, string>();
  const path = join(root, AUDIT_LOG);
  if (!existsSync(path)) return out;
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return out;
  }
  // A year of runs is a few megabytes: the newest lines are enough.
  if (text.length > 8_000_000) text = text.slice(-8_000_000);
  for (const line of text.split("\n")) {
    if (!line.includes('"head"')) continue;
    try {
      const e = JSON.parse(line);
      if (issues.has(e.issue) && typeof e.head === "string" && /^[0-9a-f]{40,64}$/.test(e.head)) out.set(e.issue, e.head);
    } catch {
      /* a partial first line of the window, or a damaged line: the verifier's business */
    }
  }
  return out;
}

/**
 * Finished issues whose reviewed commit is already part of the default branch: someone merged it by hand (a merge, a
 * fast-forward or a squash, and usually the branch was deleted after), and nothing told the state file. Only issues at
 * the finished stage count (reviewed, gated and tested, or waiting for a person to read the pull request).
 *
 * One `git rev-list` of the default branch answers every issue, so `status` stays quick. A squash merge leaves no ancestor to
 * find; recognising one compares patches, which is slow, so only `squash: true` (the dismiss command) does it.
 */
export function mergedFinished(root: string, sessions: { issue: number; state: string; phase?: string; reason?: string }[], opts: { squash?: boolean } = {}): { base: string; issues: number[] } {
  const finished = sessions.filter((s) => (s.state === "Working" && s.phase === "publish") || (s.state === "Needs Me" && /^(review_required|critical_change_needs_human):/.test(String(s.reason ?? ""))));
  if (!finished.length) return { base: "", issues: [] };
  let base: string;
  try {
    base = defaultBase(root);
  } catch {
    return { base: "", issues: [] };
  }
  const heads = lastReviewedHeads(root, new Set(finished.map((s) => s.issue)));
  const branch = (() => {
    try {
      return defaultBranch(root);
    } catch {
      return "main";
    }
  })();
  const reachable = new Set<string>();
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
    const r = git(["rev-list", "--max-count=200000", ref], root, 30_000);
    if (r.ok) for (const sha of r.stdout.split("\n")) if (sha) reachable.add(sha);
  }
  const issues = finished.filter((s) => {
    const head = heads.get(s.issue) ?? branchTip(root, s.issue);
    if (!head) return false;
    return reachable.has(head) || (!!opts.squash && mergedInto(root, head) !== null);
  }).map((s) => s.issue);
  return { base, issues };
}
