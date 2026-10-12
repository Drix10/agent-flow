/**
 * `agent-flow clean`: take back the branches and worktrees a pipeline leaves behind.
 *
 * Every `run --pr` pushes `agent/issue-N`, and nothing removes it after the pull request is merged: one real user had 169
 * branches on the remote, 114 local branches and 83 worktrees. The guard keeps agents from deleting branches, so this is a
 * person's command, previewed first.
 *
 * What it touches is deliberately narrow: only `agent/issue-N` branches (the ones this tool made), only when the work is
 * provably in the default branch, and never an issue whose run or decision is still open.
 *  - merged means the tip is an ancestor of the default branch (a merge or a fast-forward), or equals the head commit of a
 *    merged pull request (a squash merge leaves no ancestor, so `gh` is asked);
 *  - a worktree with uncommitted work stays, and so does its branch;
 *  - the remote step needs `origin` and is skipped when it can't be reached.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { defaultBranch, git } from "./git.js";
import { branchFor, removeWorktree, worktreeRel } from "./worktree.js";

export type GhFn = (args: string[]) => { status: number; stdout: string } | null;

export interface CleanItem {
  issue: number;
  branch: string;
  /** The commit the branch pointed at when it was judged merged: it is deleted only while it still points there. */
  sha: string;
  where: "local" | "remote";
  action: "remove" | "keep";
  /** Why it stays. */
  why?: string;
  /** A worktree folder exists for this issue (local items). */
  worktree?: boolean;
  /** Merged only as a pull request's head (a squash): git itself does not call it merged, so deleting it needs -D. */
  viaPr?: boolean;
  pr?: number;
}

export interface CleanPlan {
  base: string;
  items: CleanItem[];
  notes: string[];
}

const BRANCH = /^agent\/issue-(\d+)$/;
const SHA = /^[0-9a-f]{40,64}$/;

/** Branch name → (head commit → pull request number) for merged pull requests. */
function mergedHeads(gh: GhFn | null | undefined, notes: string[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  if (!gh) {
    notes.push("gh was not asked (no gh, or --offline): a branch merged by squash can't be recognised, only merges and fast-forwards");
    return out;
  }
  const r = gh(["pr", "list", "--state", "merged", "--limit", "1000", "--json", "number,headRefName,headRefOid"]);
  if (!r || r.status !== 0) {
    notes.push("gh could not list merged pull requests (not installed or not logged in): a branch merged by squash can't be recognised");
    return out;
  }
  try {
    for (const p of JSON.parse(r.stdout) as { number: number; headRefName: string; headRefOid: string }[]) {
      if (typeof p.headRefName !== "string" || !SHA.test(String(p.headRefOid))) continue;
      const m = out.get(p.headRefName) ?? new Map<string, number>();
      m.set(p.headRefOid, p.number);
      out.set(p.headRefName, m);
    }
  } catch {
    notes.push("gh answered, but not with a list of pull requests; squash merges can't be recognised");
  }
  return out;
}

/** Every commit reachable from the default branch, local and remote-tracking, in one pass per ref. */
function reachableFromDefault(root: string): { base: string; commits: Set<string> } {
  let branch = "main";
  try {
    branch = defaultBranch(root);
  } catch {
    /* fall back to main */
  }
  const commits = new Set<string>();
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
    const r = git(["rev-list", "--max-count=200000", ref], root, 30_000);
    if (r.ok) for (const sha of r.stdout.split("\n")) if (sha) commits.add(sha);
  }
  return { base: branch, commits };
}

