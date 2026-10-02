// status: one screen of what protects the repo and what is waiting on you.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const OTHER = process.platform === "linux" ? "darwin" : "linux";
const OTHER_NAME = OTHER === "linux" ? "Linux" : "macOS";
const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
const cli = (cwd, ...a) => spawnSync(process.execPath, [BIN, ...a], { cwd, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1", AGENT_FLOW_OFFLINE: "1", AGENT_FLOW_ROLE: "" } });

function repo(manifest) {
  const dir = mkdtempSync(join(tmpdir(), "af-status-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "AGENTS.md"), "# rules\n");
  if (manifest) writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ version: "2", context_files: [{ path: "AGENTS.md", references: [] }], ...manifest }));
  return dir;
}

test("status: an unprotected repo says so plainly, with the fix, and exits 1", () => {
  const dir = repo(null);
  try {
    const r = cli(dir, "status");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /✗ no guard hook: agents are not being stopped/);
    assert.match(r.stdout, /→ npx @drix10\/agent-flow install --harness claude/);
    assert.match(r.stdout, /no CONTEXT_MANIFEST\.json/);
    assert.match(r.stdout, /nothing is waiting on you/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status: after install it is green, counts the protection, and lists work that needs you", () => {
  const dir = repo({ protected_paths: ["secret/**", "STAGE"], risk_boundaries: [{ path: "core/**", risk_level: "critical" }], gates: [{ name: "a", command: "true" }, { name: "b", command: "true", os: [OTHER] }], pipeline: { auto_merge_low_risk: true } });
  try {
    assert.equal(cli(dir, "install", "--harness", "claude").status, 0);
    cli(dir, "state", "update", "--issue", "7", "--state", "Needs Me", "--reason", "SPEC_ERROR: the criteria contradict each other");
    cli(dir, "state", "update", "--issue", "8", "--state", "Working", "--phase", "review", "--round", "2");
    const r = cli(dir, "status");
    assert.match(r.stdout, /✓ Claude Code guard hook is active/);
    assert.match(r.stdout, /✓ 2 protected paths, 1 critical area\b/);
    assert.match(r.stdout, /merge themselves/, "auto-merge is called out");
    assert.ok(r.stdout.includes(`1 check runs here; 1 needs ${OTHER_NAME} and is skipped`), r.stdout);
    assert.match(r.stdout, /! #7 needs you: SPEC_ERROR: the criteria contradict each other/);
    assert.match(r.stdout, /· #8 in progress \(round 2, review\)/);
    assert.match(r.stdout, /agent-flow run 7/, "the next command is given");
    const j = JSON.parse(cli(dir, "status", "--json").stdout);
    assert.equal(j.ok, true);
    assert.ok(j.rows.some((x) => x.section === "Work" && x.level === "warn"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status: names the real cause when the notes are broken, not a generic complaint", () => {
  const dir = repo({ protected_paths: [], gates: [{ name: "x", command: "true", os: ["plan9"] }] });
  try {
    const r = cli(dir, "status");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /✗ CONTEXT_MANIFEST.json has a problem: .*os/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status does not claim another harness guard is active from config-file presence alone", () => {
  const dir = repo({ protected_paths: ["secret/**"] });
  try {
    mkdirSync(join(dir, ".codex"));
    writeFileSync(join(dir, ".codex", "hooks.json"), "{}");
    const r = cli(dir, "status");
    assert.match(r.stdout, /guard configuration found for codex \(not verified active\)/);
    assert.doesNotMatch(r.stdout, /guard hook wired for codex/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
