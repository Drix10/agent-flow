// Functional tests: run each tool's execute() against a fake repo in a temp dir.
// These prove behaviour (drift flagged, transitions validated, injection refused),
// not just file existence. Every test here corresponds to a bug that shipped in
// v1.0.2 or a failure mode in FAILURE_MODES.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import staleDetector from "../extensions/stale-detector.js";
import stateMachine from "../extensions/state-machine.js";
import riskAuditor from "../extensions/risk-auditor.js";
import bootstrap from "../extensions/bootstrap.js";
import worktree from "../extensions/worktree.js";
import classify from "../extensions/classify.js";
import crossHarness from "../extensions/cross-harness.js";
import index from "../extensions/index.js";

function load(register) {
  const tools = {};
  const handlers = {};
  register({
    registerTool: (def) => {
      assert.ok(!tools[def.name], `tool ${def.name} registered twice`);
      tools[def.name] = def;
    },
    on: (ev, fn) => ((handlers[ev] ??= []).push(fn), () => {}),
    getActiveTools: () => ["read", "write", "edit", "bash"],
    setActiveTools: () => {},
  });
  tools.__handlers = handlers;
  return tools;
}

const now = () => new Date().toISOString();
const ctxAt = (cwd, extra = {}) => ({ cwd, hasUI: false, ...extra });
const uiYes = (cwd) => ({ cwd, hasUI: true, ui: { confirm: async () => true } });
const uiNo = (cwd) => ({ cwd, hasUI: true, ui: { confirm: async () => false } });

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `af-${prefix}-`));
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    const r = fn();
    if (r && typeof r.then === "function") return r.finally(restore);
    restore();
    return r;
  } catch (e) {
    restore();
    throw e;
  }
}

