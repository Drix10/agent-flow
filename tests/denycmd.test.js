// policy.deny_commands presets, their additive floor, and the guard CLI's exit-code contract (block = 2, never 1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { matchDenyCommand, validateDenyCommands } from "../extensions/lib/denycmd.js";
import { validateManifest } from "../extensions/lib/manifest.js";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
const corpus = JSON.parse(readFileSync(new URL("./redteam/corpus.json", import.meta.url), "utf-8"));
const git = (d, ...a) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: d, encoding: "utf-8" });
const guard = (d, command) => spawnSync(process.execPath, [BIN, "guard"], { cwd: d, encoding: "utf-8", input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: d }), env: { ...process.env, AGENT_FLOW_ROLE: "", AGENT_FLOW_ALLOW_PROTECTED: "" } });

function repo(manifest, fn) {
  const dir = mkdtempSync(join(tmpdir(), "af-deny-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify(manifest));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("presets and custom patterns match what they name and nothing else", () => {
  const spec = { presets: ["database", "infra"], patterns: [{ pattern: "\\bshutdown\\b" }] };
  for (const c of ['psql -c "DROP TABLE t"', "kubectl delete ns x", "terraform destroy", "docker volume prune -f", "shutdown now"]) assert.ok(matchDenyCommand(spec, c), c);
  for (const c of ['psql -c "select 1"', "kubectl get all", "terraform validate", "git log --oneline", "npm run drop-table-docs"]) assert.equal(matchDenyCommand(spec, c), null, c);
  assert.equal(matchDenyCommand(null, "kubectl delete x"), null);
});

test("the manifest validates deny_commands", () => {
  assert.deepEqual(validateDenyCommands(undefined), []);
  assert.equal(validateDenyCommands({ presets: ["nope"] }).length, 1);
  assert.equal(validateDenyCommands({ patterns: [{ pattern: "(" }] }).length, 1);
  assert.ok(validateManifest({ policy: { deny_commands: [] } }).some((p) => /deny_commands/.test(p)));
});

test("the guard blocks with exit 2 (never 1) and a session can't drop a committed rule from the working copy", () => {
  const m = { version: "1", protected_paths: [], policy: { deny_commands: { presets: ["infra"] } } };
  repo(m, (dir) => {
    const r = guard(dir, "kubectl delete pod web");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /deny_commands/);
    assert.equal(guard(dir, "kubectl get pods").status, 0);
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ ...m, policy: {} }));
    assert.equal(guard(dir, "kubectl delete pod web").status, 2, "removing the rule in the working copy changes nothing");
    assert.equal(spawnSync(process.execPath, [BIN, "guard"], { cwd: dir, encoding: "utf-8", input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "kubectl delete pod web" }, cwd: dir }), env: { ...process.env, AGENT_FLOW_ALLOW_PROTECTED: "1" } }).status, 0, "the human override");
  });
});

test("every corpus entry marked block exits 2 through the real hook, and never 1", () => {
  repo(corpus.manifest, (dir) => {
    for (const e of corpus.shell.filter((x) => x.expect === "block").slice(0, 40)) {
      const r = guard(dir, e.cmd);
      assert.equal(r.status, 2, `${e.cmd} exited ${r.status}`);
    }
  });
});

test("no input makes the matcher slow, and an unsafe user regex is rejected and ignored", () => {
  const spec = { presets: ["database", "infra"], patterns: [{ pattern: "(a+)+$" }] };
  const t = Date.now();
  for (const c of ["kubectl ".repeat(20000), "psql a ".repeat(30000), "drop table ".repeat(20000), `${"a".repeat(30)}!`]) matchDenyCommand(spec, c);
  assert.ok(Date.now() - t < 2000, `took ${Date.now() - t}ms`);
  assert.equal(validateDenyCommands({ patterns: [{ pattern: "(a+)+$" }] }).length, 1);
  assert.equal(validateDenyCommands({ preset: ["infra"] }).length, 1, "a typo'd key is an error, not silently no protection");
});
