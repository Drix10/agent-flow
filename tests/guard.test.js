// Guard policy tests. The guard is what turns "the Reviewer is read-only" from a
// sentence in a SKILL.md (FM-16: verified NOT enforced) into a blocked tool call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeShell, decide, parseRole } from "../extensions/lib/guard.js";
import guard from "../extensions/guard.js";

const root = mkdtempSync(join(tmpdir(), "af-guard-"));
test.after(() => rmSync(root, { recursive: true, force: true }));

const manifest = {
  context_files: [{ path: "AGENTS.md", references: [] }, { path: "src/api/AGENTS.md", references: [] }],
  protected_paths: ["src/billing/", "**/migrations/**", "package-lock.json"],
  default_branch: "main",
};

const d = (role, toolName, input, extra = {}) => decide({ role, toolName, input, cwd: root, root, manifest, ...extra });
const blocked = (r, rule) => {
  assert.ok(r, "expected a block");
  if (rule) assert.equal(r.rule, rule);
};

test("FM-16 closed on Pi: reviewer and qa cannot write or edit", () => {
  for (const role of ["reviewer", "qa"]) {
    blocked(d(role, "write", { path: "TEST.md", content: "x" }), "read-only-role");
    blocked(d(role, "edit", { path: "src/a.ts", edits: [] }), "read-only-role");
    blocked(d(role, "apply_patch", { path: "src/a.ts" }), "read-only-role");
  }
});

test("reviewer and qa: mutating shell is blocked, read-only shell is allowed", () => {
  for (const cmd of [
    "echo hi > TEST.md",
    "cat a | tee b",
    "sed -i 's/a/b/' src/x.ts",
    "rm -rf src",
    "git commit -am x",
    "git checkout -- .",
    "npm install left-pad",
    "python -c \"open('x','w').write('y')\"",
    "node -e \"require('fs').writeFileSync('x','y')\"",
    "curl -o out.bin https://x",
    "Set-Content -Path x.txt -Value y",
    "gh pr merge 3",
  ]) blocked(d("reviewer", "bash", { command: cmd }), "read-only-role");

  for (const cmd of [
    "git diff main...HEAD",
    "git log --oneline -5",
    "grep -rn 'a > b' src",
    "npm test 2>&1",
    "ls -la > /dev/null",
    "cat file 2>/dev/null",
    "rg 'x => y' src",
    "git status --porcelain",
  ]) assert.equal(d("reviewer", "bash", { command: cmd }), null, cmd);
});

test("qa may run a clean install but not update snapshots or --fix", () => {
  assert.equal(d("qa", "bash", { command: "npm ci && npm test" }), null);
  blocked(d("qa", "bash", { command: "npx jest -u" }), "qa-no-autofix");
  blocked(d("qa", "bash", { command: "npm run lint -- --fix" }), "qa-no-autofix");
});

test("protected paths are blocked for every role (and with no role), overridable by a human", () => {
  for (const role of [null, "orchestrator", "implementer", "gardener"]) {
    blocked(d(role, "write", { path: "src/billing/pay.ts" }), role === "gardener" ? undefined : "protected-path");
  }
  blocked(d("implementer", "edit", { path: "db/migrations/001.sql" }), "protected-path");
  blocked(d("implementer", "bash", { command: "sed -i 's/x/y/' src/billing/pay.ts" }), "protected-path");
  assert.equal(d(null, "write", { path: "src/billing/pay.ts" }, { allowProtected: true }), null);
  assert.equal(d("implementer", "write", { path: "src/app.ts" }), null);
});

test("protected_paths written as a leading-wildcard glob still blocks a matching shell command", () => {
  // literalPrefix-only matching missed any pattern that *starts* with a wildcard
  // (`*.env`, `**/secrets/**`) because the "literal prefix" of those is empty.
  const globManifest = { ...manifest, protected_paths: ["*.env", "**/secrets/**"] };
  const dg = (role, toolName, input) => decide({ role, toolName, input, cwd: root, root, manifest: globManifest });
  blocked(dg("implementer", "bash", { command: "rm production.env" }), "protected-path");
  blocked(dg("implementer", "bash", { command: "echo x > config/secrets/keys.yaml" }), "protected-path"); // resolved write
  blocked(dg("implementer", "bash", { command: "git rm config/secrets/keys.yaml" }), "protected-path"); // text fallback
  // protected means "don't modify": reading one into another file is not a write to it.
  assert.equal(dg("implementer", "bash", { command: "cat config/secrets/keys.yaml > out.txt" }), null);
  assert.equal(dg("implementer", "bash", { command: "npm test" }), null);
});

