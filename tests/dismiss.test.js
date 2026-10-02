// state dismiss: a person drops an issue they handled by hand, without losing its files or its audit trail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "af-dismiss-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "AGENTS.md"), "# rules\n");
  writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ version: "2", context_files: [{ path: "AGENTS.md", references: [] }], protected_paths: ["secret/**"], gates: [{ name: "a", command: "true" }] }));
  return dir;
}
const cli = (dir, args, env = {}) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1", AGENT_FLOW_OFFLINE: "1", AGENT_FLOW_ROLE: "", ...env } });
const escalate = (dir) => cli(dir, ["state", "update", "--issue", "7", "--state", "Needs Me", "--reason", "protected_path: .github/workflows/ci.yml"]);

test("dismiss: the issue leaves the list, its files and the audit trail stay, and status stops nagging", () => {
  const dir = repo();
  try {
    escalate(dir);
    mkdirSync(join(dir, ".agent-flow", "artifacts", "issue-7"), { recursive: true });
    writeFileSync(join(dir, ".agent-flow", "artifacts", "issue-7", "issue.md"), "the task\n");
    assert.match(cli(dir, ["status"]).stdout, /#7 needs you/);

    const r = cli(dir, ["state", "dismiss", "--issue", "7", "--reason", "changed the workflow by hand"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /#7 dropped from the list \(it was Needs Me\)/);
    assert.match(r.stdout, /worktree remove 7/, "it says how to clean up the worktree");

    assert.equal(JSON.parse(cli(dir, ["state", "show", "--issue", "7", "--json"]).stdout).state, null);
    assert.doesNotMatch(readFileSync(join(dir, "AGENT_STATE.md"), "utf-8"), /#7/);
    assert.ok(existsSync(join(dir, ".agent-flow", "artifacts", "issue-7", "issue.md")), "nothing is deleted");
    const audit = readFileSync(join(dir, ".agent-flow", "audit.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const entry = audit.find((e) => e.event === "session_dismissed");
    assert.deepEqual([entry.issue, entry.from, entry.reason], [7, "Needs Me", "changed the workflow by hand"]);
    assert.match(cli(dir, ["status"]).stdout, /nothing is waiting on you/);
    assert.match(cli(dir, ["audit", "verify"]).stdout, /intact/, "the chain still verifies");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dismiss: it needs a reason, tells you when the issue isn't there, and an agent role may not do it", () => {
  const dir = repo();
  try {
    escalate(dir);
    const noReason = cli(dir, ["state", "dismiss", "--issue", "7"]);
    assert.equal(noReason.status, 2);
    assert.match(noReason.stderr, /say why it is being dropped/);
    assert.equal(JSON.parse(cli(dir, ["state", "show", "--issue", "7", "--json"]).stdout).state, "Needs Me", "still there");

    const missing = cli(dir, ["state", "dismiss", "--issue", "99", "--reason", "x"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /#99 is not in the list/);

    for (const role of ["implementer", "reviewer", "qa", "orchestrator"]) {
      const denied = cli(dir, ["state", "dismiss", "--issue", "7", "--reason", "nope"], { AGENT_FLOW_ROLE: role });
      assert.equal(denied.status, 2, role);
      assert.match(denied.stderr, /may not run `agent-flow state dismiss`/, role);
    }
    assert.equal(JSON.parse(cli(dir, ["state", "show", "--issue", "7", "--json"]).stdout).state, "Needs Me", "no role could drop it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dismiss: refused while a run is still working on the issue", () => {
  const dir = repo();
  try {
    cli(dir, ["state", "update", "--issue", "7", "--state", "Working", "--phase", "review", "--round", "1"]);
    const artifacts = join(dir, ".agent-flow", "artifacts", "issue-7");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "run.lock"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    const r = cli(dir, ["state", "dismiss", "--issue", "7", "--reason", "stuck"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /being worked on right now/);
    assert.equal(JSON.parse(cli(dir, ["state", "show", "--issue", "7", "--json"]).stdout).state, "Working", "left alone");
    assert.ok(existsSync(join(artifacts, "run.lock")), "and the live run's lock is untouched");
    writeFileSync(join(artifacts, "run.lock"), JSON.stringify({ pid: 2147483646, at: Date.now() }));
    assert.equal(cli(dir, ["state", "dismiss", "--issue", "7", "--reason", "stuck"]).status, 0, "a dead run's lock does not block it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
