// agent-flow clean: the agent/issue-N branches and worktrees a pipeline leaves behind. One real user had 169 on the remote,
// 114 local and 83 worktrees. It removes only what is provably merged, previews first, and leaves anything still open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyClean, planClean } from "../extensions/lib/clean.js";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
const cli = (cwd, args, env = {}) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1", AGENT_FLOW_OFFLINE: "1", AGENT_FLOW_ROLE: "", ...env } });
const git = (cwd, ...a) => {
  const r = spawnSync("git", a, { cwd, encoding: "utf-8" });
  assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const remoteBranches = (dir) => git(dir, "ls-remote", "--heads", "origin").split("\n").filter(Boolean).map((l) => l.split("refs/heads/")[1]).filter((b) => b.startsWith("agent/issue-")).sort();
const localBranches = (dir) => git(dir, "branch", "--list", "agent/issue-*", "--format=%(refname:short)").split("\n").filter(Boolean).sort();

/**
 * main plus issues made with `worktree create`, each pushed to origin:
 *   1 merged (merge commit)   2 not merged   3 squash-merged   4 merged but still open in the state file
 *   5 merged, worktree has uncommitted work
 */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "af-clean-"));
  const dir = join(base, "repo");
  mkdirSync(dir);
  git(base, "init", "-q", "--bare", "remote.git");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.test");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "AGENTS.md"), "# rules\n");
  writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ version: "2", default_branch: "main", context_files: [{ path: "AGENTS.md", references: [] }] }));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  git(dir, "remote", "add", "origin", join(base, "remote.git"));
  git(dir, "push", "-q", "origin", "main");
  const tips = {};
  for (const n of [1, 2, 3, 4, 5]) {
    assert.equal(cli(dir, ["worktree", "create", String(n)]).status, 0, `worktree ${n}`);
    const wt = join(dir, ".worktrees", `issue-${n}`);
    writeFileSync(join(wt, `f${n}.txt`), `${n}\n`);
    git(wt, "add", "-A");
    git(wt, "-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-qm", `issue ${n}`);
    tips[n] = git(wt, "rev-parse", "HEAD");
    git(dir, "push", "-q", "origin", `agent/issue-${n}`);
  }
  for (const n of [1, 4, 5]) git(dir, "merge", "-q", "--no-ff", "-m", `merge ${n}`, `agent/issue-${n}`);
  git(dir, "merge", "-q", "--squash", "agent/issue-3");
  git(dir, "commit", "-qm", "squash 3");
  git(dir, "push", "-q", "origin", "main");
  writeFileSync(join(dir, ".worktrees", "issue-5", "unsaved.txt"), "mine\n");
  cli(dir, ["state", "update", "--issue", "4", "--state", "Working", "--phase", "implement", "--round", "1"]);
  return { base, dir, tips };
}

const ghWith = (tips) => (args) => (args[0] === "pr" ? { status: 0, stdout: JSON.stringify([{ number: 30, headRefName: "agent/issue-3", headRefOid: tips[3] }]) } : null);