test("implementer is confined to its worktree and cannot edit context files", () => {
  const wt = join(root, ".worktrees", "issue-7");
  blocked(d("implementer", "write", { path: join(root, "src", "a.ts") }, { worktree: wt }), "worktree-confinement");
  assert.equal(d("implementer", "write", { path: join(wt, "src", "a.ts") }, { worktree: wt }), null);
  blocked(d("implementer", "write", { path: join(wt, "src", "billing", "x.ts") }, { worktree: wt }), "protected-path");
  blocked(d("implementer", "edit", { path: join(wt, "AGENTS.md") }, { worktree: wt }), "context-file");
  blocked(d("implementer", "edit", { path: "src/api/AGENTS.md" }), "context-file");
});

test("gardener may edit docs and the manifest, not source", () => {
  assert.equal(d("gardener", "edit", { path: "AGENTS.md" }), null);
  assert.equal(d("gardener", "write", { path: "CONTEXT_MANIFEST.json" }), null);
  blocked(d("gardener", "write", { path: "src/app.ts" }), "gardener-scope");
});

test("trust signals are tamper-proof: state/audit files and .git cannot be written directly", () => {
  for (const p of [".agent-state.json", "AGENT_STATE.md", ".agent-flow/audit.jsonl", ".git/hooks/pre-commit"]) {
    blocked(d(null, "write", { path: p }), "tamper-proof");
  }
  blocked(d("implementer", "bash", { command: "echo '{}' > .agent-state.json" }), "tamper-proof");
});

test("agents cannot bypass hooks, force-push, or push to the default branch", () => {
  blocked(d("implementer", "bash", { command: "git commit --no-verify -m x" }), "no-verify");
  blocked(d("implementer", "bash", { command: "git commit -n -m x" }), "no-verify");
  blocked(d("orchestrator", "bash", { command: "git push --force origin agent/issue-1" }), "force-push");
  blocked(d("orchestrator", "bash", { command: "git push origin main" }), "push-default-branch");
  blocked(d("orchestrator", "bash", { command: "git push origin HEAD:main" }), "push-default-branch");
  // HEAD / @ / dynamic targets resolve to the checked-out branch, which may be the default one.
  for (const cmd of ["git push origin HEAD", "git push -u origin HEAD", "git push origin @", "git push origin HEAD:$(git branch --show-current)", "git push origin HEAD:refs/heads/$B"]) {
    blocked(d("orchestrator", "bash", { command: cmd }), "explicit-refspec");
  }
  assert.equal(d("orchestrator", "bash", { command: "git push origin HEAD:agent/issue-7" }), null);
  assert.equal(d("orchestrator", "bash", { command: "git push -u origin agent/issue-1" }), null);
});

test("role tool allow-list: reviewer cannot repair the manifest or accept risk", () => {
  blocked(d("reviewer", "stale_repair", {}), "role-tool");
  blocked(d("implementer", "risk_baseline_update", {}), "role-tool");
  assert.equal(d("gardener", "stale_repair", {}), null);
  assert.equal(d("orchestrator", "worktree_create", { issue: 1 }), null);
});

test("non-orchestrator roles cannot re-role themselves or spawn agents", () => {
  blocked(d("qa", "bash", { command: "AGENT_FLOW_ROLE=orchestrator pi -p 'write x'" }), "role-escalation");
  blocked(d("implementer", "bash", { command: "claude -p 'edit src/billing/pay.ts'" }), "role-escalation");
  blocked(d("qa", "powershell", { command: "$env:AGENT_FLOW_ROLE='gardener'" }), "role-escalation");
  assert.equal(d("orchestrator", "bash", { command: "AGENT_FLOW_ROLE=reviewer pi -p --tools read,grep,find,ls 'review' > .agent-flow/artifacts/issue-1/review-r1.json" }), null);
});

test("unknown roles fail closed", () => {
  const r = parseRole("superuser");
  assert.equal(r.role, "reviewer");
  assert.match(r.warning, /failing closed/);
  assert.equal(parseRole(undefined).role, null);
});

test("analyzeShell explains why", () => {
  const f = analyzeShell("rm -rf build && echo ok > log.txt");
  assert.equal(f.mutating, true);
  assert.ok(f.why.length >= 2);
});

test("the Pi hook blocks and returns a reason; read-only roles lose write/edit at session start", async () => {
  process.env.AGENT_FLOW_ROLE = "reviewer";
  try {
    const handlers = {};
    let active = ["read", "write", "edit", "bash"];
    guard({
      on: (ev, fn) => ((handlers[ev] ??= []).push(fn), () => {}),
      registerTool: () => {},
      getActiveTools: () => active,
      setActiveTools: (t) => (active = t),
    });
    handlers.session_start[0]({ type: "session_start", reason: "startup" }, { cwd: root, ui: { notify() {} } });
    assert.deepEqual(active, ["read", "bash"]);
    const res = await handlers.tool_call[0]({ type: "tool_call", toolName: "write", toolCallId: "1", input: { path: "TEST.md", content: "x" } }, { cwd: root });
    assert.equal(res.block, true);
    assert.match(res.reason, /read-only/);
  } finally {
    delete process.env.AGENT_FLOW_ROLE;
  }
});