function gitRepo() {
  const dir = tmp("git");
  const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" }).toString();
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  mkdirSync(join(dir, "src", "billing"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), "export {};\n");
  writeFileSync(join(dir, "src", "billing", "pay.ts"), "export const pay = 1;\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  return { dir, g };
}

function manifest(refs, extra = {}) {
  return { version: "2", staleness_threshold_days: 30, context_files: [{ path: "AGENTS.md", references: refs }], ...extra };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("index registers every tool exactly once", () => {
  const tools = load(index);
  for (const name of ["bootstrap_scan", "bootstrap_write", "worktree_create", "worktree_remove", "worktree_list", "state_update", "state_read",
    "stale_detect", "stale_repair", "risk_audit", "risk_baseline_update", "risk_classify", "detect_harness", "guard_status"]) {
    assert.ok(tools[name], `${name} not registered`);
  }
  assert.ok(tools.__handlers.tool_call?.length === 1, "guard must hook tool_call");
});

// ---------------------------------------------------------------------------
// stale_detect / stale_repair
// ---------------------------------------------------------------------------

test("stale_detect reports every unfilled {{PLACEHOLDER}} on a line, not just the first", async () => {
  const dir = tmp("placeholders");
  try {
    writeFileSync(join(dir, "AGENTS.md"), "Owner: {{OWNER}}, repo: {{REPO}}\n");
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify(manifest([])));
    const { stale_detect } = load(staleDetector);
    const r = await stale_detect.execute("t", { repoPath: dir }, undefined, undefined, ctxAt(dir));
    const texts = r.details.report.unfilled_placeholders.map((p) => p.text);
    assert.deepEqual(texts.sort(), ["{{OWNER}}", "{{REPO}}"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale_detect flags a deleted manifest reference", async () => {
  const dir = tmp("drift");
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "export {};\n");
    writeFileSync(join(dir, "AGENTS.md"), "# root\n");
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify(manifest([
      { path: "src/index.ts", type: "file", last_verified: now() },
      { path: "docs/old-design.md", type: "file", last_verified: now() },
    ])));
    const { stale_detect } = load(staleDetector);
    const r = await stale_detect.execute("t", { repoPath: dir }, undefined, undefined, ctxAt(dir));
    assert.equal(r.details.healthy, false);
    assert.deepEqual(r.details.report.missing_paths, [{ file: "AGENTS.md", path: "docs/old-design.md", source: "manifest" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale_detect flags old references as stale and {{DATE}} placeholders as invalid (was silently fresh)", async () => {
  const dir = tmp("stale");
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "");
    writeFileSync(join(dir, "src", "b.ts"), "");
    writeFileSync(join(dir, "AGENTS.md"), "# root\n");
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify(manifest([
      { path: "src/a.ts", last_verified: "2020-01-01T00:00:00.000Z" },
      { path: "src/b.ts", last_verified: "{{DATE}}" },
    ])));
    const { stale_detect } = load(staleDetector);
    const r = await stale_detect.execute("t", { repoPath: dir }, undefined, undefined, ctxAt(dir));
    assert.equal(r.details.healthy, false);
    assert.deepEqual(r.details.report.stale_files, ["AGENTS.md"]);
    assert.equal(r.details.report.invalid_timestamps.length, 1);
    assert.ok(r.details.report.schema_problems.some((p) => p.includes("{{DATE}}")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale_detect catches a deleted context file (v1.0.2 reported healthy)", async () => {
  const dir = tmp("ctxgone");
  try {
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify(manifest([])));
    const { stale_detect } = load(staleDetector);
    const r = await stale_detect.execute("t", { repoPath: dir }, undefined, undefined, ctxAt(dir));
    assert.equal(r.details.healthy, false);
    assert.deepEqual(r.details.report.missing_context_files, ["AGENTS.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale_detect checks `backticked/paths` in the prose, skipping code fences, urls and globs", async () => {
  const dir = tmp("prose");
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "");
    writeFileSync(join(dir, "AGENTS.md"), [
      "Entry: `src/index.ts`, handlers: `src/handlers/user.ts:42`.",
      "Ignore `https://x.io/a/b`, `src/**/*.ts`, `node:fs`, `npm run build`, `@scope/pkg`.",
      "```", "`src/in/fence.ts`", "```",
      "Removed long ago: `src/legacy/old.ts` <!-- agent-flow:ignore-refs -->",
    ].join("\n"));
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify(manifest([])));
    const { stale_detect } = load(staleDetector);
    const r = await stale_detect.execute("t", { repoPath: dir }, undefined, undefined, ctxAt(dir));
    assert.deepEqual(r.details.report.missing_paths, [{ file: "AGENTS.md", path: "src/handlers/user.ts", source: "prose" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale_detect never shells out to npx (would download code)", () => {
  const src = readFileSync(new URL("../extensions/lib/stale.ts", import.meta.url), "utf-8");
  assert.ok(!/execSync\(\s*["'`]npx/.test(src) && !/\["npx"/.test(src), "stale detector must not invoke npx");
});

test("stale_repair refuses headless writes without the human opt-in, and honours a UI decline", async () => {
  const dir = tmp("repair-gate");
  try {
    writeFileSync(join(dir, "AGENTS.md"), "");
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify(manifest([])));
    const { stale_repair } = load(staleDetector);
    await withEnv({ AGENT_FLOW_HEADLESS_WRITES: undefined }, () =>
      assert.rejects(() => stale_repair.execute("t", { repoPath: dir, confirmation: "CONFIRM_REPAIR" }, undefined, undefined, ctxAt(dir)), /no interactive UI/),
    );
    await assert.rejects(() => stale_repair.execute("t", { repoPath: dir }, undefined, undefined, uiNo(dir)), /declined/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale_repair refreshes timestamps after UI confirmation", async () => {
  const dir = tmp("repair");
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "");
    writeFileSync(join(dir, "AGENTS.md"), "");
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify(manifest([
      { path: "src/index.ts", type: "file", last_verified: "2020-01-01T00:00:00.000Z", exists: true },
      { path: "docs/gone.md", type: "file", last_verified: now(), exists: true },
    ])));
    const { stale_detect, stale_repair } = load(staleDetector);
    const r = await stale_repair.execute("t", { repoPath: dir }, undefined, undefined, uiYes(dir));
    assert.equal(r.details.refreshed, 1);
    assert.deepEqual(r.details.still_missing, [{ file: "AGENTS.md", path: "docs/gone.md" }]);
    const m = JSON.parse(readFileSync(join(dir, "CONTEXT_MANIFEST.json"), "utf-8"));
    assert.equal(m.context_files[0].references[1].exists, false);
    const again = await stale_detect.execute("t", { repoPath: dir }, undefined, undefined, ctxAt(dir));
    assert.equal(again.details.report.stale_files.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FM-17: legacy contexts/covers manifest is read, flagged, and migrated on repair", async () => {
  const dir = tmp("covers");
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "");
    writeFileSync(join(dir, "Root_AGENT.md"), "");
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({
      version: 1,
      last_full_scan: now(),
      contexts: [{ path: "Root_AGENT.md", covers: ["src/index.ts", "docs/guide.md"] }],
    }));
    const { stale_detect, stale_repair } = load(staleDetector);
    const r = await stale_detect.execute("t", { repoPath: dir }, undefined, undefined, ctxAt(dir));
    assert.equal(r.details.healthy, false);
    assert.equal(r.details.legacy_schema, true);
    assert.deepEqual(r.details.report.missing_paths, [{ file: "Root_AGENT.md", path: "docs/guide.md", source: "manifest" }]);
    const rep = await stale_repair.execute("t", { repoPath: dir }, undefined, undefined, uiYes(dir));
    assert.equal(rep.details.migrated_legacy_schema, true);
    const m = JSON.parse(readFileSync(join(dir, "CONTEXT_MANIFEST.json"), "utf-8"));
    assert.ok(Array.isArray(m.context_files) && !("contexts" in m));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale_detect returns a structured error for malformed JSON instead of throwing", async () => {
  const dir = tmp("badjson");
  try {
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), "{ not json");
    const { stale_detect } = load(staleDetector);
    const r = await stale_detect.execute("t", { repoPath: dir }, undefined, undefined, ctxAt(dir));
    assert.equal(r.details.healthy, false);
    assert.match(r.details.error, /invalid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// state machine
// ---------------------------------------------------------------------------

test("state_update records transitions at the repo root", async () => {
  const dir = tmp("state");
  try {
    const { state_update, state_read } = load(stateMachine);
    await state_update.execute("t", { issue: 42, state: "Working", phase: "implement", round: 0 }, undefined, undefined, ctxAt(dir));
    await state_update.execute("t", { issue: 42, state: "Needs Me", reason: "review deadlocked" }, undefined, undefined, ctxAt(dir));
    const r = await state_read.execute("t", {}, undefined, undefined, ctxAt(dir));
    const s = r.details.sessions.find((x) => x.issue === 42);
    assert.equal(s.state, "Needs Me");
    assert.equal(s.history.length, 2);
    const md = readFileSync(join(dir, "AGENT_STATE.md"), "utf-8");
    assert.match(md, /Needs Me \(1\)/);
    assert.ok(existsSync(join(dir, ".agent-flow", "audit.jsonl")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("≤2 rounds is mechanical: round 3 auto-escalates, rounds cannot go backwards", async () => {
  const dir = tmp("rounds");
  try {
    const { state_update } = load(stateMachine);
    const call = (p) => state_update.execute("t", p, undefined, undefined, ctxAt(dir));
    await call({ issue: 1, state: "Working", round: 1 });
    await call({ issue: 1, state: "Working", round: 2 });
    const r = await call({ issue: 1, state: "Working", round: 3 });
    assert.equal(r.details.state, "Needs Me");
    assert.equal(r.details.escalated, true);
    await assert.rejects(() => call({ issue: 1, state: "Working", round: 0 }), /backwards/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reopen cannot rewind the round counter on a session that isn't actually Completed", async () => {
  // `reopen` is meant as a human-only escape hatch for a *Completed* session. Passing it on a
  // still-open session must not let the round cap be dodged by resetting the round to 0.
  const dir = tmp("reopen-bypass");
  try {
    const { state_update } = load(stateMachine);
    const call = (p) => state_update.execute("t", p, undefined, undefined, ctxAt(dir));
    await call({ issue: 5, state: "Working", round: 1 });
    await call({ issue: 5, state: "Working", round: 2 });
    const escalated = await call({ issue: 5, state: "Working", round: 3 });
    assert.equal(escalated.details.state, "Needs Me");
    await assert.rejects(
      () => call({ issue: 5, state: "Working", round: 0, reopen: true }),
      /backwards/,
      "reopen must not bypass the round-monotonic guard on a non-Completed session",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state machine rejects illegal transitions and reasonless escalations", async () => {
  const dir = tmp("illegal");
  try {
    const { state_update } = load(stateMachine);
    const call = (p) => state_update.execute("t", p, undefined, undefined, ctxAt(dir));
    await assert.rejects(() => call({ issue: 2, state: "Completed" }), /illegal transition/);
    await assert.rejects(() => call({ issue: 2, state: "Needs Me" }), /requires a reason/);
    await call({ issue: 2, state: "Working" });
    await call({ issue: 2, state: "Completed", reason: "PR #9" });
    await assert.rejects(() => call({ issue: 2, state: "Working" }), /terminal/);
    const re = await call({ issue: 2, state: "Working", reopen: true });
    assert.equal(re.details.state, "Working");
    await assert.rejects(() => call({ issue: 2.5, state: "Working" }), /positive integer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parallel state updates do not lose writes (lock + atomic write)", async () => {
  const dir = tmp("race");
  try {
    const script = `
      import { updateState } from ${JSON.stringify(new URL("../extensions/lib/state.js", import.meta.url).href)};
      updateState(process.argv[1], { issue: Number(process.argv[2]), state: "Working", phase: "implement" });
    `;
    const procs = Array.from({ length: 12 }, (_, i) =>
      new Promise((res, rej) => {
        import("node:child_process").then(({ execFile }) =>
          execFile(process.execPath, ["--input-type=module", "-e", script, dir, String(i + 1)], (err) => (err ? rej(err) : res())),
        );
      }),
    );
    await Promise.all(procs);
    const state = JSON.parse(readFileSync(join(dir, ".agent-state.json"), "utf-8"));
    assert.equal(state.sessions.length, 12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("existsExact never reports a path outside the repo as existing, even when it's real on disk", async () => {
  const { existsExact } = await import("../extensions/lib/fsutil.js");
  // Nest the "repo" inside our own sandbox dir, rather than writing the outside
  // marker straight into the shared OS temp root — a real file, but one only
  // this test owns, so nothing else on the machine can collide with it.
  const sandbox = tmp("exists-exact-escape");
  const dir = join(sandbox, "repo");
  try {
    mkdirSync(dir, { recursive: true });
    // A file that genuinely exists one level above the repo root.
    writeFileSync(join(sandbox, "outside-marker.txt"), "x");
    assert.equal(existsExact(dir, "../outside-marker.txt"), false);
    assert.equal(existsExact(dir, "..%2F..%2Fetc"), false); // not a real escape, just must not throw
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("withLock breaks a dead holder's lock immediately, and never breaks a live holder's lock early", async () => {
  const { withLock } = await import("../extensions/lib/fsutil.js");
  const dir = tmp("lock");
  try {
    const lockPath = join(dir, "x.lock");
    mkdirSync(dir, { recursive: true });

    // A lock left behind by a PID that no longer exists is broken right away,
    // not after waiting out `staleMs` — that's the whole point of tracking the PID.
    writeFileSync(lockPath, "999999999"); // not a real PID
    const start = Date.now();
    const result = withLock(lockPath, () => "acquired-after-dead-pid", 5_000, 30_000);
    assert.equal(result, "acquired-after-dead-pid");
    assert.ok(Date.now() - start < 2_000, "a dead PID's lock must not wait for the stale-age fallback");

    // A lock held by a PID that IS alive (this test process itself, standing in for
    // a legitimately slow holder) must not be broken just because it's a few seconds
    // "old" — only actual staleness (age past staleMs, tested via a tiny staleMs below)
    // or a confirmed-dead PID should ever break it.
    writeFileSync(lockPath, String(process.pid));
    assert.throws(
      () => withLock(lockPath, () => "unreachable", 200, 30_000),
      /timed out waiting for lock/,
      "a live PID's lock must not be broken while it's within staleMs",
    );
    unlinkSync(lockPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state file markdown escapes untrusted reasons", async () => {
  const dir = tmp("md");
  try {
    const { state_update } = load(stateMachine);
    await state_update.execute("t", { issue: 3, state: "Needs Me", reason: "line1\n## Injected heading\n<script>" }, undefined, undefined, ctxAt(dir));
    const md = readFileSync(join(dir, "AGENT_STATE.md"), "utf-8");
    assert.ok(!md.includes("\n## Injected heading"));
    assert.ok(!md.includes("<script>"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// risk
// ---------------------------------------------------------------------------

test("risk_audit flags a payment dependency but not lodash", async () => {
  const dir = tmp("risk");
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { stripe: "^14", lodash: "^4" } }));
    const { risk_audit } = load(riskAuditor);
    const r = await risk_audit.execute("t", { repoPath: dir, full: true }, undefined, undefined, ctxAt(dir));
    assert.equal(r.details.baselineExists, false);
    assert.ok(r.details.surfaces.some((s) => s.type === "payment" && s.detail.includes("stripe")));
    assert.ok(!r.details.surfaces.some((s) => s.type !== "dependency" && s.detail.includes("lodash")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FM-05: a NEW dependency in an already-baselined package.json is reported (v1.0.2 missed it)", async () => {
  const dir = tmp("newdep");
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { lodash: "^4" } }));
    const { risk_audit, risk_baseline_update } = load(riskAuditor);
    await risk_baseline_update.execute("t", { repoPath: dir }, undefined, undefined, uiYes(dir));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { lodash: "^4", stripe: "^14" } }));
    const r = await risk_audit.execute("t", { repoPath: dir }, undefined, undefined, ctxAt(dir));
    const keys = r.details.newSurfacesList.map((s) => s.key);
    assert.ok(keys.includes("dependency:package.json:stripe"));
    assert.ok(keys.includes("payment:package.json:stripe"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("risk parses requirements.txt, go.mod, Cargo.toml and pyproject deps", async () => {
  const dir = tmp("polyglot");
  try {
    writeFileSync(join(dir, "requirements.txt"), "requests==2.0\n# c\nstripe>=5 ; python_version>'3'\n-r other.txt\n");
    writeFileSync(join(dir, "go.mod"), "module x\n\nrequire (\n\tgithub.com/golang-jwt/jwt/v5 v5.0.0\n)\n");
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname='x'\n[dependencies]\nserde = '1'\n");
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = [\n  "httpx>=0.2",\n]\n');
    const { risk_audit } = load(riskAuditor);
    const r = await risk_audit.execute("t", { repoPath: dir, full: true }, undefined, undefined, ctxAt(dir));
    const deps = r.details.surfaces.filter((s) => s.type === "dependency").map((s) => s.detail);
    for (const d of ["requests", "stripe", "github.com/golang-jwt/jwt/v5", "serde", "httpx"]) assert.ok(deps.includes(`Dependency: ${d}`), d);
    assert.ok(r.details.surfaces.some((s) => s.type === "auth" && s.detail.includes("jwt")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("risk patterns are word-bounded: map.delete() and `author` are not risk", async () => {
  const dir = tmp("noise");
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "const author = 'x';\ncache.delete(key);\nconst price = 3;\n");
    writeFileSync(join(dir, "src", "b.ts"), "await db.query('DELETE FROM users WHERE id = $1');\n");
    const { risk_audit } = load(riskAuditor);
    const r = await risk_audit.execute("t", { repoPath: dir, full: true }, undefined, undefined, ctxAt(dir));
    assert.ok(!r.details.surfaces.some((s) => s.path === "src/a.ts"), JSON.stringify(r.details.surfaces));
    assert.ok(r.details.surfaces.some((s) => s.path === "src/b.ts" && s.type === "data-mutation"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nested node_modules and test files are not scanned (v1.0.2 only ignored the root ones)", async () => {
  const dir = tmp("nested");
  try {
    mkdirSync(join(dir, "packages", "a", "node_modules", "evil"), { recursive: true });
    writeFileSync(join(dir, "packages", "a", "node_modules", "evil", "index.js"), "require('child_process').execSync('x')\n");
    mkdirSync(join(dir, "packages", "a", "src"), { recursive: true });
    writeFileSync(join(dir, "packages", "a", "src", "x.test.ts"), "execSync('x')\n");
    const { risk_audit } = load(riskAuditor);
    const r = await risk_audit.execute("t", { repoPath: dir, full: true }, undefined, undefined, ctxAt(dir));
    assert.equal(r.details.surfaces.length, 0, JSON.stringify(r.details.surfaces));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("secrets are detected but their values never appear in output", async () => {
  const dir = tmp("secret");
  try {
    const fake = "AKIA" + "Q".repeat(16);
    writeFileSync(join(dir, "config.js"), `const k = "${fake}";\n`);
    const { risk_audit } = load(riskAuditor);
    const r = await risk_audit.execute("t", { repoPath: dir, full: true }, undefined, undefined, ctxAt(dir));
    assert.ok(r.details.surfaces.some((s) => s.type === "secret"));
    assert.ok(!JSON.stringify(r).includes(fake));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("risk_baseline_update never silently wipes the baseline and rejects unknown keys", async () => {
  const dir = tmp("wipe");
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { a: "1", b: "1" } }));
    const { risk_baseline_update } = load(riskAuditor);
    const r = await risk_baseline_update.execute("t", { repoPath: dir, confirmation: "CONFIRM_RISK_BASELINE" }, undefined, undefined, uiYes(dir));
    assert.equal(r.details.count, 2); // v1.0.2: omitted surfaces → baseline of []
    await assert.rejects(() => risk_baseline_update.execute("t", { repoPath: dir, acceptKeys: ["nope"] }, undefined, undefined, uiYes(dir)), /unknown surface keys/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------

test("bootstrap_write refuses path traversal, absolute paths, symlink escapes and source files", async () => {
  const dir = tmp("traverse");
  const outside = tmp("outside");
  try {
    const { bootstrap_write } = load(bootstrap);
    const w = (p) => bootstrap_write.execute("t", { path: p, content: "x", repoPath: dir }, undefined, undefined, uiYes(dir));
    await assert.rejects(() => w("../../evil.md"), /escapes/);
    await assert.rejects(() => w(join(outside, "abs.md")), /escapes/);
    await assert.rejects(() => w("src/app.ts"), /only writes context files/);
    await assert.rejects(() => w(".git/hooks/pre-commit.md"), /only writes context files/);
    try {
      symlinkSync(outside, join(dir, "link"), "dir");
      await assert.rejects(() => w("link/x.md"), /symlink/);
    } catch (e) {
      if (e.code !== "EPERM") throw e; // Windows without symlink privilege
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("bootstrap_write: invalid manifest, secrets, and silent overwrite are refused; model-supplied token is not enough", async () => {
  const dir = tmp("bw");
  try {
    const { bootstrap_write } = load(bootstrap);
    const w = (p, content, extra = {}, ctx = uiYes(dir)) => bootstrap_write.execute("t", { path: p, content, repoPath: dir, ...extra }, undefined, undefined, ctx);
    await assert.rejects(() => w("CONTEXT_MANIFEST.json", JSON.stringify({ contexts: [] })), /schema validation/);
    await assert.rejects(() => w("AGENTS.md", "key: " + "ghp_" + "a".repeat(36)), /GitHub token/);
    await withEnv({ AGENT_FLOW_HEADLESS_WRITES: undefined }, () =>
      assert.rejects(() => w("AGENTS.md", "# hi", { confirmation: "CONFIRM_BOOTSTRAP" }, ctxAt(dir)), /no interactive UI/),
    );
    const ok = await w("AGENTS.md", "# hi\n");
    assert.equal(ok.details.written, "AGENTS.md");
    await assert.rejects(() => w("AGENTS.md", "# other\n"), /already exists/);
    await w("AGENTS.md", "# other\n", { overwrite: true });
    assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf-8"), "# other\n");
    await withEnv({ AGENT_FLOW_HEADLESS_WRITES: "1" }, () => w("docs/x.md", "# x\n", {}, ctxAt(dir)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bootstrap_scan reports javascript vs typescript honestly and finds real commands", async () => {
  const dir = tmp("scan");
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test", build: "esbuild x" }, devDependencies: { mocha: "1" } }));
    writeFileSync(join(dir, "AGENTS.md"), "# existing\n");
    const { bootstrap_scan } = load(bootstrap);
    const r = await bootstrap_scan.execute("t", { repoPath: dir }, undefined, undefined, ctxAt(dir));
    assert.deepEqual(r.details.languages, ["javascript"]);
    assert.ok(r.details.testFrameworks.includes("mocha") && r.details.testFrameworks.includes("node:test"));
    assert.ok(r.details.commands.some((c) => c.name === "test" && c.command === "node --test"));
    assert.deepEqual(r.details.existingContextFiles, ["AGENTS.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// worktrees + classification (real git)
// ---------------------------------------------------------------------------

test("worktree_create rejects shell injection in baseBranch (was RCE in v1.0.2)", async () => {
  const { dir } = gitRepo();
  try {
    const { worktree_create } = load(worktree);
    await assert.rejects(
      () => worktree_create.execute("t", { issue: 5, baseBranch: "main; touch PWNED" }, undefined, undefined, ctxAt(dir)),
      /invalid branch name/,
    );
    await assert.rejects(
      () => worktree_create.execute("t", { issue: 5, baseBranch: "--upload-pack=touch PWNED" }, undefined, undefined, ctxAt(dir)),
      /invalid branch name/,
    );
    assert.ok(!existsSync(join(dir, "PWNED")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktree lifecycle: create from detected default branch, list from git, refuse dirty removal, keep branch", async () => {
  const { dir, g } = gitRepo();
  g("branch", "-m", "main", "trunk"); // non-"main" default branch
  try {
    const { worktree_create, worktree_list, worktree_remove } = load(worktree);
    const c = await worktree_create.execute("t", { issue: 9 }, undefined, undefined, ctxAt(dir));
    assert.equal(c.details.base, "trunk");
    // From INSIDE the worktree, tools still resolve the main repo root.
    const wt = join(dir, ".worktrees", "issue-9");
    const l = await worktree_list.execute("t", {}, undefined, undefined, ctxAt(wt));
    assert.deepEqual(l.details.worktrees.map((w) => w.issue), [9]);
    assert.equal(g("status", "--porcelain").trim(), "", ".worktrees must be git-excluded");
    writeFileSync(join(wt, "dirty.txt"), "x");
    const refused = await worktree_remove.execute("t", { issue: 9 }, undefined, undefined, ctxAt(dir));
    assert.equal(refused.details.error, "worktree_dirty");
    const removed = await worktree_remove.execute("t", { issue: 9, force: true }, undefined, undefined, ctxAt(dir));
    assert.equal(removed.details.branch_deleted, false);
    assert.match(g("branch", "--list", "agent/issue-9"), /agent\/issue-9/);
    // A leftover branch from a crashed run is reused, not an error.
    const again = await worktree_create.execute("t", { issue: 9 }, undefined, undefined, ctxAt(dir));
    assert.equal(again.details.reused_existing_branch, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("risk_classify uses the real diff: protected dirs match (v1.0.2 only matched exact files) and author.ts is not auth", async () => {
  const { dir, g } = gitRepo();
  try {
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify(manifest([], { protected_paths: ["src/billing/"], default_branch: "main" })));
    writeFileSync(join(dir, "AGENTS.md"), "");
    g("add", "-A");
    g("commit", "-qm", "manifest");
    const { worktree_create } = load(worktree);
    await worktree_create.execute("t", { issue: 4 }, undefined, undefined, ctxAt(dir));
    const wt = join(dir, ".worktrees", "issue-4");
    writeFileSync(join(wt, "src", "author.ts"), "export const a = 1;\n");
    const { risk_classify } = load(classify);
    let r = await risk_classify.execute("t", { issue: 4 }, undefined, undefined, ctxAt(dir));
    assert.equal(r.details.risk_level, "low");
    writeFileSync(join(wt, "src", "billing", "pay.ts"), "export const pay = 2;\n");
    r = await risk_classify.execute("t", { issue: 4 }, undefined, undefined, ctxAt(dir));
    assert.equal(r.details.risk_level, "critical");
    assert.deepEqual(r.details.protected_violations, ["src/billing/pay.ts"]);
    assert.equal(r.details.human_approval_required, true);
    await assert.rejects(() => risk_classify.execute("t", { base: "--output=/tmp/x" }, undefined, undefined, ctxAt(dir)), /invalid git revision/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detect_harness reports Pi as the runtime, not whatever dirs exist", async () => {
  const dir = tmp("harness");
  try {
    mkdirSync(join(dir, ".claude"));
    const { detect_harness } = load(crossHarness);
    const r = await detect_harness.execute("t", { repoPath: dir }, undefined, undefined, ctxAt(dir));
    assert.equal(r.details.runningIn, "pi");
    assert.deepEqual(r.details.configured.map((c) => c.harness), ["claude-code"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
