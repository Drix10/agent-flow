// Finished work that someone merged by hand: `status` says so once, and `state dismiss --merged` clears it.
// A real run left 34 such issues "ready" for days, each needing its own dismiss with the same reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendAudit } from "../extensions/lib/state.js";
import { mergedFinished } from "../extensions/lib/binding.js";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
const cli = (cwd, ...a) => spawnSync(process.execPath, [BIN, ...a], { cwd, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1", AGENT_FLOW_OFFLINE: "1", AGENT_FLOW_ROLE: "" } });
const git = (cwd, ...a) => {
  const r = spawnSync("git", a, { cwd, encoding: "utf-8" });
  assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/** main plus four issues: #1 merged with a merge commit and its branch deleted, #2 not merged, #3 squash-merged, #4 just started. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "af-merged-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.test");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "AGENTS.md"), "# rules\n");
  writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ version: "2", default_branch: "main", context_files: [{ path: "AGENTS.md", references: [] }] }));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  const heads = {};
  const branchWith = (n, file) => {
    git(dir, "checkout", "-q", "-b", `agent/issue-${n}`, "main");
    writeFileSync(join(dir, file), `${file}\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", `agent: issue ${n}`);
    heads[n] = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "main");
  };
  branchWith(1, "one.txt");
  git(dir, "merge", "-q", "--no-ff", "-m", "merge 1", "agent/issue-1");
  git(dir, "branch", "-q", "-D", "agent/issue-1");
  branchWith(2, "two.txt"); // never merged
  branchWith(3, "three.txt");
  git(dir, "merge", "-q", "--squash", "agent/issue-3");
  git(dir, "commit", "-qm", "squash 3");
  git(dir, "branch", "-q", "-D", "agent/issue-3");
  git(dir, "branch", "-q", "agent/issue-4", "main"); // a branch with nothing on it is trivially an ancestor of main
  for (const n of [1, 2, 3]) {
    cli(dir, "state", "update", "--issue", String(n), "--state", "Working", "--phase", "publish", "--round", "1");
    appendAudit(dir, { event: "role_run", role: "qa", issue: n, head: heads[n], ok: true });
  }
  cli(dir, "state", "update", "--issue", "4", "--state", "Working", "--phase", "implement", "--round", "1");
  return dir;
}

test("mergedFinished: a merge is found from the audit log even though its branch is gone; a squash only when asked; an unfinished issue never", () => {
  const dir = fixture();
  try {
    const sessions = JSON.parse(cli(dir, "state", "show", "--json").stdout).sessions;
    assert.deepEqual(mergedFinished(dir, sessions).issues, [1], "the quick pass finds the ancestor");
    assert.deepEqual(mergedFinished(dir, sessions, { squash: true }).issues, [1, 3], "comparing patches finds the squash too");
    assert.equal(mergedFinished(dir, sessions).base, "main");
    assert.deepEqual(mergedFinished(dir, []).issues, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status folds merged issues into one line (and --json says which); state dismiss --merged clears them and leaves the rest", () => {
  const dir = fixture();
  try {
    const text = cli(dir, "status").stdout;
    assert.match(text, /1 finished issue is already merged into main: #1/);
    assert.match(text, /agent-flow state dismiss --merged/);
    assert.match(text, /#2 is ready: reviewed, checked, not pushed/);
    assert.doesNotMatch(text, /#1 is ready/);
    assert.match(text, /#4 in progress/, "a just-started issue is not mistaken for a merged one");
    const row = JSON.parse(cli(dir, "status", "--json").stdout).rows.find((r) => Array.isArray(r.issues));
    assert.deepEqual(row.issues, [1]);

    const r = cli(dir, "state", "dismiss", "--merged");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /dropped 2 merged issues: #1, #3 \(merged into main\)/);
    const left = JSON.parse(cli(dir, "state", "show", "--json").stdout).sessions.map((s) => s.issue).sort();
    assert.deepEqual(left, [2, 4], "unmerged and unfinished work stays");
    const again = cli(dir, "state", "dismiss", "--merged");
    assert.match(again.stdout, /no finished issue is merged/);
    assert.equal(cli(dir, "state", "dismiss", "--merged", "--json").status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state dismiss --merged takes a reason, and the audit log keeps it", () => {
  const dir = fixture();
  try {
    const r = cli(dir, "state", "dismiss", "--merged", "--reason", "merged by hand on Friday");
    assert.match(r.stdout, /\(merged by hand on Friday\)/);
    const entries = readFileSync(join(dir, ".agent-flow", "audit.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    const dismissed = entries.filter((e) => e.event === "session_dismissed");
    assert.deepEqual(dismissed.map((e) => e.issue).sort(), [1, 3]);
    assert.ok(dismissed.every((e) => e.reason === "merged by hand on Friday"));
    // Without a reason it says what it found: merged into the default branch.
    const dir2 = fixture();
    try {
      cli(dir2, "state", "dismiss", "--merged");
      const e2 = readFileSync(join(dir2, ".agent-flow", "audit.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.event === "session_dismissed");
      assert.equal(e2.reason, "merged into main");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
