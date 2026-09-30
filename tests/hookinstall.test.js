// install --harness gemini|codex|cursor wires the guard hook, keeps other hooks, is idempotent; Cursor's event shapes are understood.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(PKG, "bin/agent-flow.js");

function proj(fn) {
  const dir = mkdtempSync(join(tmpdir(), "af-hook-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ version: "1", protected_paths: ["keep/**"] }));
    mkdirSync(join(dir, "node_modules/@drix10"), { recursive: true });
    // A real copy: pkgRoot is realpath'd, so a symlink into the checkout would look like "not installed here".
    for (const f of ["bin", "extensions", "skills", "templates", "schemas", ".codex", ".gemini", "package.json"]) cpSync(join(PKG, f), join(dir, "node_modules/@drix10/agent-flow", f), { recursive: true });
    return fn(dir, (...a) => spawnSync(process.execPath, [join(dir, "node_modules/@drix10/agent-flow/bin/agent-flow.js"), ...a], { cwd: dir, encoding: "utf-8" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const guard = (dir, ev) => spawnSync(process.execPath, [BIN, "guard"], { cwd: dir, input: JSON.stringify(ev), encoding: "utf-8" });

test("gemini and codex: hook written in place, other hooks kept, idempotent", () => {
  for (const [h, file, ev] of [["gemini", ".gemini/settings.json", "BeforeTool"], ["codex", ".codex/hooks.json", "PreToolUse"]]) {
    proj((dir, cli) => {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), JSON.stringify({ theme: "x", hooks: { [ev]: [{ matcher: "z", hooks: [{ type: "command", command: "echo mine" }] }] } }));
      assert.equal(cli("install", "--harness", h).status, 0);
      const first = readFileSync(join(dir, file), "utf-8");
      const j = JSON.parse(first);
      assert.equal(j.theme, "x");
      assert.equal(j.hooks[ev].length, 2);
      assert.match(JSON.stringify(j.hooks[ev]), /echo mine/);
      assert.match(JSON.stringify(j.hooks[ev]), /agent-flow.*guard/);
      cli("install", "--harness", h);
      assert.equal(readFileSync(join(dir, file), "utf-8"), first);
    });
  }
});

test("cursor: three fail-closed events, and its tool-less payloads are guarded", () => {
  proj((dir, cli) => {
    assert.equal(cli("install", "--harness", "cursor").status, 0);
    const j = JSON.parse(readFileSync(join(dir, ".cursor/hooks.json"), "utf-8"));
    assert.equal(j.version, 1);
    for (const e of ["beforeShellExecution", "beforeReadFile", "preToolUse"]) assert.equal(j.hooks[e][0].failClosed, true);
    assert.equal(guard(dir, { command: "rm -rf keep", cwd: dir }).status, 2);
    assert.equal(guard(dir, { command: "ls", cwd: dir }).status, 0);
    assert.equal(guard(dir, { file_path: join(dir, ".env"), cwd: dir }).status, guard(dir, { tool_name: "Read", tool_input: { file_path: join(dir, ".env") }, cwd: dir }).status);
  });
});

test("codex-style payloads: exec_command is a shell, apply_patch a write", () => {
  proj((dir) => {
    assert.equal(guard(dir, { tool_name: "exec_command", tool_input: { cmd: "rm -rf keep" }, cwd: dir }).status, 2);
    assert.equal(guard(dir, { tool_name: "run_shell_command", tool_input: { command: "rm -rf keep" }, cwd: dir }).status, 2);
    assert.equal(guard(dir, { tool_name: "write_file", tool_input: { file_path: join(dir, "keep/a.txt"), content: "x" }, cwd: dir }).status, 2);
  });
});