export function planClean(root: string, o: { active: ReadonlySet<number>; gh?: GhFn | null; remote?: boolean }): CleanPlan {
  const notes: string[] = [];
  const { base, commits } = reachableFromDefault(root);
  if (!commits.size) {
    notes.push(`the default branch (${base}) has no commits to compare with: nothing was judged merged`);
    return { base, items: [], notes };
  }
  const prs = mergedHeads(o.gh, notes);
  const items: CleanItem[] = [];

  /** merged = in the default branch's history, or a merged pull request's head; `pr` says which. */
  const judge = (branch: string, sha: string): { merged: boolean; viaPr: boolean; pr?: number } => {
    if (commits.has(sha)) return { merged: true, viaPr: false, pr: prs.get(branch)?.get(sha) };
    const pr = prs.get(branch)?.get(sha);
    return pr === undefined ? { merged: false, viaPr: false } : { merged: true, viaPr: true, pr };
  };

  const local = git(["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/agent/"], root);
  for (const line of local.ok ? local.stdout.split("\n") : []) {
    const [branch, sha] = line.trim().split(" ");
    const m = BRANCH.exec(branch ?? "");
    if (!m || !SHA.test(sha ?? "")) continue;
    const issue = Number(m[1]);
    const worktree = existsSync(join(root, worktreeRel(issue)));
    if (o.active.has(issue)) {
      items.push({ issue, branch, sha, where: "local", action: "keep", why: "a run or a decision is still open (agent-flow status)", worktree });
      continue;
    }
    const j = judge(branch, sha);
    items.push(j.merged ? { issue, branch, sha, where: "local", action: "remove", worktree, viaPr: j.viaPr, pr: j.pr } : { issue, branch, sha, where: "local", action: "keep", why: "has work that is not in the default branch", worktree });
  }

  if (o.remote !== false) {
    const ls = git(["ls-remote", "--heads", "origin", "refs/heads/agent/issue-*"], root, 60_000);
    if (!ls.ok) notes.push(`the remote was not checked: ${ls.stderr.split("\n")[0] || "no origin"}`);
    else {
      for (const line of ls.stdout.split("\n")) {
        const [sha, ref] = line.trim().split(/\s+/);
        const branch = (ref ?? "").replace(/^refs\/heads\//, "");
        const m = BRANCH.exec(branch);
        if (!m || !SHA.test(sha ?? "")) continue;
        const issue = Number(m[1]);
        if (o.active.has(issue)) {
          items.push({ issue, branch, sha, where: "remote", action: "keep", why: "a run or a decision is still open (agent-flow status)" });
          continue;
        }
        const j = judge(branch, sha);
        items.push(j.merged ? { issue, branch, sha, where: "remote", action: "remove", viaPr: j.viaPr, pr: j.pr } : { issue, branch, sha, where: "remote", action: "keep", why: "has work that is not in the default branch" });
      }
    }
  }
  items.sort((a, b) => a.issue - b.issue || a.where.localeCompare(b.where));
  return { base, items, notes };
}

export interface CleanResult {
  removed: { issue: number; where: "local" | "remote"; what: string }[];
  failed: { issue: number; where: "local" | "remote"; why: string }[];
}

/** Is `branch` checked out in any worktree (the main checkout included)? Deleting it would pull the branch out from under HEAD. */
function checkedOut(root: string, branch: string): boolean {
  const r = git(["worktree", "list", "--porcelain"], root);
  return r.ok && r.stdout.split("\n").some((l) => l === `branch refs/heads/${branch}`);
}

/**
 * Delete a local branch only if it still points at the commit that was checked, and is not checked out anywhere.
 * `git branch -d` is not used: it judges "merged" against the current branch, so it refuses a branch that is in the default
 * branch when you happen to be on another one. `update-ref -d <ref> <sha>` deletes only while the ref still holds `sha`.
 * Without `expect.sha`, the tip must be in the default branch's history.
 */
export function deleteLocalBranch(root: string, branch: string, expect: { sha?: string } = {}): { ok: boolean; absent?: boolean; why?: string } {
  const tip = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], root);
  if (!tip.ok || !tip.stdout) return { ok: true, absent: true };
  if (expect.sha) {
    if (tip.stdout !== expect.sha) return { ok: false, why: "the branch has new commits since it was checked, so it was left" };
  } else {
    const { base, commits } = reachableFromDefault(root);
    if (!commits.has(tip.stdout)) return { ok: false, why: `its work is not in ${base}` };
  }
  if (checkedOut(root, branch)) return { ok: false, why: "the branch is checked out" };
  const d = git(["update-ref", "-d", `refs/heads/${branch}`, tip.stdout], root);
  if (!d.ok) return { ok: false, why: d.stderr.split("\n")[0] || "git would not delete the branch" };
  // `git branch -d` also drops the branch's upstream settings (set by `push -u`); update-ref does not.
  git(["config", "--remove-section", `branch.${branch}`], root);
  return { ok: true };
}

