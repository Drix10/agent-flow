// The status badge for Claude Code's statusLine: quick, silent on any problem, and honest about whether the guard is wired.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStatusline, claudeGuardWired } from "../extensions/lib/statusline.js";
import { stripOurHooks } from "../extensions/lib/uninstall.js";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
const env = { ...process.env, NO_COLOR: "1", AGENT_FLOW_OFFLINE: "1", AGENT_FLOW_ROLE: "" };
const cli = (cwd, args, input) => spawnSync(process.execPath, [BIN, ...args], { cwd, input, encoding: "utf-8", env });

function repo(withManifest = true) {
  const dir = mkdtempSync(join(tmpdir(), "af-sl-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "AGENTS.md"), "# r\n");
  if (withManifest) writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ version: "2", context_files: [{ path: "AGENTS.md", references: [] }], protected_paths: ["secret/**"] }));
  return dir;
}
const state = (dir, ...a) => assert.equal(cli(dir, ["state", "update", ...a]).status, 0);

test("buildStatusline: nothing without a manifest; guard OFF until the hook is wired, then guard on", () => {
  const none = repo(false);
  try {
    assert.equal(buildStatusline(none), "");
  } finally {
    rmSync(none, { recursive: true, force: true });
  }
  const dir = repo();
  try {
    assert.equal(buildStatusline(dir), "agent-flow · guard OFF");
    assert.equal(claudeGuardWired(dir), false);
    assert.equal(cli(dir, ["install", "--harness", "claude"]).status, 0);
    assert.equal(claudeGuardWired(dir), true);
    assert.equal(buildStatusline(dir), "agent-flow · guard on");
    // The hook points at a runtime that is gone: not wired, whatever settings.json says.
    rmSync(join(dir, ".agent-flow-runtime"), { recursive: true, force: true });
    assert.equal(claudeGuardWired(dir), false);
    assert.match(buildStatusline(dir), /guard OFF/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildStatusline: what needs a person, what is ready, what is working; colour only when asked", () => {
  const dir = repo();
  try {
    state(dir, "--issue", "1", "--state", "Needs Me", "--reason", "SPEC_ERROR: unclear");
    assert.equal(buildStatusline(dir), "agent-flow · guard OFF · 1 needs you");
    state(dir, "--issue", "2", "--state", "Needs Me", "--reason", "review_required: x");
    state(dir, "--issue", "3", "--state", "Working", "--phase", "implement");
    state(dir, "--issue", "4", "--state", "Working", "--phase", "publish");
    state(dir, "--issue", "5", "--state", "Working", "--phase", "review");
    state(dir, "--issue", "6", "--state", "Working", "--phase", "implement");
    state(dir, "--issue", "6", "--state", "Completed");
    assert.equal(buildStatusline(dir), "agent-flow · guard OFF · 2 need you · 1 ready · 2 working", "completed issues don't count");
    const coloured = buildStatusline(dir, { color: true });
    assert.match(coloured, /\x1b\[38;5;108magent-flow\x1b\[0m/);
    assert.ok(coloured.includes("\x1b[38;5;173m2 need you\x1b[0m"));
    assert.equal(coloured.replace(/\x1b\[[0-9;]*m/g, ""), buildStatusline(dir), "the colour is the only difference");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildStatusline: an unreadable state file leaves the badge without counts, never an error", () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, ".agent-state.json"), "{ not json");
    assert.equal(buildStatusline(dir), "agent-flow · guard OFF");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("statusline (CLI): reads the workspace from the JSON Claude Code pipes in, falls back to the cwd, and ignores junk", () => {
  const dir = repo();
  const elsewhere = mkdtempSync(join(tmpdir(), "af-sl-else-"));
  try {
    state(dir, "--issue", "1", "--state", "Needs Me", "--reason", "SPEC_ERROR: x");
    const fromJson = cli(elsewhere, ["statusline"], JSON.stringify({ workspace: { project_dir: dir, current_dir: dir } }));
    assert.equal(fromJson.status, 0);
    assert.equal(fromJson.stdout, "agent-flow · guard OFF · 1 needs you");
    assert.equal(cli(elsewhere, ["statusline"], JSON.stringify({ cwd: dir })).stdout, "agent-flow · guard OFF · 1 needs you");
    assert.equal(cli(dir, ["statusline"], "").stdout, "agent-flow · guard OFF · 1 needs you", "empty input: the cwd");
    assert.equal(cli(dir, ["statusline"], "{ junk").stdout, "agent-flow · guard OFF · 1 needs you", "junk input: the cwd, no error");
    assert.equal(cli(elsewhere, ["statusline"], "{}").stdout, "", "not a repo with agent-flow: nothing at all");
    assert.equal(cli(elsewhere, ["statusline"], "{}").status, 0);
    assert.equal(JSON.parse(cli(dir, ["statusline", "--json"], "").stdout).statusline, "agent-flow · guard OFF · 1 needs you");
    // With NO_COLOR unset and a pipe (how Claude Code runs it), the badge is coloured.
    const coloured = spawnSync(process.execPath, [BIN, "statusline"], { cwd: dir, input: "", encoding: "utf-8", env: { ...process.env, NO_COLOR: "", AGENT_FLOW_ROLE: "" } });
    delete coloured.stderr;
    assert.match(coloured.stdout, /\x1b\[38;5;108m/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("statusline (CLI): a pipe that stays open with nothing on it can't hang the status bar", async () => {
  const dir = repo();
  try {
    const r = await new Promise((resolve) => {
      const t0 = Date.now();
      const child = spawn(process.execPath, [BIN, "statusline"], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      const timer = setTimeout(() => {
        child.kill();
        resolve({ code: "hung" });
      }, 10_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ code, out, ms: Date.now() - t0 });
      });
    });
    assert.equal(r.code, 0);
    assert.equal(r.out, "agent-flow · guard OFF");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install --statusline sets it only when none is set; a user's own statusLine is kept, and uninstall removes only ours", () => {
  const dir = repo();
  try {
    assert.equal(cli(dir, ["install", "--harness", "claude", "--statusline"]).status, 0);
    const path = join(dir, ".claude", "settings.json");
    let s = JSON.parse(readFileSync(path, "utf-8"));
    assert.deepEqual(s.statusLine, { type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.agent-flow-runtime/bin/agent-flow.js" statusline' });
    assert.equal(cli(dir, ["install", "--harness", "claude", "--statusline"]).status, 0, "idempotent");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")).statusLine, s.statusLine);
    // Without the flag, an existing one stays as it is (install never removes it).
    assert.equal(cli(dir, ["install", "--harness", "claude"]).status, 0);
    assert.ok(JSON.parse(readFileSync(path, "utf-8")).statusLine);

    assert.equal(cli(dir, ["uninstall", "--yes"]).status, 0);
    assert.ok(!existsSync(path), "the file held nothing else: gone, statusLine included");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const own = repo();
  try {
    mkdirSync(join(own, ".claude"), { recursive: true });
    const mine = { type: "command", command: "bash ~/my-statusline.sh" };
    writeFileSync(join(own, ".claude", "settings.json"), JSON.stringify({ statusLine: mine }));
    const r = cli(own, ["install", "--harness", "claude", "--statusline"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /a statusLine is already set, so it was left as it is/);
    assert.deepEqual(JSON.parse(readFileSync(join(own, ".claude", "settings.json"), "utf-8")).statusLine, mine);
    assert.equal(cli(own, ["uninstall", "--yes"]).status, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(own, ".claude", "settings.json"), "utf-8")), { statusLine: mine }, "their statusLine survives an uninstall");
  } finally {
    rmSync(own, { recursive: true, force: true });
  }
});

test("stripOurHooks removes a statusLine only when it runs agent-flow's statusline", () => {
  const ours = stripOurHooks({ statusLine: { type: "command", command: 'node ".agent-flow-runtime/bin/agent-flow.js" statusline' }, permissions: {} }, false);
  assert.equal(ours.removed, 1);
  assert.deepEqual(ours.config, { permissions: {} });
  const theirs = stripOurHooks({ statusLine: { type: "command", command: "bash my.sh" } }, false);
  assert.equal(theirs.removed, 0);
  assert.equal(theirs.empty, false);
  assert.equal(stripOurHooks({ statusLine: { type: "command", command: 'node ".agent-flow-runtime/bin/agent-flow.js" statusline' } }, false).empty, true);
});
