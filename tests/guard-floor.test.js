// A manifest an agent has corrupted must not lower what the repo already committed: deny_read and protected paths survive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
const git = (dir, ...a) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir, encoding: "utf-8" });
const hook = (dir, tool_name, tool_input) =>
  spawnSync(process.execPath, [BIN, "guard"], { cwd: dir, encoding: "utf-8", input: JSON.stringify({ tool_name, tool_input, cwd: dir }), env: { ...process.env, AGENT_FLOW_ROLE: "", NO_COLOR: "1" } });

function repo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "af-floor-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    mkdirSync(join(dir, "secrets"));
    writeFileSync(join(dir, "secrets", "db.txt"), "x\n");
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ version: "1", default_branch: "main", protected_paths: ["migrations/"], deny_read: ["secrets/**"] }));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a corrupted manifest keeps the committed deny_read and protected paths", () => {
  repo((dir) => {
    assert.equal(hook(dir, "Bash", { command: "cat secrets/db.txt" }).status, 2, "blocked while the manifest is intact");
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), "{");
    const read = hook(dir, "Bash", { command: "cat secrets/db.txt" });
    assert.equal(read.status, 2, "a role-less `{` written over the manifest must not switch deny_read off");
    assert.match(read.stderr, /secrets/);
    const write = hook(dir, "Write", { file_path: join(dir, "migrations", "1.sql"), content: "x" });
    assert.equal(write.status, 2, "protected paths still protected");
  });
});

test("a corrupted manifest still allows ordinary reads and the write that repairs it", () => {
  repo((dir) => {
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), "{");
    assert.equal(hook(dir, "Bash", { command: "ls" }).status, 0);
    assert.equal(hook(dir, "Write", { file_path: join(dir, "CONTEXT_MANIFEST.json"), content: "{}" }).status, 0, "fixing the manifest is how you get out");
  });
});

// The hook registration is protected in every repo, with or without protected_paths, and no override lifts it.
import { decide } from "../extensions/lib/guard.js";
const wired = (input, extra = {}, toolName = "Write") => decide({ role: null, toolName, input, cwd: "/repo", root: "/repo", manifest: { default_branch: "main" }, ...extra });

test("guard wiring is protected without protected_paths and survives AGENT_FLOW_ALLOW_PROTECTED", () => {
  for (const f of [".claude/settings.json", ".claude/settings.local.json", ".codex/hooks.json", ".gemini/settings.json", ".cursor/hooks.json", ".pi/settings.json", "opencode.json", ".opencode/plugins/agent-flow-guard.js"]) {
    assert.equal(wired({ file_path: `/repo/${f}`, content: "{}" })?.rule, "guard-wiring", f);
    assert.equal(wired({ file_path: `/repo/${f}`, content: "{}" }, { allowProtected: true })?.rule, "guard-wiring", `${f} with the override`);
  }
  assert.equal(wired({ command: "echo '{}' > .claude/settings.json" }, {}, "Bash")?.rule, "guard-wiring");
  assert.equal(wired({ file_path: "/repo/src/a.ts", content: "x" }), null, "ordinary files are untouched");
});