export function applyClean(root: string, plan: CleanPlan): CleanResult {
  const result: CleanResult = { removed: [], failed: [] };
  for (const it of plan.items.filter((x) => x.where === "local" && x.action === "remove")) {
    let what = "branch";
    try {
      if (it.worktree) {
        const r = removeWorktree(root, it.issue, {});
        if ("error" in r && r.error === "worktree_dirty") {
          result.failed.push({ issue: it.issue, where: "local", why: "its worktree has uncommitted work, so it and its branch stay" });
          continue;
        }
        if ("error" in r && r.error !== "worktree_not_found") {
          result.failed.push({ issue: it.issue, where: "local", why: String(r.error) });
          continue;
        }
        what = "worktree and branch";
      }
      const d = deleteLocalBranch(root, it.branch, { sha: it.sha });
      if (d.ok && !d.absent) result.removed.push({ issue: it.issue, where: "local", what });
      else if (!d.ok) result.failed.push({ issue: it.issue, where: "local", why: d.why ?? "git would not delete the branch" });
    } catch (e: any) {
      result.failed.push({ issue: it.issue, where: "local", why: String(e?.message ?? e).split("\n")[0] });
    }
  }

  // Remote: each delete carries a lease on the commit that was judged merged, so a push that landed since is never lost.
  const remote = plan.items.filter((x) => x.where === "remote" && x.action === "remove");
  const leaseArgs = (items: CleanItem[]) => [...items.map((i) => `--force-with-lease=refs/heads/${i.branch}:${i.sha}`), ...items.map((i) => `:refs/heads/${i.branch}`)];
  const why = (stderr: string) => (/stale info|rejected|lease/i.test(stderr) && !/protected|denied/i.test(stderr) ? "the branch has new commits since it was checked, so it was left" : stderr.split("\n").find((l) => /rejected|denied|protected|error|fatal/i.test(l))?.replace(/^remote:\s*/, "") ?? "the remote refused");
  const stillThere = (): Map<string, string> => {
    const ls = git(["ls-remote", "--heads", "origin", "refs/heads/agent/issue-*"], root, 60_000);
    const m = new Map<string, string>();
    if (ls.ok) for (const line of ls.stdout.split("\n")) {
      const [sha, ref] = line.trim().split(/\s+/);
      if (sha && ref) m.set(ref.replace(/^refs\/heads\//, ""), sha);
    }
    return m;
  };
  for (let i = 0; i < remote.length; i += 20) {
    const chunk = remote.slice(i, i + 20);
    const r = git(["push", "origin", ...leaseArgs(chunk)], root, 120_000);
    if (r.ok) {
      for (const it of chunk) result.removed.push({ issue: it.issue, where: "remote", what: "remote branch" });
      continue;
    }
    // Some refused (a protected branch, or one that moved): see what is gone, and say why for the rest.
    const left = stillThere();
    for (const it of chunk) {
      if (!left.has(it.branch)) result.removed.push({ issue: it.issue, where: "remote", what: "remote branch" });
      else {
        const one = git(["push", "origin", ...leaseArgs([it])], root, 60_000);
        if (one.ok) result.removed.push({ issue: it.issue, where: "remote", what: "remote branch" });
        else result.failed.push({ issue: it.issue, where: "remote", why: why(one.stderr) });
      }
    }
  }
  if (remote.length) git(["remote", "prune", "origin"], root, 60_000);
  return result;
}
