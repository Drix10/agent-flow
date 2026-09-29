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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.js";
import { branchFor } from "./worktree.js";
import { AUDIT_LOG } from "./state.js";
import type { GateSpec } from "./gates.js";

/** The commit at the tip of agent/issue-N, or null when the branch doesn't exist. */
export function branchTip(root: string, issue: number | undefined): string | null {
  if (!issue) return null;
  const r = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branchFor(issue)}`], root, 10_000);
  return r.ok && /^[0-9a-f]{40,64}$/.test(r.stdout) ? r.stdout : null;
}

interface AuditLine {
  event?: string;
  issue?: number;
  role?: string;
  round?: number;
  ok?: boolean;
  verdict?: string;
  gate?: string;
  head?: string;
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
  const bound = lines.some((l) => l.event === "role_run" && typeof l.head === "string");
  if (!bound) return { enforced: false, ok: true, problems: [], tip: null };

  const tip = branchTip(root, issue);
  if (!tip) return { enforced: true, ok: false, tip, problems: [`the branch ${branchFor(issue)} does not exist, so the reviewed commit can't be compared with anything`] };

  const problems: string[] = [];
  const short = (h?: string) => (h ? h.slice(0, 8) : "unrecorded");
  const latest = (pred: (l: AuditLine) => boolean) => [...lines].reverse().find(pred);

  const review = latest((l) => l.event === "role_run" && l.role === "reviewer" && l.round === round && l.ok === true);
  if (!review) problems.push(`no valid reviewer run recorded for round ${round}`);
  else if (review.verdict !== "approved") problems.push(`the round ${round} review is "${review.verdict ?? "unknown"}", not approved`);
  else if (review.head !== tip) problems.push(`the approved review judged ${short(review.head)}, but the branch tip is ${short(tip)}`);

  const qa = latest((l) => l.event === "role_run" && l.role === "qa" && l.round === round && l.ok === true);
  if (!qa) problems.push(`no valid QA run recorded for round ${round}`);
  else if (qa.verdict !== "passed" && qa.verdict !== "passed_with_flaky") problems.push(`the round ${round} QA result is "${qa.verdict ?? "unknown"}", not passed`);
  else if (qa.head !== tip) problems.push(`QA ran on ${short(qa.head)}, but the branch tip is ${short(tip)}`);

  for (const g of gates.filter((x) => x.required !== false)) {
    const run = latest((l) => l.event === "gate_run" && l.gate === g.name);
    if (!run) problems.push(`required gate "${g.name}" has not run for this issue`);
    else if (run.ok !== true) problems.push(`required gate "${g.name}" failed on its latest run`);
    else if (run.head !== tip) problems.push(`gate "${g.name}" passed on ${short(run.head)}, but the branch tip is ${short(tip)}`);
  }
  return { enforced: true, ok: problems.length === 0, problems, tip };
}
