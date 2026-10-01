// Gates: the pipeline runs the command and records the exit code, so a pass is not a model's claim about output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gatesOf, runGates } from "../extensions/lib/gates.js";
import { validateManifest } from "../extensions/lib/manifest.js";
import { roleMayRunCli } from "../extensions/lib/guard.js";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
const node = (code) => [process.execPath, "-e", code];
const tmp = () => mkdtempSync(join(tmpdir(), "af-gates-"));
const cli = (dir, ...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1", AGENT_FLOW_ROLE: "" } });
const withRepo = (gates, fn) => {
  const dir = tmp();
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ version: "1", protected_paths: [], gates }));
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("a passing and a failing gate are judged by exit code, with a log whose hash matches", () => {
  const dir = tmp();
  try {
    const r = runGates(dir, [
      { name: "pass", command: node("console.log('fine')") },
      { name: "fail", command: node("console.error('boom'); process.exit(3)") },
    ]);
    assert.equal(r.ok, false);
    const [p, f] = r.results;
    assert.deepEqual([p.ok, p.exit_code, f.ok, f.exit_code], [true, 0, false, 3]);
    const log = readFileSync(join(dir, f.log), "utf-8");
    assert.match(log, /boom/);
    assert.equal(createHash("sha256").update(log).digest("hex"), f.log_sha256);
    assert.equal(JSON.parse(readFileSync(join(dir, r.report), "utf-8")).results.length, 2);
    const audit = readFileSync(join(dir, ".agent-flow", "audit.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(audit.map((a) => [a.event, a.gate, a.ok]), [["gate_run", "pass", true], ["gate_run", "fail", false]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expect_exit, required:false and timeouts", () => {
  const dir = tmp();
  try {
    const r = runGates(dir, [
      { name: "expects-1", command: node("process.exit(1)"), expect_exit: 1 },
      { name: "advisory", command: node("process.exit(1)"), required: false },
      { name: "slow", command: node("setTimeout(()=>{}, 30000)"), timeout_seconds: 1, required: false },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.results[0].ok, true);
    assert.equal(r.results[1].ok, false);
    assert.equal(r.results[2].timed_out, true);
    assert.equal(r.environment_error, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a command that cannot run is an environment error, not a test failure", () => {
  const dir = tmp();
  try {
    const r = runGates(dir, [{ name: "nope", command: ["definitely-not-a-binary-af"] }]);
    assert.equal(r.ok, false);
    assert.equal(r.environment_error, true);
    assert.match(r.results[0].error, /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gate cwd can't leave the checkout, and an unknown --name is an error", () => {
  const dir = tmp();
  try {
    const r = runGates(dir, [{ name: "esc", command: node("0"), cwd: "../.." }]);
    assert.equal(r.results[0].ok, false);
    assert.ok(r.results[0].error);
    assert.throws(() => runGates(dir, [{ name: "a", command: node("0") }], { only: ["b"] }), /no such gate: b/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gatesOf drops malformed and duplicate entries; validateManifest names them", () => {
  const man = { gates: [{ name: "ok", command: "echo 1" }, { name: "ok", command: "echo 2" }, { name: "bad name", command: "x" }, { name: "empty", command: [] }, 7] };
  assert.deepEqual(gatesOf(man).map((g) => g.name), ["ok"]);
  const problems = validateManifest({ version: "1", protected_paths: [], ...man });
  assert.ok(JSON.stringify(problems).includes("gates["));
});

test("CLI: list, run, exit codes, --name, --json", () => {
  withRepo([
    { name: "good", command: node("console.log('x')") },
    { name: "bad", command: node("process.exit(1)") },
  ], (dir) => {
    assert.match(cli(dir, "gates", "list").stdout, /good/);
    assert.equal(cli(dir, "gates", "run", "--name", "good").status, 0);
    const bad = cli(dir, "gates", "run", "--json");
    assert.equal(bad.status, 1);
    assert.equal(JSON.parse(bad.stdout).results.length, 2);
    const unk = cli(dir, "gates", "run", "--name", "zzz");
    assert.equal(unk.status, 2);
    assert.match(unk.stderr, /no such gate/);
  });
  withRepo([{ name: "ghost", command: ["definitely-not-a-binary-af"] }], (dir) => assert.equal(cli(dir, "gates", "run").status, 2));
  withRepo(undefined, (dir) => assert.equal(cli(dir, "gates", "run").status, 2));
});

test("read-only roles can't run gates; the orchestrator can", () => {
  assert.match(roleMayRunCli("qa", ["gates", "run"]), /orchestrator/);
  assert.match(roleMayRunCli("reviewer", ["gates", "run", "--json"]), /gates run/);
  assert.equal(roleMayRunCli("qa", ["gates", "list"]), null);
  assert.equal(roleMayRunCli("orchestrator", ["gates", "run"]), null);
  assert.equal(roleMayRunCli(null, ["gates", "run"]), null);
});

test("a gate whose `os` excludes this machine is skipped and says so, never run and never a silent pass", () => {
  const other = process.platform === "linux" ? "darwin" : "linux";
  const dir = tmp();
  try {
    const r = runGates(dir, [
      { name: "here", command: node("process.exit(0)"), os: [process.platform] },
      { name: "elsewhere", command: node("process.exit(9)"), os: [other] },
    ]);
    assert.equal(r.ok, true);
    const [h, e] = r.results;
    assert.equal(h.skipped, undefined);
    assert.equal(e.exit_code, null, "never ran");
    assert.match(e.skipped, new RegExp(`runs on ${other}, this is ${process.platform}`));
    const audit = readFileSync(join(dir, ".agent-flow", "audit.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(audit.map((a) => a.event), ["gate_run", "gate_skipped"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(validateManifest({ version: "2", gates: [{ name: "k", command: "x", os: ["plan9"] }] }).some((p) => /os must be/.test(p)));
});

test("string gates run in a POSIX shell, and the shell failing to start the command is an environment error", () => {
  withRepo([
    { name: "posix", command: "for i in 1 2; do test $i -gt 0 || exit 1; done && [ -n \"$AGENT_FLOW_GATE\" ]" },
    { name: "missing", command: "./no-such-script.sh" },
  ], (dir) => {
    const r = runGates(dir, gatesOf(JSON.parse(readFileSync(join(dir, "CONTEXT_MANIFEST.json"), "utf-8"))));
    assert.equal(r.results[0].ok, true, readFileSync(join(dir, r.results[0].log), "utf-8"));
    assert.equal(r.results[1].ok, false);
    assert.match(r.results[1].error ?? "", /not runnable here/);
    assert.equal(r.environment_error, true);
  });
});

test("dash's `not found` is an environment error too, not a failing test", () => {
  const dir = tmp();
  try {
    const r = runGates(dir, [{ name: "nope", command: "definitely-not-a-real-command-xyz" }]);
    assert.equal(r.results[0].ok, false);
    assert.match(r.results[0].error ?? "", /not runnable here|can't run this command/);
    assert.equal(r.environment_error, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a command that exits as expected is never an environment error, whatever it prints", () => {
  const dir = tmp();
  try {
    const r = runGates(dir, [{ name: "ok", command: node("console.log('x is not recognized as an internal or external command')") }]);
    assert.equal(r.results[0].ok, true);
    assert.equal(r.environment_error, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a gate with cwd \".\" runs in the checkout itself", () => {
  const dir = tmp();
  try {
    for (const cwd of [".", "./"]) {
      const r = runGates(dir, [{ name: "here", command: node("process.exit(require('fs').existsSync('marker') ? 0 : 3)"), cwd }]);
      writeFileSync(join(dir, "marker"), "x");
      const again = runGates(dir, [{ name: "here", command: node("process.exit(require('fs').existsSync('marker') ? 0 : 3)"), cwd }]);
      assert.equal(again.results[0].error, undefined, again.results[0].error);
      assert.equal(again.results[0].ok, true);
      assert.equal(r.results[0].error, undefined);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
