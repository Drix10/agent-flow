// Functional tests: run each tool's execute() against a fake repo in a temp dir.
// These prove behavior (drift flagged, transitions recorded, payment dep
// flagged) — not just file existence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import staleDetector from "../extensions/stale-detector.js";
import stateMachine from "../extensions/state-machine.js";
import riskAuditor from "../extensions/risk-auditor.js";

function load(register) {
  const tools = {};
  register({ registerTool: (def) => { tools[def.name] = def; } });
  return tools;
}

function freshManifest() {
  return {
    context_files: [{
      path: "Root_AGENT.md",
      references: [
        { path: "src/index.ts", type: "file", last_verified: new Date().toISOString(), exists: true },
        { path: "docs/old-design.md", type: "file", last_verified: new Date().toISOString(), exists: true },
      ],
    }],
    staleness_threshold_days: 30,
  };
}

// Neutralize PATH so `npx ctxlint` fails fast instead of hitting the network.
async function withoutNpx(fn) {
  const saved = process.env.PATH;
  process.env.PATH = mkdtempSync(join(tmpdir(), "empty-path-"));
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
}

test("stale_detect flags a deleted reference", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drift-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), "export {};\n");
    // docs/old-design.md deliberately absent — simulates drift
    const manifestPath = join(dir, "CONTEXT_MANIFEST.json");
    writeFileSync(manifestPath, JSON.stringify(freshManifest()));

    const { stale_detect } = load(staleDetector);
    const result = await withoutNpx(() => stale_detect.execute("t1", { manifestPath, repoPath: dir }));
    assert.equal(result.details.healthy, false);
    assert.deepEqual(result.details.report.missing_paths, [
      { file: "Root_AGENT.md", path: "docs/old-design.md" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale_detect flags unverified-old references as stale", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stale-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), "export {};\n");
    const manifest = freshManifest();
    manifest.context_files[0].references = manifest.context_files[0].references.slice(0, 1);
    manifest.context_files[0].references[0].last_verified = "2020-01-01T00:00:00.000Z";
    const manifestPath = join(dir, "CONTEXT_MANIFEST.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const { stale_detect } = load(staleDetector);
    const result = await withoutNpx(() => stale_detect.execute("t1", { manifestPath, repoPath: dir }));
    assert.equal(result.details.healthy, false);
    assert.deepEqual(result.details.report.stale_files, ["Root_AGENT.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale_repair requires confirmation and refreshes timestamps", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repair-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), "export {};\n");
    const manifestPath = join(dir, "CONTEXT_MANIFEST.json");
    writeFileSync(manifestPath, JSON.stringify(freshManifest()));

    const { stale_detect, stale_repair } = load(staleDetector);
    await assert.rejects(
      () => stale_repair.execute("t1", { manifestPath, repoPath: dir, confirmation: "nope" }),
      /confirmation string required/
    );
    const before = JSON.parse(readFileSync(manifestPath, "utf-8"))
      .context_files[0].references[0].last_verified;
    await new Promise((r) => setTimeout(r, 10));
    await stale_repair.execute("t1", { manifestPath, repoPath: dir, confirmation: "CONFIRM_REPAIR" });
    const after = JSON.parse(readFileSync(manifestPath, "utf-8"));
    assert.ok(after.context_files[0].references[0].last_verified >= before);
    assert.equal(after.context_files[0].references[1].exists, false); // absent file stays false

    const redetect = await withoutNpx(() => stale_detect.execute("t2", { manifestPath, repoPath: dir }));
    assert.equal(redetect.details.report.stale_files.length, 0); // repaired refs no longer stale
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state_update records transitions and state_read returns them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "state-"));
  const savedCwd = process.cwd();
  try {
    process.chdir(dir); // state files are cwd-relative by design
    const { state_update, state_read } = load(stateMachine);
    await state_update.execute("t1", { issue: 42, state: "Working", phase: "implement", round: 1 });
    await state_update.execute("t2", { issue: 42, state: "Needs Me", reason: "review deadlocked" });
    const result = await state_read.execute("t3", {});
    const session = result.details.sessions.find((s) => s.issue === 42);
    assert.equal(session.state, "Needs Me");
    assert.equal(session.reason, "review deadlocked");
    const md = readFileSync(join(dir, "AGENT_STATE.md"), "utf-8");
    assert.match(md, /Needs Me \(1\)/);
    assert.match(md, /Issue #42/);
  } finally {
    process.chdir(savedCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale_detect reads the covers schema too (FM-17)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "covers-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), "export {};\n");
    // docs/guide.md absent — drift under the alternate schema
    const manifestPath = join(dir, "CONTEXT_MANIFEST.json");
    writeFileSync(manifestPath, JSON.stringify({
      version: 1,
      last_full_scan: new Date().toISOString(),
      contexts: [{ path: "Root_AGENT.md", covers: ["src/index.ts", "docs/guide.md"] }],
    }));

    const { stale_detect, stale_repair } = load(staleDetector);
    const result = await withoutNpx(() => stale_detect.execute("t1", { manifestPath, repoPath: dir }));
    assert.equal(result.details.healthy, false);
    assert.deepEqual(result.details.report.missing_paths, [
      { file: "Root_AGENT.md", path: "docs/guide.md" },
    ]);
    const repaired = await stale_repair.execute("t1", { manifestPath, repoPath: dir, confirmation: "CONFIRM_REPAIR" });
    assert.equal(repaired.details.repaired, manifestPath);
    // Covers schema keeps its shape — no context_files injected.
    assert.ok(!("context_files" in JSON.parse(readFileSync(manifestPath, "utf-8"))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("risk_audit flags a payment dependency", async () => {
  const dir = mkdtempSync(join(tmpdir(), "risk-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      dependencies: { stripe: "^14.0.0", lodash: "^4.0.0" },
    }));
    const baselinePath = join(dir, ".risk-baseline.json");
    const { risk_audit } = load(riskAuditor);
    const result = await risk_audit.execute("t1", { repoPath: dir, baselinePath });
    const payments = result.details.surfaces.filter((s) => s.type === "payment");
    assert.equal(result.details.baselineExists, false);
    assert.ok(payments.some((s) => s.detail.includes("stripe")));
    assert.ok(!result.details.surfaces.some((s) => s.detail.includes("lodash")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
