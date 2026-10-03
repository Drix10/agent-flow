// Findings from running `agent-flow run` unattended on a real repository (hypothesis-arena, Windows):
// the guard's script-file hole and its prose false positives, rule files an agent could change,
// merged work that couldn't be marked done, and a usage limit that parked work for good.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "../extensions/lib/guard.js";
import { classifyFiles } from "../extensions/lib/classify.js";
import { checkBinding, mergedInto } from "../extensions/lib/binding.js";
import { runIssue, usageLimit } from "../extensions/lib/orchestrate.js";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
const git = (cwd, ...a) => spawnSync("git", a, { cwd, encoding: "utf-8" });

function repo(name, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), `af-${name}-`));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.test");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "core.autocrlf", "false");
  for (const [f, body] of Object.entries({ "README.md": "# r\n", ...files })) {
    mkdirSync(join(dir, ...f.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

const manifest = { protected_paths: ["STAGE", "kernel/exec/**"], context_files: [], default_branch: "main" };
const guardIn = (dir) => (role, command) => decide({ role, toolName: "Bash", input: { command }, cwd: dir, root: dir, manifest });

// ---- guard: prose is not a path ----------------------------------------------------------------

test("guard: program code that only mentions a protected name in prose or comments is not blocked", () => {
  const dir = repo("prose");
  try {
    const d = guardIn(dir);
    for (const cmd of [
      "python3 - <<'EOF'\n# the stage's rules apply here\nopen('docs/a.md','w').write('the stage rules')\nEOF",
      "python3 - <<'EOF'\nopen('docs/a.md','w').write('the STAGE file is frozen')\nEOF",
      "python3 -c \"open('docs/a.md','w').write('the stage rules')\"",
      "node -e \"require('fs').writeFileSync('docs/a.md', 'stage two')\"",
    ]) assert.equal(d("implementer", cmd), null, cmd);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard: program code that names a protected path as a string still is", () => {
  const dir = repo("literal");
  try {
    const d = guardIn(dir);
    for (const cmd of [
      "python3 - <<'EOF'\nopen('STAGE','w').write('x')\nEOF",
      'python3 - <<EOF\nfrom pathlib import Path\nPath(root + "/STAGE").write_text("x")\nEOF',
      "python3 - <<'EOF'\nopen('kernel/exec/order.cpp','w').write('x')\nEOF",
      "python3 -c \"open('STAGE','w')\"",
      "node -e \"require('fs').writeFileSync('./STAGE','x')\"",
    ]) assert.equal(d("implementer", cmd)?.rule, "protected-path", cmd);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- guard: a script file is checked like the command it contains ------------------------------

test("guard: a new or edited script is checked like a command; the reviewed copy on main is trusted", () => {
  const dir = repo("script", {
    "tools/build.sh": "echo build > out.txt\ncat STAGE\n",
    "tools/check.py": "print(open('STAGE').read())\n",
  });
  try {
    const d = guardIn(dir);
    // The repo's own scripts, unchanged from main: they may read protected files.
    assert.equal(d("implementer", "bash tools/build.sh"), null);
    assert.equal(d("implementer", "python3 tools/check.py"), null);

    // The bypass: write the edit into a file, then run the file.
    writeFileSync(join(dir, "fix.sh"), "echo x > STAGE\n");
    writeFileSync(join(dir, "fix.py"), "open('STAGE', 'w').write('x')\n");
    for (const cmd of ["bash fix.sh", "sh ./fix.sh", "./fix.sh", "python3 fix.py", "cd tools && python3 ../fix.py", "py -u fix.py"]) {
      assert.equal(d("implementer", cmd)?.rule, "protected-path", cmd);
    }
    assert.match(d("implementer", "bash fix.sh").reason, /fix\.sh \(a script that is not on the default branch/);

    // Committing the script on a branch doesn't make it "reviewed": only main's copy is.
    git(dir, "checkout", "-q", "-b", "agent/issue-1");
    git(dir, "add", "fix.sh");
    git(dir, "commit", "-qm", "fix");
    assert.equal(d("implementer", "bash fix.sh")?.rule, "protected-path");

    // Editing a reviewed script counts as new.
    writeFileSync(join(dir, "tools/build.sh"), "echo x > STAGE\n");
    assert.equal(d("implementer", "bash tools/build.sh")?.rule, "protected-path");

    // A harmless new script still runs, and so does one that is gone (the command just fails).
    writeFileSync(join(dir, "ok.py"), "open('docs/notes.md', 'w').write('the stage rules')\n");
    assert.equal(d("implementer", "python3 ok.py"), null);
    assert.equal(d("implementer", "python3 missing.py"), null);
    // Inline code and modules aren't files: read where they already are.
    assert.equal(d("implementer", "python3 -m pytest -q tests"), null);

    // Outside the repository is new by definition (a scratch dir is where the bypass lived).
    const scratch = mkdtempSync(join(tmpdir(), "af-scratch-"));
    try {
      writeFileSync(join(scratch, "edit.sh"), `echo x > ${join(dir, "STAGE").replace(/\\/g, "/")}\n`);
      assert.ok(d("implementer", `bash ${join(scratch, "edit.sh").replace(/\\/g, "/")}`), "a scratch script that writes STAGE is blocked");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the rule files --------------------------------------------------------------------------

test("the Implementer can't change CONTEXT_MANIFEST.json, and a pull request that does is critical", () => {
  const dir = repo("gov", { "CONTEXT_MANIFEST.json": JSON.stringify(manifest) });
  try {
    const w = (path) => decide({ role: "implementer", toolName: "Write", input: { file_path: path, content: "{}" }, cwd: dir, root: dir, manifest });
    assert.equal(w("CONTEXT_MANIFEST.json")?.rule, "governance");
    assert.equal(decide({ role: "implementer", toolName: "Bash", input: { command: "sed -i s/STAGE// CONTEXT_MANIFEST.json" }, cwd: dir, root: dir, manifest })?.rule, "governance");
    // The Gardener still maintains it; the review it then needs is a person's.
    assert.equal(decide({ role: "gardener", toolName: "Write", input: { file_path: "CONTEXT_MANIFEST.json", content: "{}" }, cwd: dir, root: dir, manifest }), null);

    for (const f of ["CONTEXT_MANIFEST.json", ".risk-baseline.json"]) {
      const c = classifyFiles([f, "docs/a.md"], { ...manifest, risk_boundaries: [{ path: "docs/**", risk_level: "low" }] });
      assert.equal(c.risk_level, "critical", f);
      assert.equal(c.human_approval_required, true, f);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codeowners also covers the rule files, once there are protected paths", () => {
  const dir = repo("owners", { "CONTEXT_MANIFEST.json": JSON.stringify({ version: "2", ...manifest }), ".risk-baseline.json": "{}" });
  try {
    const r = spawnSync(process.execPath, [BIN, "codeowners", "--owner", "@me", "--json"], { cwd: dir, encoding: "utf-8", env: { ...process.env, AGENT_FLOW_OFFLINE: "1" } });
    const lines = JSON.parse(r.stdout).lines;
    assert.ok(lines.includes("/CONTEXT_MANIFEST.json  @me"), lines.join("\n"));
    assert.ok(lines.includes("/.risk-baseline.json  @me"), lines.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- merged work can be marked done ----------------------------------------------------------

function bound(dir, head) {
  mkdirSync(join(dir, ".agent-flow"), { recursive: true });
  const lines = [
    { event: "role_run", issue: 1, role: "reviewer", round: 1, ok: true, verdict: "approved", head },
    { event: "role_run", issue: 1, role: "qa", round: 1, ok: true, verdict: "passed", head },
  ];
  writeFileSync(join(dir, ".agent-flow", "audit.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

test("binding: once the pull request is squash-merged and its branch deleted, the approved commit is the proof", () => {
  const dir = repo("merged", { "a.txt": "1\n2\n3\n" });
  try {
    git(dir, "checkout", "-q", "-b", "agent/issue-1");
    writeFileSync(join(dir, "a.txt"), "1\n2 changed\n3\n");
    git(dir, "commit", "-qam", "change");
    writeFileSync(join(dir, "b.txt"), "new\n");
    git(dir, "add", "b.txt");
    git(dir, "commit", "-qm", "more");
    const head = git(dir, "rev-parse", "HEAD").stdout.trim();
    bound(dir, head);
    assert.equal(checkBinding(dir, 1, 1, []).ok, true, "while the branch exists");

    // Unmerged and deleted: nothing proves the change landed.
    git(dir, "checkout", "-q", "main");
    git(dir, "branch", "-q", "-D", "agent/issue-1");
    const lost = checkBinding(dir, 1, 1, []);
    assert.equal(lost.ok, false);
    assert.match(lost.problems[0], /isn't on the default branch/);

    // Squash merge (what --auto-merge asks GitHub for), with an unrelated commit landing first.
    writeFileSync(join(dir, "c.txt"), "other\n");
    git(dir, "add", "c.txt");
    git(dir, "commit", "-qm", "unrelated");
    git(dir, "merge", "-q", "--squash", head);
    git(dir, "commit", "-qm", "squashed (#1)");
    assert.equal(mergedInto(dir, head), "refs/heads/main");
    const ok = checkBinding(dir, 1, 1, []);
    assert.equal(ok.ok, true, ok.problems.join("; "));
    assert.equal(ok.tip, head);

    // The same proof through the CLI: Completed, not parked in Needs Me.
    spawnSync(process.execPath, [BIN, "state", "update", "--issue", "1", "--state", "Working", "--phase", "qa", "--round", "1"], { cwd: dir, encoding: "utf-8", env: { ...process.env, AGENT_FLOW_OFFLINE: "1", AGENT_FLOW_ROLE: "" } });
    const r = spawnSync(process.execPath, [BIN, "state", "update", "--issue", "1", "--state", "Completed", "--round", "1", "--json"], { cwd: dir, encoding: "utf-8", env: { ...process.env, AGENT_FLOW_OFFLINE: "1", AGENT_FLOW_ROLE: "" } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout).state, "Completed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("binding: a merged commit other than the approved one does not count", () => {
  const dir = repo("merged-other", { "a.txt": "1\n" });
  try {
    git(dir, "checkout", "-q", "-b", "agent/issue-1");
    writeFileSync(join(dir, "a.txt"), "approved\n");
    git(dir, "commit", "-qam", "approved");
    const approved = git(dir, "rev-parse", "HEAD").stdout.trim();
    writeFileSync(join(dir, "a.txt"), "changed after approval\n");
    git(dir, "commit", "-qam", "later");
    const later = git(dir, "rev-parse", "HEAD").stdout.trim();
    bound(dir, approved);
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--squash", later);
    git(dir, "commit", "-qm", "squashed");
    git(dir, "branch", "-q", "-D", "agent/issue-1");
    assert.equal(mergedInto(dir, approved), null);
    assert.equal(checkBinding(dir, 1, 1, []).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- usage limits --------------------------------------------------------------------------

test("usage limits: the reset time is read in the zone the message names", () => {
  const now = Date.parse("2026-10-02T10:43:05Z"); // 16:13:05 in Kolkata
  const mins = (r) => Math.round((r.reset_at - now) / 60_000);
  assert.equal(mins(usageLimit("harness error: success: You've hit your session limit · resets 5:10pm (Asia/Kolkata)", now)), 58);
  assert.equal(mins(usageLimit("You've hit your session limit · resets 4am (Asia/Kolkata)", now)), 11 * 60 + 47 + 1, "a time already past today is tomorrow");
  assert.equal(mins(usageLimit("You've hit your weekly limit · resets Oct 5, 3pm (Asia/Kolkata)", now)), 3 * 1440 - 73 + 1);
  assert.equal(usageLimit("Claude AI usage limit reached|1790944000", now).reset_at, 1790944000 * 1000 + 60_000);
  assert.deepEqual(usageLimit("You've hit your session limit", now), { reset_at: null, says: "You've hit your session limit" });
  assert.equal(usageLimit("harness error: error_max_turns", now), null);
});

const N = 100001;
function runRepo() {
  const dir = mkdtempSync(join(tmpdir(), "af-limit-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.test");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "AGENTS.md"), "# rules\n");
  writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ version: "2", default_branch: "main", context_files: [{ path: "AGENTS.md", references: [] }], protected_paths: ["secret/**"], pipeline: { max_review_rounds: 2 } }));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}
const afIn = (dir) => (a) => {
  const env = { ...process.env, NO_COLOR: "1", AGENT_FLOW_OFFLINE: "1" };
  delete env.AGENT_FLOW_ROLE;
  const r = spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: "utf-8", env });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const sh = (cmd, a, cwd) => {
  const r = spawnSync(cmd, a, { cwd, encoding: "utf-8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const LIMIT_RAW = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "You've hit your session limit · resets 5:10pm (Asia/Kolkata)", session_id: "s-123456789", total_cost_usd: 0 });

/** Implementer hits the limit `limited` times, then works; reviewer and QA pass. */
function agent(limited) {
  const calls = [];
  let impl = 0;
  const spawner = async (spec) => {
    const role = spec.env.AGENT_FLOW_ROLE;
    calls.push(role);
    const wt = join(spec.cwd, ".worktrees", `issue-${N}`);
    let raw;
    if (role === "implementer" && impl++ < limited) raw = LIMIT_RAW;
    else if (role === "implementer") {
      writeFileSync(join(wt, "feature.txt"), "x\n");
      git(wt, "add", "-A");
      git(wt, "commit", "-qm", "feature");
      const commit = git(wt, "rev-parse", "HEAD").stdout.trim();
      raw = JSON.stringify({ status: "ready_for_review", issue: N, branch: `agent/issue-${N}`, commit, files_changed: ["feature.txt"], criteria: [{ criterion: "it works", evidence: "test" }], checks: { test: "passed" } });
    } else if (role === "reviewer") raw = JSON.stringify({ status: "approved", round: 1, summary: "ok", findings: [], criteria: [{ criterion: "it works", met: true, evidence: "read" }] });
    else raw = JSON.stringify({ status: "passed", issue: N, commands: [{ name: "t", command: "node t", exit_code: 0, raw_output: "ok" }] });
    writeFileSync(`${spec.base}.argv`, JSON.stringify(spec.argv));
    writeFileSync(`${spec.base}.raw`, raw);
    writeFileSync(`${spec.base}.exit`, raw === LIMIT_RAW ? "1" : "0");
    return { exit: raw === LIMIT_RAW ? 1 : 0, seconds: 1 };
  };
  return { spawner, calls };
}

async function runWith(dir, a, over) {
  const logs = [];
  const sleeps = [];
  const now = Date.parse("2026-10-02T10:43:05Z");
  const result = await runIssue({
    root: dir, issue: N, title: "Add a thing", body: "It should print the thing, so that users see it.", fromGitHub: false,
    af: afIn(dir), sh, spawner: a.spawner, log: (e) => logs.push(e), pr: false, timeoutSec: 30, commands: "node t",
    sleep: async (ms) => void sleeps.push(ms), now: () => now, ...over,
  });
  return { result, logs, sleeps };
}

test("run: a role that hits a usage limit waits for the reset and runs again, instead of parking the issue", async () => {
  const dir = runRepo();
  try {
    const a = agent(2);
    const { result, logs, sleeps } = await runWith(dir, a, {});
    assert.equal(result.status, "ready", JSON.stringify(result));
    assert.deepEqual(a.calls, ["implementer", "implementer", "implementer", "reviewer", "qa"]);
    assert.equal(sleeps.length, 2);
    assert.equal(Math.round(sleeps[0] / 60_000), 58, "until a minute after the stated reset");
    assert.ok(logs.some((l) => l.kind === "warn" && /usage limit reached .*waiting until/.test(l.text)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: a usage limit further away than --limit-wait (or 0) goes to Needs Me, saying when to run it again", async () => {
  for (const limitWaitSec of [0, 1800]) {
    const dir = runRepo();
    try {
      const a = agent(5);
      const { result, sleeps } = await runWith(dir, a, { limitWaitSec });
      assert.equal(result.status, "needs_me");
      assert.equal(result.category, "usage_limit");
      assert.match(result.reason, /run `agent-flow run 100001` again after/);
      assert.deepEqual(sleeps, []);
      assert.deepEqual(a.calls, ["implementer"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const dir = runRepo();
  try {
    const a = agent(10);
    const { result, sleeps } = await runWith(dir, a, {});
    assert.equal(result.category, "usage_limit", "a limit that keeps coming back stops after a few waits");
    assert.equal(sleeps.length, 3);
    assert.match(result.reason, /came back 3 times/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI: --limit-wait takes hours from 0 to 168", () => {
  const dir = runRepo();
  try {
    const r = afIn(dir)(["run", "do it, so that it is done and the tests pass", "--limit-wait", "x", "--dry-run"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--limit-wait/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
