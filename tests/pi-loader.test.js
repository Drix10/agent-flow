// Integration: load the package through Pi's OWN extension loader (devDependency),
// the same path `pi install` uses — not a hand-rolled mock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

test("Pi's loader loads the manifest entry: 14 tools, guard hooks, no errors", async (t) => {
  let pi;
  try {
    pi = await import("@earendil-works/pi-coding-agent");
  } catch {
    t.skip("pi-coding-agent devDependency not installed");
    return;
  }
  const agentDir = mkdtempSync(join(tmpdir(), "af-pi-"));
  try {
    const entries = pkg.pi.extensions.map((p) => join(root, p));
    const r = await pi.discoverAndLoadExtensions(entries, root, agentDir);
    assert.deepEqual(r.errors, []);
    const tools = r.extensions.flatMap((e) => [...e.tools.keys()]);
    assert.equal(new Set(tools).size, tools.length, "duplicate tool registration");
    assert.equal(tools.length, 14);
    const hooks = r.extensions.flatMap((e) => [...e.handlers.keys()]);
    assert.ok(hooks.includes("tool_call") && hooks.includes("session_start"));
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
