// Fixes from reading each vendor's hook docs: Gemini matches every tool, Cursor's Windows BOM, Cursor's Delete tool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), "af-vd-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ version: "1", protected_paths: ["keep/**"] }));
  mkdirSync(join(dir, "keep"));
  return dir;
};
const guard = (dir, payload, prefix = "") => spawnSync(process.execPath, [BIN, "guard"], { cwd: dir, input: prefix + JSON.stringify(payload), encoding: "utf-8" });

test("a BOM on stdin (Cursor on Windows) doesn't turn a deny into an allow", () => {
  const dir = repo();
  try {
    const p = { command: "echo x > keep/a.txt", cwd: dir };
    assert.equal(guard(dir, p, "﻿").status, 2);
    assert.equal(guard(dir, { command: "echo x > ok.txt", cwd: dir }, "﻿").status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Cursor's Delete tool is a write to its path", () => {
  const dir = repo();
  try {
    const r = guard(dir, { hook_event_name: "preToolUse", tool_name: "Delete", tool_input: { path: join(dir, "keep/a.txt") }, cwd: dir });
    assert.equal(r.status, 2, r.stderr);
    assert.equal(guard(dir, { hook_event_name: "preToolUse", tool_name: "Delete", tool_input: { path: join(dir, "ok.txt") }, cwd: dir }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install --harness gemini matches every tool, so renamed tools stay covered", () => {
  const dir = repo();
  try {
    mkdirSync(join(dir, "node_modules/@drix10"), { recursive: true });
    const PKG = join(BIN, "../..");
    for (const f of ["bin", "extensions", "skills", "templates", "schemas", ".codex", ".gemini", "package.json"]) cpSync(join(PKG, f), join(dir, "node_modules/@drix10/agent-flow", f), { recursive: true });
    const r = spawnSync(process.execPath, [join(dir, "node_modules/@drix10/agent-flow/bin/agent-flow.js"), "install", "--harness", "gemini"], { cwd: dir, encoding: "utf-8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const cfg = JSON.parse(readFileSync(join(dir, ".gemini/settings.json"), "utf-8"));
    assert.equal(cfg.hooks.BeforeTool[0].matcher, undefined);
    assert.match(cfg.hooks.BeforeTool[0].hooks[0].command, /guard$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
