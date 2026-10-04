// A hook whose stdin never closes (a wrapper swallowed the piped JSON) must not hang until the harness kills it:
// a killed hook lets the tool call through. The guard waits a bounded time and then refuses wherever protection is wanted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));

function repo(manifest) {
  const dir = mkdtempSync(join(tmpdir(), "af-stdin-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  if (manifest) writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ version: "2", context_files: [], ...manifest }));
  return dir;
}

/** Runs the CLI with a stdin that is never written to or closed; resolves with the exit code and how long it took. */
function stuck(dir, args, env = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [BIN, ...args], { cwd: dir, env: { ...process.env, NO_COLOR: "1", AGENT_FLOW_HOOK_STDIN_MS: "300", AGENT_FLOW_ROLE: "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    const guard = setTimeout(() => {
      child.kill();
      resolve({ code: "hung", stderr, ms: Date.now() - t0 });
    }, 15_000);
    child.on("exit", (code) => {
      clearTimeout(guard);
      resolve({ code, stderr, ms: Date.now() - t0 });
    });
  });
}

test("guard: stdin that never closes is refused for a role, and for a repo with protection configured", async () => {
  const configured = repo({ protected_paths: ["secret/**"] });
  try {
    const role = await stuck(configured, ["guard"], { AGENT_FLOW_ROLE: "implementer" });
    assert.equal(role.code, 2, role.stderr);
    assert.match(role.stderr, /no hook input arrived on stdin/);
    assert.ok(role.ms < 10_000, `took ${role.ms}ms`);
    const bare = await stuck(configured, ["guard"]);
    assert.equal(bare.code, 2, "a repo whose manifest wants protection refuses a call it can't check");
  } finally {
    rmSync(configured, { recursive: true, force: true });
  }
});

test("guard: stdin that never closes does not brick a session with no protection and no role", async () => {
  const plain = repo(null);
  try {
    const r = await stuck(plain, ["guard"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /no hook input/);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

test("guard: ordinary input is unaffected, empty input still means no tool call, and a blocked call still exits 2", () => {
  const dir = repo({ protected_paths: ["secret/**"] });
  try {
    const run = (input) => spawnSync(process.execPath, [BIN, "guard"], { cwd: dir, input, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1", AGENT_FLOW_ROLE: "" } });
    assert.equal(run(JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(dir, "ok.txt"), content: "x" }, cwd: dir })).status, 0);
    assert.equal(run(JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(dir, "secret", "k.txt"), content: "x" }, cwd: dir })).status, 2);
    assert.equal(run("").status, 0, "an empty, closed stdin is a call with nothing in it");
    assert.equal(run("{not json").status, 2, "unreadable input still refuses where protection is configured");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gates stop: a Stop hook whose stdin never closes lets the stop through instead of hanging", async () => {
  const dir = repo({ protected_paths: [], gates: [{ name: "t", command: "true", on_stop: true }] });
  try {
    const r = await stuck(dir, ["gates", "stop"]);
    assert.notEqual(r.code, "hung");
    assert.equal(r.code, 0, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
