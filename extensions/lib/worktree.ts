/**
 * Per-issue git worktrees at <repo>/.worktrees/issue-N on branch agent/issue-N.
 *
 * Fixes over v1.0.2: no shell interpolation; base branch validated and
 * auto-detected; always rooted at the main repo (not cwd); a leftover branch
 * from a crashed run is reused instead of failing; removal refuses to discard
 * uncommitted work; the branch is kept by default (a PR is open on it); the
 * list comes from git, not an in-memory Map that was empty after every restart.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { toPosix } from "./fsutil.js";
import { defaultBranch, ensureLocalExcludes, git, mustGit, validateBranchName } from "./git.js";

export const WORKTREE_DIR = ".worktrees";
export const branchFor = (issue: number) => `agent/issue-${issue}`;
export const worktreeRel = (issue: number) => `${WORKTREE_DIR}/issue-${issue}`;

function checkIssue(issue: number) {
  if (!Number.isInteger(issue) || issue < 1 || issue > 10_000_000) throw new Error(`issue must be a positive integer, got ${issue}`);
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  issue: number;
  head: string;
}

export function listWorktrees(root: string): WorktreeInfo[] {
  const out: WorktreeInfo[] = [];
  let cur: Partial<{ path: string; head: string; branch: string }> = {};
  const flush = () => {
    const m = cur.branch?.match(/^refs\/heads\/agent\/issue-(\d+)$/);
    if (cur.path && m) out.push({ path: toPosix(cur.path), branch: `agent/issue-${m[1]}`, issue: Number(m[1]), head: cur.head ?? "" });
    cur = {};
  };
  for (const line of mustGit(["worktree", "list", "--porcelain"], root).split("\n")) {
    if (line === "") flush();
    else if (line.startsWith("worktree ")) cur.path = line.slice(9);
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7);
  }
  flush();
  return out.sort((a, b) => a.issue - b.issue);
}

export function createWorktree(root: string, issue: number, baseBranch?: string) {
  checkIssue(issue);
  const base = baseBranch ? validateBranchName(baseBranch, root) : defaultBranch(root);
  const branch = branchFor(issue);
  const rel = worktreeRel(issue);
  const abs = join(root, rel);

  if (existsSync(abs)) return { error: "worktree_exists", path: rel, branch };
  if (!git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], root).ok) {
    throw new Error(`base branch not found: ${base}`);
  }
  ensureLocalExcludes(root, [`/${WORKTREE_DIR}/`, "/.agent-flow/", "/.agent-state.json", "/AGENT_STATE.md"]);

  const branchExists = git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root).ok;
  if (branchExists) {
    const inUse = listWorktrees(root).find((w) => w.branch === branch);
    if (inUse) throw new Error(`branch ${branch} is already checked out at ${inUse.path}`);
    mustGit(["worktree", "add", abs, branch], root);
  } else {
    mustGit(["worktree", "add", "-b", branch, abs, base], root);
  }
  return {
    path: rel,
    branch,
    base,
    issue,
    reused_existing_branch: branchExists,
    message: `Worktree ready at ${rel} on ${branch} (base ${base})`,
  };
}

export function removeWorktree(root: string, issue: number, opts: { force?: boolean; deleteBranch?: boolean } = {}) {
  checkIssue(issue);
  const rel = worktreeRel(issue);
  const abs = join(root, rel);
  const branch = branchFor(issue);
  if (!existsSync(abs)) return { error: "worktree_not_found", path: rel };

  const dirty = git(["status", "--porcelain"], abs);
  if (dirty.ok && dirty.stdout && !opts.force) {
    return {
      error: "worktree_dirty",
      path: rel,
      uncommitted: dirty.stdout.split("\n").slice(0, 50),
      hint: "commit or discard the changes, or pass force: true to throw them away",
    };
  }
  mustGit(["worktree", "remove", ...(opts.force ? ["--force"] : []), abs], root);
  git(["worktree", "prune"], root);

  let branchDeleted = false;
  let branchNote = "kept (a PR may still reference it)";
  if (opts.deleteBranch) {
    const r = git(["branch", "-d", branch], root); // -d: refuses unmerged work
    branchDeleted = r.ok;
    branchNote = r.ok ? "deleted" : `not deleted: ${r.stderr.split("\n")[0]}`;
  }
  return { removed: rel, branch, branch_deleted: branchDeleted, branch_note: branchNote, issue };
}