test("plan: merged branches are marked for removal, anything unmerged or still open stays, and a squash needs gh", () => {
  const f = fixture();
  try {
    const plan = planClean(f.dir, { active: new Set([4]), gh: ghWith(f.tips) });
    const verdict = (n, where) => plan.items.find((i) => i.issue === n && i.where === where);
    for (const where of ["local", "remote"]) {
      assert.equal(verdict(1, where).action, "remove", `#1 ${where}`);
      assert.equal(verdict(2, where).action, "keep", `#2 ${where} is not merged`);
      assert.equal(verdict(3, where).action, "remove", `#3 ${where} squash found through the pull request`);
      assert.equal(verdict(3, where).pr, 30);
      assert.equal(verdict(4, where).action, "keep", `#4 ${where} is still open`);
      assert.match(verdict(4, where).why, /still open/);
      assert.equal(verdict(5, where).action, "remove", `#5 ${where}: merged (the dirty worktree is dealt with on apply)`);
    }
    assert.equal(verdict(1, "local").worktree, true);
    // Without gh only merges and fast-forwards are known: the squash stays, and the plan says why.
    const noGh = planClean(f.dir, { active: new Set([4]), gh: null });
    assert.equal(noGh.items.find((i) => i.issue === 3 && i.where === "remote").action, "keep");
    assert.ok(noGh.notes.some((n) => /squash/.test(n)));
    // A tip that is not the merged pull request's head is not that pull request's work.
    const other = planClean(f.dir, { active: new Set(), gh: (a) => ({ status: 0, stdout: JSON.stringify([{ number: 9, headRefName: "agent/issue-2", headRefOid: "0".repeat(40) }]) }) });
    assert.equal(other.items.find((i) => i.issue === 2 && i.where === "remote").action, "keep");
    // --offline: the remote isn't asked.
    assert.ok(planClean(f.dir, { active: new Set(), gh: null, remote: false }).items.every((i) => i.where === "local"));
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("apply: removes merged local and remote branches and worktrees, keeps uncommitted work, unmerged and open issues", () => {
  const f = fixture();
  try {
    const plan = planClean(f.dir, { active: new Set([4]), gh: ghWith(f.tips) });
    const result = applyClean(f.dir, plan);
    assert.deepEqual(localBranches(f.dir), ["agent/issue-2", "agent/issue-4", "agent/issue-5"], "5 keeps its branch with its unsaved file");
    assert.deepEqual(remoteBranches(f.dir), ["agent/issue-2", "agent/issue-4"], "5's remote branch was merged and goes; the local one stays with its worktree");
    assert.ok(!existsSync(join(f.dir, ".worktrees", "issue-1")));
    assert.ok(!existsSync(join(f.dir, ".worktrees", "issue-3")));
    assert.ok(existsSync(join(f.dir, ".worktrees", "issue-5", "unsaved.txt")), "uncommitted work is untouched");
    assert.ok(existsSync(join(f.dir, ".worktrees", "issue-2")) && existsSync(join(f.dir, ".worktrees", "issue-4")));
    assert.deepEqual(result.failed.map((x) => [x.issue, x.where]), [[5, "local"]]);
    assert.match(result.failed[0].why, /uncommitted work/);
    assert.ok(result.removed.some((r) => r.issue === 3 && r.where === "local"), "the squash-merged branch needed -D and got it, since its tip is the pull request's head");
    // Idempotent: nothing left that is merged and clean.
    const again = applyClean(f.dir, planClean(f.dir, { active: new Set([4]), gh: ghWith(f.tips) }));
    assert.deepEqual(again.removed.filter((r) => r.where === "remote"), []);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("apply: a branch that moved after it was judged is left alone, locally and on the remote (compare-and-delete, not delete)", () => {
  const f = fixture();
  try {
    const plan = planClean(f.dir, { active: new Set([4]), gh: ghWith(f.tips) });
    // Someone pushes to #1's branch on the remote, and commits on #3's local branch, after the plan was made.
    const other = join(f.base, "other");
    git(f.base, "clone", "-q", join(f.base, "remote.git"), "other");
    git(other, "config", "user.email", "t@example.test");
    git(other, "config", "user.name", "t");
    git(other, "checkout", "-q", "agent/issue-1");
    writeFileSync(join(other, "late.txt"), "late\n");
    git(other, "add", "-A");
    git(other, "commit", "-qm", "late work");
    git(other, "push", "-q", "origin", "agent/issue-1");
    const wt3 = join(f.dir, ".worktrees", "issue-3");
    writeFileSync(join(wt3, "later.txt"), "later\n");
    git(wt3, "add", "-A");
    git(wt3, "-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-qm", "later work");
    const result = applyClean(f.dir, plan);
    assert.ok(remoteBranches(f.dir).includes("agent/issue-1"), "the remote branch that gained a commit is kept");
    assert.ok(result.failed.some((x) => x.issue === 1 && x.where === "remote" && /new commits since it was checked/.test(x.why)), JSON.stringify(result.failed));
    assert.ok(localBranches(f.dir).includes("agent/issue-3"), "the local branch that gained a commit is kept");
    assert.ok(result.failed.some((x) => x.issue === 3 && x.where === "local" && /new commits since it was checked/.test(x.why)), JSON.stringify(result.failed));
    assert.ok(!remoteBranches(f.dir).includes("agent/issue-3"), "an untouched merged remote branch still goes");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("apply: it works from any checked-out branch (git branch -d would judge against HEAD), and never deletes the branch that is checked out", () => {
  const f = fixture();
  try {
    // HEAD on an unrelated branch that does not contain the merged work: `git branch -d` would refuse every one of them.
    git(f.dir, "checkout", "-q", "-b", "elsewhere", "main~3");
    const plan = planClean(f.dir, { active: new Set([4]), gh: ghWith(f.tips), remote: false });
    const result = applyClean(f.dir, plan);
    assert.ok(result.removed.some((r) => r.issue === 1 && r.where === "local"), "merged #1 goes although HEAD is elsewhere");
    assert.ok(!localBranches(f.dir).includes("agent/issue-1"));
    // Now the main checkout is on a merged agent branch (no worktree holds it): it must not be pulled out from under HEAD.
    git(f.dir, "branch", "agent/issue-9", "main");
    git(f.dir, "checkout", "-q", "agent/issue-9");
    const again = applyClean(f.dir, planClean(f.dir, { active: new Set([4]), gh: null, remote: false }));
    assert.ok(localBranches(f.dir).includes("agent/issue-9"), "the checked-out branch stays");
    assert.ok(again.failed.some((x) => x.issue === 9 && /checked out/.test(x.why)), JSON.stringify(again.failed));
    git(f.dir, "checkout", "-q", "main");
    assert.ok(applyClean(f.dir, planClean(f.dir, { active: new Set([4]), gh: null, remote: false })).removed.some((r) => r.issue === 9), "and goes once it is no longer checked out");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("CLI: previews until --yes, --offline leaves the remote alone, and a pipeline role may not run it", () => {
  const f = fixture();
  try {
    const preview = cli(f.dir, ["clean", "--offline"]);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /would remove  2 merged local branches \(2 with a worktree\): #1, #5/, "#3 is a squash and gh was not asked");
    assert.match(preview.stdout, /nothing changed: re-run with --yes/);
    assert.match(preview.stdout, /#4.*a run or a decision is still open/);
    assert.deepEqual(localBranches(f.dir), ["agent/issue-1", "agent/issue-2", "agent/issue-3", "agent/issue-4", "agent/issue-5"], "a preview changes nothing");
    assert.deepEqual(remoteBranches(f.dir).length, 5);

    const json = JSON.parse(cli(f.dir, ["clean", "--offline", "--json"]).stdout);
    assert.equal(json.applied, false);
    assert.ok(json.items.length >= 5);

    const done = cli(f.dir, ["clean", "--yes", "--offline"]);
    assert.match(done.stdout, /removed 1 local and 0 remote branch/, done.stdout);
    assert.equal(done.status, 1, "the dirty worktree could not be cleaned, which is a non-zero exit");
    assert.match(done.stdout, /#5 \(local\): its worktree has uncommitted work/);
    assert.deepEqual(localBranches(f.dir), ["agent/issue-2", "agent/issue-3", "agent/issue-4", "agent/issue-5"], "without gh the squash-merged #3 stays");
    assert.equal(remoteBranches(f.dir).length, 5, "--offline never touched the remote");

    for (const role of ["implementer", "reviewer", "qa"]) {
      const r = cli(f.dir, ["clean", "--yes"], { AGENT_FLOW_ROLE: role });
      assert.equal(r.status, 2, role);
      assert.match(r.stderr, /may not run `agent-flow clean`/);
    }
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("CLI: with nothing to clean it says so, and a repo with no origin skips the remote with a note", () => {
  const dir = mkdtempSync(join(tmpdir(), "af-clean-empty-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@example.test");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "AGENTS.md"), "# rules\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");
    const r = cli(dir, ["clean"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /nothing to clean/);
    assert.match(r.stdout, /note: the remote was not checked/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