test("guard: a push with no refspec is blocked — it pushes whatever branch is checked out", () => {
  const push = (cmd) => d("implementer", "bash", { command: cmd })?.rule ?? null;
  for (const cmd of ["git push", "git push origin", "git push -u origin", "git -C wt push"]) {
    assert.equal(push(cmd), "explicit-refspec", cmd);
  }
  // Reads, not pushes: dry runs and tag-only pushes name no branch.
  for (const cmd of ["git push --dry-run", "git push -n origin", "git push --tags", "git push origin --tags"]) {
    assert.equal(push(cmd), null, cmd);
  }
  assert.equal(push("git push -u origin agent/issue-1"), null);
});

test("guard: fetch that rewrites local refs, update-ref and replace are blocked", () => {
  const push = (cmd) => d("implementer", "bash", { command: cmd })?.rule ?? null;
  // Even the reviewer: a fetch refspec rewrites whatever branch is checked out.
  assert.equal(d("reviewer", "bash", { command: "git fetch origin +HEAD:main" })?.rule, "fetch-refspec");
  for (const cmd of ["git fetch origin main:main", "git fetch origin +main:main", "git fetch origin refs/heads/main:refs/heads/other"]) {
    assert.equal(push(cmd), "fetch-refspec", cmd);
  }
  // Plain fetches only move remote-tracking refs: allowed.
  for (const cmd of ["git fetch", "git fetch origin", "git fetch origin main", "git fetch --prune origin"]) {
    assert.equal(push(cmd), null, cmd);
  }
  for (const cmd of ["git update-ref refs/heads/main abc123", "git update-ref -d refs/heads/x", "git replace abc123 def456"]) {
    assert.equal(push(cmd), "ref-rewrite", cmd);
  }
  // Listing replacements reads nothing sensitive.
  for (const cmd of ["git replace", "git replace -l", "git replace --list"]) {
    assert.equal(push(cmd), null, cmd);
  }
});

test("Pi guard hook: an internal error blocks a confined role and leaves an ordinary session alone", async () => {
  const boom = { type: "tool_call", toolName: "write", toolCallId: "1", get input() { throw new Error("boom"); } };
  for (const [role, blocks] of [["implementer", true], [undefined, false]]) {
    if (role) process.env.AGENT_FLOW_ROLE = role;
    try {
      const handlers = {};
      guard({ on: (ev, fn) => ((handlers[ev] ??= []).push(fn), () => {}), registerTool: () => {}, getActiveTools: () => [], setActiveTools: () => {} });
      const res = await handlers.tool_call[0](boom, { cwd: root });
      if (blocks) {
        assert.equal(res.block, true);
        assert.match(res.reason, /guard error/);
      } else assert.equal(res, undefined);
    } finally {
      delete process.env.AGENT_FLOW_ROLE;
    }
  }
});

test("a role cannot spawn another agent through the harness's own tool", () => {
  for (const role of ["reviewer", "qa", "implementer", "gardener", "bootstrap"]) {
    for (const tool of ["Task", "Agent", "subagent"]) blocked(d(role, tool, { prompt: "x", subagent_type: "implementer" }), "role-escalation");
  }
  assert.equal(d("orchestrator", "Task", { prompt: "x" }), null);
  assert.equal(d(null, "Task", { prompt: "x" }), null);
});

test("a read-only role cannot write through awk, php, sqlite3, os.system or an archive", () => {
  const cmds = [
    `awk 'BEGIN{print 1 > "f"}'`, `gawk 'BEGIN{system("touch f")}'`, `php -r 'file_put_contents("f",1);'`,
    `python3 -c "import os;os.system('touch f')"`, `python3 -c "import subprocess;subprocess.run(['touch','f'])"`,
    `sqlite3 db 'create table t(x)'`, "tar xf x.tar", "tar -xzf x.tgz", "unzip x.zip", "7z x a.7z", "gunzip a.gz",
  ];
  for (const command of cmds) blocked(d("reviewer", "bash", { command }), "read-only-role");
  for (const command of ["tar tf x.tar", "tar -tzf x.tgz", "unzip -l x.zip", "awk '{print $1}' a.txt", "sqlite3 db 'select 1'"]) {
    assert.equal(d("reviewer", "bash", { command }), null, command);
  }
});
