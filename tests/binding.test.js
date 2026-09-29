// A review, QA run and gate run only count for the commit they judged: Completed needs all of them on the current tip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendAudit, readState } from "../extensions/lib/state.js";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
const git = (dir, ...a) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir, encoding: "utf-8" });
const cli = (dir, ...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1", AGENT_FLOW_ROLE: "" } });
const tip = (dir) => git(dir, "rev-parse", "agent/issue-1").stdout.trim();

function repo(manifest, fn) {
  const dir = mkdtempSync(join(tmpdir(), "af-bind-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ version: "1", protected_paths: [], ...manifest }));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    git(dir, "branch", "agent/issue-1");
    assert.equal(cli(dir, "state", "update", "--issue", "1", "--state", "Working", "--round", "1").status, 0);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const run = (dir, role, verdict, head) => appendAudit(dir, { event: "role_run", issue: 1, role, round: 1, ok: true, verdict, head });
const complete = (dir) => cli(dir, "state", "update", "--issue", "1", "--state", "Completed", "--round", "1", "--json");

test("Completed is allowed when review and QA name the branch tip", () => {
  repo({}, (dir) => {
    const h = tip(dir);
    run(dir, "reviewer", "approved", h);
    run(dir, "qa", "passed", h);
    assert.equal(complete(dir).status, 0);
    assert.equal(readState(dir).sessions[0].state, "Completed");
  });
});

test("a commit after the approval blocks Completed and records Needs Me unreviewed_commits", () => {
  repo({}, (dir) => {
    const h = tip(dir);
    run(dir, "reviewer", "approved", h);
    run(dir, "qa", "passed", h);
    git(dir, "commit", "-q", "--allow-empty", "-m", "sneaky", "--no-verify");
    git(dir, "update-ref", "refs/heads/agent/issue-1", git(dir, "rev-parse", "HEAD").stdout.trim());
    const r = complete(dir);
    assert.equal(r.status, 3);
    const s = readState(dir).sessions[0];
    assert.equal(s.state, "Needs Me");
    assert.match(s.reason, /unreviewed_commits/);
    assert.match(s.reason, /approved review judged/);
  });
});

test("runs without a recorded head (older audit lines) are not enforced", () => {
  repo({}, (dir) => {
    appendAudit(dir, { event: "role_run", issue: 1, role: "reviewer", round: 1, ok: true });
    assert.equal(complete(dir).status, 0);
  });
});

test("a missing QA run, a non-approved review and a stale gate are each reported", () => {
  const node = [process.execPath, "-e", "process.exit(0)"];
  repo({ gates: [{ name: "unit", command: node }] }, (dir) => {
    const h = tip(dir);
    run(dir, "reviewer", "changes_requested", h);
    const r = complete(dir);
    assert.equal(r.status, 3);
    const reason = readState(dir).sessions[0].reason;
    assert.match(reason, /not approved/);
    assert.match(reason, /no valid QA run/);
    assert.match(reason, /gate "unit" has not run/);
  });
});

test("runs audited before the branch existed (head: null) still switch enforcement on and can't pass", () => {
  repo({}, (dir) => {
    run(dir, "reviewer", "approved", null);
    run(dir, "qa", "passed", null);
    const r = complete(dir);
    assert.equal(r.status, 3);
    assert.match(readState(dir).sessions[0].reason, /unrecorded/);
  });
});
