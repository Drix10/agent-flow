// The audit log is a hash chain: these tests are the evidence for "tamper-evident" (and for what that does not mean).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendAudit } from "../extensions/lib/state.js";
import { summarizeAudit, verifyAudit } from "../extensions/lib/audit.js";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
const STATE = pathToFileURL(fileURLToPath(new URL("../extensions/lib/state.js", import.meta.url))).href;
const tmp = () => mkdtempSync(join(tmpdir(), "af-audit-"));
const logPath = (dir) => join(dir, ".agent-flow", "audit.jsonl");
const lines = (dir) => readFileSync(logPath(dir), "utf-8").split("\n").filter(Boolean);
const write = (dir, ls) => writeFileSync(logPath(dir), ls.join("\n") + "\n");
const seed = (dir, n = 4) => {
  for (let i = 1; i <= n; i++) appendAudit(dir, { event: "guard_block", role: i % 2 ? "reviewer" : "qa", rule: i % 2 ? "read-only-role" : "protected-path", i });
};

test("an untouched log verifies, and every line links to the one before it", () => {
  const dir = tmp();
  try {
    seed(dir);
    const v = verifyAudit(dir);
    assert.equal(v.ok, true);
    assert.deepEqual([v.lines, v.chained, v.legacy, v.unchained], [4, 4, 0, 0]);
    const ls = lines(dir).map((l) => JSON.parse(l));
    assert.equal(ls[0].prev, "genesis");
    for (let i = 1; i < ls.length; i++) assert.equal(ls[i].prev, ls[i - 1].hash);
    assert.equal(v.head, ls[3].hash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an edited, deleted, inserted or reordered line is reported, at the right line", () => {
  const dir = tmp();
  try {
    seed(dir, 5);
    const original = lines(dir);

    write(dir, original.map((l, i) => (i === 2 ? l.replace('"i":3', '"i":99') : l)));
    assert.deepEqual(verifyAudit(dir).broken, { line: 3, reason: "its content no longer matches its hash (the line was edited)" });

    write(dir, original.filter((_, i) => i !== 1));
    assert.equal(verifyAudit(dir).broken.line, 2);
    assert.match(verifyAudit(dir).broken.reason, /removed, inserted or reordered/);

    write(dir, [original[0], original[2], original[1], ...original.slice(3)]);
    assert.equal(verifyAudit(dir).ok, false);

    const forged = JSON.stringify({ at: "2026-01-01T00:00:00Z", event: "guard_block", role: "qa", rule: "x", prev: JSON.parse(original[1]).hash, hash: "0".repeat(64) });
    write(dir, [original[0], original[1], forged, ...original.slice(2)]);
    assert.equal(verifyAudit(dir).broken.line, 3);

    write(dir, original.slice(0, 3));
    assert.equal(verifyAudit(dir).ok, true, "truncating the tail is invisible without an anchor");
    write(dir, original);
    assert.equal(verifyAudit(dir).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an anchor proves history up to that point is unchanged: truncation and rewriting are then caught", () => {
  const dir = tmp();
  try {
    seed(dir, 3);
    const anchor = verifyAudit(dir).head;
    seed(dir, 2);
    assert.deepEqual(verifyAudit(dir, { anchor }).anchor, { hash: anchor, found: true, line: 3 });
    assert.equal(verifyAudit(dir, { anchor }).ok, true);

    const all = lines(dir);
    write(dir, all.slice(0, 2));
    assert.equal(verifyAudit(dir, { anchor }).ok, false, "the anchored line was cut off");
    assert.equal(verifyAudit(dir, { anchor }).anchor.found, false);

    // A writer who recomputes the whole chain (the limit of tamper-EVIDENT) still can't reproduce the anchored hash.
    write(dir, []);
    for (const [i, l] of all.entries()) {
      const e = JSON.parse(l);
      appendAudit(dir, { event: e.event, role: e.role, rule: e.rule, i: i === 1 ? 999 : e.i });
    }
    assert.equal(verifyAudit(dir).ok, true, "a rewritten chain is internally consistent");
    assert.equal(verifyAudit(dir, { anchor }).ok, false, "but it no longer contains the anchored hash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lines from before chaining are legacy; unchained lines after the chain started are counted, and garbage is a break", () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, ".agent-flow"));
    writeFileSync(logPath(dir), JSON.stringify({ at: "2026-01-01T00:00:00Z", event: "old" }) + "\n" + JSON.stringify({ at: "2026-01-02T00:00:00Z", event: "old2" }) + "\n");
    appendAudit(dir, { event: "new" });
    const v = verifyAudit(dir);
    assert.deepEqual([v.ok, v.legacy, v.chained, v.unchained], [true, 2, 1, 0]);
    appendFileSync(logPath(dir), JSON.stringify({ at: "x", event: "sneaked in" }) + "\n");
    const w = verifyAudit(dir);
    assert.deepEqual([w.ok, w.unchained], [true, 1]);
    appendFileSync(logPath(dir), "not json\n");
    assert.equal(verifyAudit(dir).broken.reason, "not valid JSON");
    assert.deepEqual(verifyAudit(tmp()), { ok: true, lines: 0, chained: 0, legacy: 0, unchained: 0, head: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parallel writers keep one intact chain", async () => {
  const dir = tmp();
  try {
    const code = `import { appendAudit } from ${JSON.stringify(STATE)}; for (let i = 0; i < 15; i++) appendAudit(process.argv[1], { event: "guard_block", role: "qa", rule: "r", p: process.pid, i });`;
    await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", code, dir], { stdio: "ignore" });
      p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`writer exited ${c}`))));
    })));
    const v = verifyAudit(dir);
    assert.equal(v.lines, 120);
    assert.equal(v.ok, true, JSON.stringify(v.broken));
    assert.equal(v.chained, 120);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit summary counts blocks per role and rule, escalations, rounds per issue and role runs", () => {
  const dir = tmp();
  try {
    appendAudit(dir, { event: "guard_block", role: "reviewer", rule: "read-only-role" });
    appendAudit(dir, { event: "guard_block", role: "reviewer", rule: "read-only-role" });
    appendAudit(dir, { event: "guard_block", role: "implementer", rule: "protected-path" });
    appendAudit(dir, { event: "state_transition", issue: 7, from: null, to: "Working", round: 1 });
    appendAudit(dir, { event: "state_transition", issue: 7, from: "Working", to: "Needs Me", round: 3, reason: "max_rounds_exceeded: round 3 exceeds limit 2" });
    appendAudit(dir, { event: "role_run", role: "qa", ok: true, cost_usd: 0.25 });
    appendAudit(dir, { event: "role_run", role: "qa", ok: false, cost_usd: 0.5 });
    const s = summarizeAudit(dir);
    assert.equal(s.entries, 7);
    assert.deepEqual(s.guard_blocks, { total: 3, by_role: { reviewer: 2, implementer: 1 }, by_rule: { "read-only-role": 2, "protected-path": 1 } });
    assert.deepEqual(s.issues, [{ issue: 7, state: "Needs Me", round: 3 }]);
    assert.equal(s.escalations[0].issue, 7);
    assert.deepEqual([s.role_runs.total, s.role_runs.ok, s.role_runs.failed, s.role_runs.cost_usd], [2, 1, 1, 0.75]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: audit verify exits 1 on a broken chain or a missing anchor, head prints the anchor, summary runs", () => {
  const dir = tmp();
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    const run = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "" } });
    seed(dir, 3);
    const head = run("audit", "head").stdout.trim();
    assert.match(head, /^[0-9a-f]{64}$/);
    assert.equal(run("audit", "verify").status, 0);
    assert.equal(run("audit", "verify", "--anchor", head).status, 0);
    assert.equal(run("audit", "verify", "--anchor", "f".repeat(64)).status, 1);
    assert.equal(JSON.parse(run("audit", "summary", "--json").stdout).entries, 3);
    write(dir, lines(dir).map((l, i) => (i === 1 ? l.replace('"i":2', '"i":5') : l)));
    const bad = run("audit", "verify");
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /broken at line 2/);
    assert.equal(run("audit", "nope").status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unchained line (lock timeout) does not break the chain for the lines after it", () => {
  const dir = mkdtempSync(join(tmpdir(), "af-audit-unchained-"));
  try {
    appendAudit(dir, { event: "a" });
    // What the lock-timeout fallback writes: a line with no hash.
    appendFileSync(join(dir, ".agent-flow", "audit.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), event: "b", unchained: true })}\n`, "utf-8");
    appendAudit(dir, { event: "c" });
    const v = verifyAudit(dir);
    assert.equal(v.ok, true, JSON.stringify(v.broken));
    assert.equal(v.unchained, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
