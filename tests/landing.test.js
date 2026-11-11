// What a session may land without anyone's help: its own branch (a bare or `HEAD` push is resolved, not guessed), a branch already merged into the
// default branch, a lease-guarded force on a branch it tracks, and its own snapshot refs. Everything is judged from the repository's own facts, offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../extensions/lib/guard.js";

/** A stand-in repository: the checked-out branch, config, remotes, and which refs point at which commits (child -> parent chain per commit). */
function probe({ current = "feat/x", config = {}, remotes = ["origin"], tips = {}, ancestors = [], branches = ["feat/x", "main"] } = {}) {
  return {
    currentBranch: () => current,
    config: (_cwd, key) => config[key] ?? null,
    remotes: () => remotes,
    tip: (_cwd, ref) => tips[ref] ?? null,
    isAncestor: (_cwd, a, b) => ancestors.some(([x, y]) => x === a && y === b),
    hasBranch: (_cwd, b) => branches.includes(b),
  };
}
const run = (command, o = {}) => decide({ role: null, toolName: "Bash", input: { command }, cwd: "/repo", root: "/repo", manifest: { default_branch: "main" }, ...o })?.rule ?? null;

test("a bare push, and a push of HEAD, go to the checked-out branch: fine on a feature branch, a landing on main", () => {
  const feat = { probe: probe() };
  for (const c of ["git push", "git push origin", "git push -u origin HEAD", "git push origin HEAD", "git push --set-upstream origin @", "git push origin 'HEAD'"]) assert.equal(run(c, feat), null, c);
  const onMain = { probe: probe({ current: "main" }) };
  for (const c of ["git push", "git push -u origin HEAD"]) assert.equal(run(c, onMain), "push-default-branch", c);
  assert.equal(run("git push -u origin HEAD", { ...onMain, grants: { pushDefault: { id: "g" }, pauseAll: null, pausedRules: new Map() } }), null, "and a grant lets main land");
});

test("a push the guard cannot resolve keeps today's block", () => {
  assert.equal(run("git push", { probe: probe({ current: null }) }), "explicit-refspec", "detached HEAD");
  assert.equal(run("git push", { probe: probe({ config: { "push.default": "matching" } }) }), "explicit-refspec", "matching pushes every branch");
  assert.equal(run("git push origin HEAD", { probe: probe({ config: { "push.default": "upstream", "branch.feat/x.merge": "refs/heads/main" }, current: "feat/x" }) }), "push-default-branch", "upstream mapping to main is a landing");
  assert.equal(run("cd $OTHER && git push origin HEAD", { probe: probe() }), "explicit-refspec", "after a computed cd the checked-out branch is not the one the guard can see");
  assert.equal(run("git --git-dir=../x/.git push origin HEAD", { probe: probe() }), "explicit-refspec");
  assert.equal(run("git push origin $(git branch --show-current)", { probe: probe() }), "explicit-refspec", "a substitution can be anything");
  assert.equal(run("git push origin HEAD:main", { probe: probe() }), "push-default-branch", "an explicit destination is judged as written");
});

const merged = (extra = {}) =>
  probe({
    tips: { "refs/remotes/origin/main": "M", "refs/remotes/origin/fix/a": "A", "refs/remotes/origin/fix/b": "B", "refs/remotes/origin/wip": "W", "refs/remotes/origin/same": "M", "refs/remotes/origin/release/1.0": "R" },
    ancestors: [["A", "M"], ["B", "M"], ["R", "M"], ["M", "M"]],
    ...extra,
  });

test("deleting remote branches that are fully merged into the default branch is allowed, whatever their prefix", () => {
  const o = { probe: merged() };
  for (const c of ["git push origin --delete fix/a", "git push origin --delete fix/a fix/b", "git push origin :fix/a", "git push -d origin fix/a", "git push origin :fix/a :fix/b"]) assert.equal(run(c, o), null, c);
});

