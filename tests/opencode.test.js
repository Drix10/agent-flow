// The OpenCode plugin: installed with an absolute bin path, and a guard block becomes a thrown Error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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
    writeFileSync(join(dir, ".opencode/package.json"), JSON.stringify({ name: "probe", dependencies: { "existing-package": "1.2.3" } }));
    const sdk = join(dir, ".opencode/node_modules/@opencode/plugin");
    mkdirSync(sdk, { recursive: true });
    writeFileSync(join(sdk, "package.json"), JSON.stringify({ name: "@opencode/plugin", type: "module", exports: "./index.js" }));
    writeFileSync(join(sdk, "index.js"), 'export const Plugin = { define: (plugin) => ({ ...plugin, sdkDefined: true }) };\n');
    const r = spawnSync(process.execPath, [BIN, "install", "--harness", "opencode"], { cwd: dir, encoding: "utf-8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const file = join(dir, ".opencode/plugins/agent-flow-guard.js");
    const pkg = JSON.parse(readFileSync(join(dir, ".opencode/package.json"), "utf-8"));
    assert.equal(pkg.dependencies["existing-package"], "1.2.3");
    assert.equal(pkg.dependencies["@opencode/plugin"], "^2.0.20");
    assert.doesNotMatch(readFileSync(file, "utf-8"), /__AGENT_FLOW_BIN__/);
    const plugin = await import(pathToFileURL(file).href);
    assert.equal(plugin.default.sdkDefined, true);
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
    await assert.rejects(v2Before({ tool: "write", input: { filePath: join(dir, "keep/v2.txt"), content: "x" } }), /keep/);
    await assert.rejects(v2Before({ tool: "bash", input: { command: "rm -rf /" } }));
    await v2Before({ tool: "write", input: { filePath: join(dir, "ok-v2.txt"), content: "x" } });

    const v1 = await plugin.default.server({ directory: dir });
    await assert.rejects(v1["tool.execute.before"]({ tool: "write" }, { args: { filePath: join(dir, "keep/v1-default.txt"), content: "x" } }), /keep/);
    await v1["tool.execute.before"]({ tool: "write" }, { args: { filePath: join(dir, "ok-v1-default.txt"), content: "x" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
