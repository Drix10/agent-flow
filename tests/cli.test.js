// CLI tests: the CLI is how non-Pi harnesses and CI get real checks
// (v1.0.2's CI step `node extensions/stale-detector.js` did nothing and passed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
const run = (cwd, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" } });

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "af-cli-"));
  const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" }).toString();
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  mkdirSync(join(dir, "src", "billing"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), "export {};\n");
  writeFileSync(join(dir, "src", "billing", "pay.ts"), "export {};\n");
  writeFileSync(join(dir, "AGENTS.md"), "Entry: `src/index.ts`.\n");
  writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({
    context_files: [{ path: "AGENTS.md", references: [{ path: "src/index.ts", type: "file", last_verified: new Date().toISOString() }] }],
    protected_paths: ["src/billing/"],
  }));
  g("add", "-A");
  g("commit", "-qm", "init");
  return { dir, g };
}

test("doctor: exit 0 healthy, 1 on drift, 2 without a manifest", () => {
  const { dir } = repo();
  try {
    assert.equal(run(dir, "doctor").status, 0);
    rmSync(join(dir, "src", "index.ts"));
    const r = run(dir, "doctor", "--json");
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).healthy, false);
    rmSync(join(dir, "CONTEXT_MANIFEST.json"));
    assert.equal(run(dir, "doctor").status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-staged blocks protected paths and secrets; human override works", () => {
  const { dir, g } = repo();
  try {
    writeFileSync(join(dir, "src", "billing", "pay.ts"), "export const x = 1;\n");
    g("add", "-A");
    let r = run(dir, "check-staged");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /protected path staged/);
    const ok = spawnSync(process.execPath, [BIN, "check-staged"], { cwd: dir, encoding: "utf-8", env: { ...process.env, AGENT_FLOW_ALLOW_PROTECTED: "1" } });
    assert.equal(ok.status, 0);
    g("reset", "-q");
    writeFileSync(join(dir, "src", "k.ts"), `const t = "${"sk-ant-" + "x".repeat(30)}";\n`);
    g("add", "src/k.ts");
    r = run(dir, "check-staged");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Anthropic API key/);
    assert.ok(!r.stdout.includes("x".repeat(30)), "secret value must not be printed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit-risk --fail-on-new fails only after a baseline exists and something new appears", () => {
  const { dir } = repo();
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { lodash: "1" } }));
    assert.equal(run(dir, "audit-risk", "--fail-on-new").status, 0);
    assert.equal(run(dir, "baseline", "accept", "--all").status, 2, "requires --yes");
    assert.equal(run(dir, "baseline", "accept", "--all", "--yes").status, 0);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { lodash: "1", stripe: "1" } }));
    const r = run(dir, "audit-risk", "--fail-on-new");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /stripe/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state update enforces the round cap from any harness", () => {
  const { dir } = repo();
  try {
    assert.equal(run(dir, "state", "update", "--issue", "3", "--state", "Working", "--round", "1").status, 0);
    const r = run(dir, "state", "update", "--issue", "3", "--state", "Working", "--round", "3", "--json");
    assert.equal(JSON.parse(r.stdout).state, "Needs Me");
    assert.equal(run(dir, "state", "update", "--issue", "3", "--state", "Completed", "--round", "0").status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install copies skills + reviewer agent and refuses to clobber user edits", () => {
  const { dir } = repo();
  try {
    assert.equal(run(dir, "install", "--harness", "claude").status, 0);
    assert.ok(existsSync(join(dir, ".claude", "skills", "reviewer", "SKILL.md")));
    assert.ok(existsSync(join(dir, ".claude", "agents", "reviewer.md")));
    writeFileSync(join(dir, ".claude", "skills", "reviewer", "SKILL.md"), "user edit");
    const r = run(dir, "install", "--harness", "claude");
    assert.equal(r.status, 1);
    assert.equal(readFileSync(join(dir, ".claude", "skills", "reviewer", "SKILL.md"), "utf-8"), "user edit");
    assert.equal(run(dir, "install", "--harness", "nope").status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook install writes a pre-commit hook that never downloads", () => {
  const { dir } = repo();
  try {
    assert.equal(run(dir, "hook", "install").status, 0);
    const hook = readFileSync(join(dir, ".git", "hooks", "pre-commit"), "utf-8");
    assert.match(hook, /check-staged/);
    assert.match(hook, /--no-install/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown command exits 2, --version prints the package version", () => {
  const { dir } = repo();
  try {
    assert.equal(run(dir, "frobnicate").status, 2);
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
    assert.equal(run(dir, "--version").stdout.trim(), pkg.version);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-staged inside a linked worktree checks that worktree's index", () => {
  const { dir, g } = repo();
  try {
    g("worktree", "add", "-q", "-b", "agent/issue-1", join(dir, ".worktrees", "issue-1"), "main");
    const wt = join(dir, ".worktrees", "issue-1");
    writeFileSync(join(wt, "src", "billing", "pay.ts"), "export const changed = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: wt });
    const inWt = run(wt, "check-staged");
    assert.equal(inWt.status, 1);
    assert.match(inWt.stdout, /protected path staged: src\/billing\/pay\.ts/);
    assert.equal(run(dir, "check-staged").status, 0, "main checkout has nothing staged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-staged blocks drift the commit introduces, only warns on pre-existing drift", () => {
  const { dir, g } = repo();
  try {
    // Introduced: deleting a referenced file.
    g("rm", "-q", "src/index.ts");
    let r = run(dir, "check-staged");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /broken reference in AGENTS\.md: src\/index\.ts/);
    g("commit", "-qm", "drift", "--no-verify");
    // Pre-existing: an unrelated commit is allowed, with a warning.
    writeFileSync(join(dir, "src", "other.ts"), "export {};\n");
    g("add", "src/other.ts");
    r = run(dir, "check-staged");
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /pre-existing: broken reference/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