test("deleting anything else stays blocked, and says why", () => {
  const o = { probe: merged() };
  const why = (c) => decide({ role: null, toolName: "Bash", input: { command: c }, cwd: "/repo", root: "/repo", manifest: { default_branch: "main" }, ...o });
  for (const c of ["git push origin --delete wip", "git push origin --delete fix/a wip", "git push origin --delete same", "git push origin --delete main", "git push origin :main", "git push origin --delete release/1.0", "git push origin --delete nope", "git push origin --delete $B", "git push origin --delete fix/*", "git push https://example.com/r.git --delete fix/a", "git push --delete origin"]) {
    assert.equal(run(c, o), c.includes(":main") ? "push-default-branch" : "force-push", c);
  }
  assert.match(why("git push origin --delete wip").reason, /commits the default branch doesn't/);
  assert.match(why("git push origin --delete nope").reason, /fetch first/);
  assert.equal(run("git push origin --delete fix/a", { probe: probe({ remotes: [], tips: {} }) }), "force-push", "no remote-tracking facts, no allow");
  assert.equal(run("git push origin --delete fix/a", { probe: merged(), role: "implementer" }), null, "provable merged-ness is a fact, not a grant: roles get it too");
});

test("--force-with-lease is allowed on a branch the session tracks, never plain force, never the default or a release branch", () => {
  const o = { probe: probe({ config: { "branch.feat/x.remote": "origin" }, branches: ["feat/x", "main", "other"] }) };
  for (const c of ["git push --force-with-lease origin feat/x", "git push --force-with-lease=feat/x:abc123 origin feat/x", "git push --force-with-lease origin HEAD", "git push --force-with-lease"]) assert.equal(run(c, o), null, c);
  for (const c of ["git push --force origin feat/x", "git push -f origin feat/x", "git push origin +feat/x", "git push --force-with-lease --force origin feat/x", "git push --force-with-lease origin main", "git push --force-with-lease origin release/1.0", "git push --force-with-lease origin other", "git push --force-with-lease origin nope", "git push --mirror origin"]) {
    assert.ok(["force-push", "push-default-branch"].includes(run(c, o)), c);
  }
});

test("update-ref in a custom namespace is allowed; branches, tags, remote-tracking refs, HEAD and batches are not", () => {
  for (const c of ["git update-ref refs/snapshots/20261111 HEAD", "git update-ref -m 'pin' refs/agent-flow/checkpoints/1 abc123", "git update-ref refs/codex-benched/2026 refs/codex-snapshots/2026", "git update-ref -d refs/snapshots/old"]) assert.equal(run(c), null, c);
  for (const c of ["git update-ref refs/heads/main HEAD", "git update-ref refs/heads/feat/x abc", "git update-ref refs/tags/v1 abc", "git update-ref refs/remotes/origin/main abc", "git update-ref HEAD abc", "git update-ref -d refs/heads/main", "git update-ref --stdin", "git update-ref refs/snapshots/../heads/main abc", "git update-ref refs/replace/abc def", "git update-ref"]) {
    assert.equal(run(c), "ref-rewrite", c);
  }
});

// A literal `cd` is followed, so `cd <repo> && git push` (how most pushes are written) is judged in the repository it runs in.
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const posix = (p) => p.split(String.fromCharCode(92)).join("/");
const wt = resolve(tmpdir(), "af-landing-wt");
const mainWt = resolve(tmpdir(), "af-landing-main");
const byDir = (extra = {}) => ({ ...probe(), currentBranch: (cwd) => ({ [resolve(wt)]: "feat/x", [resolve(mainWt)]: "main" })[resolve(cwd)] ?? null, ...extra });
const from = (command, o = {}) => decide({ role: null, toolName: "Bash", input: { command }, cwd: mainWt, root: mainWt, manifest: { default_branch: "main" }, probe: byDir(), ...o })?.rule ?? null;

test("cd to a literal directory moves the repository the push is judged in", () => {
  assert.equal(from("git push origin HEAD"), "push-default-branch", "the session's own cwd is on main");
  assert.equal(from(`cd ${posix(wt)} && git push origin HEAD`), null, "after cd the feature worktree is checked out");
  assert.equal(from(`cd ${posix(wt)}; git push`), null);
  assert.equal(from(`git -C ${posix(wt)} push -u origin HEAD`), null, "-C is a cd for one command");
  assert.equal(from(`cd ${posix(wt)} && cd ${posix(mainWt)} && git push origin HEAD`), "push-default-branch", "and the last cd wins");
  for (const c of [`cd $D && git push origin HEAD`, `(cd ${posix(wt)} && git push origin HEAD); git push origin HEAD`, `cd ${posix(wt)} && cd - && git push origin HEAD`, `popd && git push origin HEAD`, `x=$(cd ${posix(wt)} && pwd); git push origin HEAD`, `GIT_DIR=/x git push origin HEAD`]) {
    assert.equal(from(c), "explicit-refspec", c);
  }
});
