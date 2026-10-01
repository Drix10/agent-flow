// The OpenCode plugin: installed with an absolute bin path, and a guard block becomes a thrown Error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));

test("install --harness opencode writes a working tool.execute.before plugin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "af-oc-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ version: "1", protected_paths: ["keep/**"] }));
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    const r = spawnSync(process.execPath, [BIN, "install", "--harness", "opencode"], { cwd: dir, encoding: "utf-8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const file = join(dir, ".opencode/plugins/agent-flow-guard.js");
    assert.ok(!existsSync(join(dir, ".opencode/package.json")), "no SDK dependency is written: the plugin imports nothing");
    assert.doesNotMatch(readFileSync(file, "utf-8"), /__AGENT_FLOW_BIN__/);
    // No npm install here: the plugin runs the vendored runtime by a path relative to itself, so any clone works.
    assert.match(readFileSync(file, "utf-8"), /new URL\("\.\.\/\.\.\/\.agent-flow-runtime\/bin\/agent-flow\.js", import\.meta\.url\)/);
    const plugin = await import(pathToFileURL(file).href);
    assert.equal(plugin.default.id, "agent-flow-guard");
    const hooks = await plugin.AgentFlowGuard({ directory: dir });
    const before = hooks["tool.execute.before"];
    await assert.rejects(before({ tool: "write" }, { args: { filePath: join(dir, "keep/x.txt"), content: "x" } }), /keep/);
    await assert.rejects(before({ tool: "bash" }, { args: { command: "rm -rf /" } }));
    await before({ tool: "write" }, { args: { filePath: join(dir, "ok.txt"), content: "x" } });

    let v2Before;
    await plugin.default.setup({
      location: { directory: dir },
      tool: { hook: async (name, callback) => { assert.equal(name, "execute.before"); v2Before = callback; } },
    });
    await assert.rejects(v2Before({ tool: "write", input: { path: join(dir, "keep/v2.txt"), content: "x" } }), /keep/);
    await assert.rejects(v2Before({ tool: "bash", input: { command: "rm -rf /" } }));
    await v2Before({ tool: "write", input: { path: join(dir, "ok-v2.txt"), content: "x" } });

    const v1 = await plugin.default.server({ directory: dir });
    await assert.rejects(v1["tool.execute.before"]({ tool: "write" }, { args: { filePath: join(dir, "keep/v1-default.txt"), content: "x" } }), /keep/);
    await v1["tool.execute.before"]({ tool: "write" }, { args: { filePath: join(dir, "ok-v1-default.txt"), content: "x" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
