// doctor: an always-loaded context file past the budget is named (a warning, never a failure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
const cli = (cwd, ...a) => spawnSync(process.execPath, [BIN, ...a], { cwd, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1", AGENT_FLOW_OFFLINE: "1", AGENT_FLOW_ROLE: "" } });

function repo(agents) {
  const dir = mkdtempSync(join(tmpdir(), "af-weight-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "AGENTS.md"), agents);
  return dir;
}

test("doctor names a context file over the line budget and still exits 0", () => {
  const dir = repo(`# Rules\n${"- keep it small\n".repeat(200)}`);
  const r = cli(dir, "doctor");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /context files over 150 lines/);
  assert.match(r.stdout, /AGENTS\.md\s+20\d lines, about \d+ tokens/);
  const j = JSON.parse(cli(dir, "doctor", "--json").stdout);
  assert.equal(j.context_weight[0].file, "AGENTS.md");
  assert.equal(j.context_weight[0].heavy, true);
});

test("doctor says nothing about a short context file", () => {
  const dir = repo("# Rules\n- run `npm test`\n");
  const r = cli(dir, "doctor");
  assert.doesNotMatch(r.stdout, /context files over/);
  assert.equal(JSON.parse(cli(dir, "doctor", "--json").stdout).context_weight[0].heavy, false);
});
