// The OpenCode plugin: installed with an absolute bin path, and a guard block becomes a thrown Error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));

test("install --harness opencode writes a working tool.execute.before plugin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "af-oc-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ version: "1", protected_paths: ["keep/**"] }));
    const r = spawnSync(process.execPath, [BIN, "install", "--harness", "opencode"], { cwd: dir, encoding: "utf-8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const file = join(dir, ".opencode/plugins/agent-flow-guard.js");
    assert.doesNotMatch(readFileSync(file, "utf-8"), /__AGENT_FLOW_BIN__/);
    const hooks = await (await import(pathToFileURL(file).href)).AgentFlowGuard({ directory: dir });
    const before = hooks["tool.execute.before"];
    await assert.rejects(before({ tool: "write" }, { args: { filePath: join(dir, "keep/x.txt"), content: "x" } }), /keep/);
    await assert.rejects(before({ tool: "bash" }, { args: { command: "rm -rf /" } }));
    await before({ tool: "write" }, { args: { filePath: join(dir, "ok.txt"), content: "x" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
