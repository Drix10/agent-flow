// The stop gate holds an interactive session back while on_stop gates fail, at most N times per turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprint } from "../extensions/lib/stopgate.js";
import { localInstall } from "./helpers.js";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
const git = (d, ...a) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: d, encoding: "utf-8" });
const stop = (d, active = false) =>
  spawnSync(process.execPath, [BIN, "gates", "stop"], { cwd: d, encoding: "utf-8", input: JSON.stringify({ cwd: d, stop_hook_active: active }), env: { ...process.env, NO_COLOR: "1", AGENT_FLOW_ROLE: "" } });
const audit = (d) => readFileSync(join(d, ".agent-flow", "audit.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** A repo whose committed manifest has one on_stop gate that fails while `bad` exists. */
function repo(extra, fn) {
  const dir = mkdtempSync(join(tmpdir(), "af-stop-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    const gate = { name: "lint", command: [process.execPath, "-e", "process.exit(require('fs').existsSync('bad') ? 1 : 0)"], on_stop: true };
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ version: "1", protected_paths: [], gates: [gate, { name: "slow", command: [process.execPath, "-e", "process.exit(1)"] }], ...extra }));
    writeFileSync(join(dir, ".gitignore"), ".agent-flow/\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a failing on_stop gate blocks twice, the third stop passes, and stop_gate_exhausted is audited", () => {
  repo({}, (dir) => {
    writeFileSync(join(dir, "bad"), "x");
    const a = stop(dir, false);
    assert.equal(a.status, 2);
    assert.match(a.stderr, /Stop gate \(1\/2\).*lint/s);
    assert.equal(stop(dir, true).status, 2);
    const c = stop(dir, true);
    assert.equal(c.status, 0);
    assert.match(c.stderr, /still failing after 2 block/);
    const ev = audit(dir).map((e) => e.event);
    assert.equal(ev.filter((e) => e === "stop_gate_blocked").length, 2);
    assert.ok(ev.includes("stop_gate_exhausted"));
  });
});

test("only on_stop gates run; a fresh turn (stop_hook_active false) restarts the count", () => {
  repo({ pipeline: { max_stop_blocks: 1 } }, (dir) => {
    writeFileSync(join(dir, "bad"), "x");
    assert.equal(stop(dir, false).status, 2);
    assert.equal(stop(dir, true).status, 0); // exhausted after 1
    assert.equal(stop(dir, false).status, 2); // new turn: blocked again
    assert.ok(!audit(dir).some((e) => e.gate === "slow"), "the non-on_stop gate never ran");
  });
});

test("a passing gate lets the stop through, and an unchanged tree isn't re-run", () => {
  repo({}, (dir) => {
    assert.equal(stop(dir).status, 0);
    const runs = () => audit(dir).filter((e) => e.event === "gate_run").length;
    assert.equal(runs(), 1);
    assert.equal(stop(dir).status, 0);
    assert.equal(runs(), 1, "chat-only turn: no gate run");
    writeFileSync(join(dir, "new.txt"), "changed");
    assert.equal(stop(dir).status, 0);
    assert.equal(runs(), 2);
  });
});

test("the gate is the committed one: a working-copy edit that removes it doesn't", () => {
  repo({}, (dir) => {
    writeFileSync(join(dir, "bad"), "x");
    const m = JSON.parse(readFileSync(join(dir, "CONTEXT_MANIFEST.json"), "utf-8"));
    m.gates = [];
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify(m));
    assert.equal(stop(dir, false).status, 2);
  });
});

test("no on_stop gates, a role process and a broken hook input all let the stop through", () => {
  repo({}, (dir) => {
    writeFileSync(join(dir, "bad"), "x");
    const r = spawnSync(process.execPath, [BIN, "gates", "stop"], { cwd: dir, encoding: "utf-8", input: "not json", env: { ...process.env, AGENT_FLOW_ROLE: "implementer" } });
    assert.equal(r.status, 0);
  });
  const dir = mkdtempSync(join(tmpdir(), "af-stop-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ version: "1", protected_paths: [], gates: [{ name: "a", command: "exit 1" }] }));
    assert.equal(stop(dir).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the fingerprint ignores agent-flow's own files and changes with content", () => {
  repo({}, (dir) => {
    const a = fingerprint(dir);
    writeFileSync(join(dir, ".agent-state.json"), "{}");
    assert.equal(fingerprint(dir), a);
    writeFileSync(join(dir, "f.txt"), "1");
    const b = fingerprint(dir);
    assert.notEqual(b, a);
    writeFileSync(join(dir, "f.txt"), "2");
    assert.notEqual(fingerprint(dir), b);
  });
});

test("install --stop-gate adds a Stop hook next to the guard, idempotently", () => {
  repo({}, (dir) => {
    const li = localInstall(dir);
    const run = () => li(dir, "install", "--harness", "claude", "--stop-gate");
    run();
    const first = readFileSync(join(dir, ".claude", "settings.json"), "utf-8");
    const s = JSON.parse(first);
    assert.match(s.hooks.Stop[0].hooks[0].command, /gates stop$/);
    run();
    assert.equal(readFileSync(join(dir, ".claude", "settings.json"), "utf-8"), first);
  });
});
