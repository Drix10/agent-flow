// uninstall: take out what install wrote, keep what is yours. The hook files install merges into hold the user's own
// hooks and settings, so they must come through byte-for-byte meaningful; an edited skill is kept and named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isOurHook, stripOurHooks } from "../extensions/lib/uninstall.js";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
const cli = (cwd, args, env = {}) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1", AGENT_FLOW_OFFLINE: "1", AGENT_FLOW_ROLE: "", ...env } });
const read = (p) => JSON.parse(readFileSync(p, "utf-8"));

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "af-uninst-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "AGENTS.md"), "# my rules\n");
  writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ version: "2", context_files: [{ path: "AGENTS.md", references: [] }], protected_paths: ["secret/**"] }));
  return dir;
}

const GUARD = 'node "$CLAUDE_PROJECT_DIR/.agent-flow-runtime/bin/agent-flow.js" guard';

test("isOurHook: agent-flow's own hook commands, not other people's", () => {
  assert.equal(isOurHook(GUARD), true);
  assert.equal(isOurHook('node "$CLAUDE_PROJECT_DIR/.agent-flow-runtime/bin/agent-flow.js" gates stop'), true);
  assert.equal(isOurHook('node "./node_modules/@drix10/agent-flow/bin/agent-flow.js" guard'), true);
  assert.equal(isOurHook('node "$CLAUDE_PROJECT_DIR/.agent-flow-runtime/bin/agent-flow.js" brief'), true);
  assert.equal(isOurHook("echo mine"), false);
  assert.equal(isOurHook('node "other-guard.js" guard'), false, "a guard that isn't agent-flow's");
  assert.equal(isOurHook(undefined), false);
  assert.equal(isOurHook(42), false);
});

test("a user's own hook that merely has agent-flow in its name is never taken for ours", () => {
  for (const cmd of ["./scripts/agent-flow-guard.sh", "bash scripts/agent-flow-brief.sh", 'node "tools/agent-flow-guard.js" guard', "echo agent-flow guard", 'node "./not-agent-flow/bin/other.js" guard']) {
    assert.equal(isOurHook(cmd), false, cmd);
  }
  const mine = { type: "command", command: "./scripts/agent-flow-guard.sh" };
  const r = stripOurHooks({ statusLine: { type: "command", command: "bash ~/agent-flow-statusline.sh" }, hooks: { PreToolUse: [{ matcher: "x", hooks: [mine] }], SessionStart: [{ hooks: [{ type: "command", command: "bash agent-flow-brief.sh" }] }] } }, false);
  assert.equal(r.removed, 0);
  assert.equal(r.empty, false);
  assert.deepEqual(r.config.hooks.PreToolUse[0].hooks[0], mine);
  assert.ok(r.config.statusLine, "a statusLine script with agent-flow in its name is theirs");
  // And the end-to-end path: an install beside such a hook, then an uninstall, leaves it exactly as it was.
  const dir = repo();
  try {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const theirs = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [mine] }], SessionStart: [{ hooks: [{ type: "command", command: "bash agent-flow-brief.sh" }] }] } };
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify(theirs, null, 2));
    assert.equal(cli(dir, ["install", "--harness", "claude"]).status, 0);
    assert.equal(cli(dir, ["uninstall", "--yes"]).status, 0);
    assert.deepEqual(read(join(dir, ".claude", "settings.json")), theirs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stripOurHooks: only our entries leave, in the grouped shape", () => {
  const mine = { type: "command", command: GUARD };
  const theirs = { type: "command", command: "echo mine" };
  const input = {
    permissions: { allow: ["Bash(ls)"] },
    hooks: {
      PreToolUse: [{ matcher: "Write|Edit", hooks: [mine] }, { matcher: "Bash", hooks: [theirs] }, { matcher: "*", hooks: [theirs, mine] }],
      Stop: [{ hooks: [{ type: "command", command: 'node ".agent-flow-runtime/bin/agent-flow.js" gates stop', timeout: 900 }] }],
      PostToolUse: [{ hooks: [theirs] }],
    },
  };
  const before = JSON.stringify(input);
  const r = stripOurHooks(input, false);
  assert.equal(JSON.stringify(input), before, "the input is not modified");
  assert.equal(r.removed, 3);
  assert.equal(r.empty, false);
  assert.deepEqual(r.config.permissions, { allow: ["Bash(ls)"] });
  assert.deepEqual(r.config.hooks.PreToolUse, [{ matcher: "Bash", hooks: [theirs] }, { matcher: "*", hooks: [theirs] }], "their group stays, the mixed one keeps its matcher and their hook");
  assert.equal(r.config.hooks.Stop, undefined, "an event that held only ours is gone");
  assert.deepEqual(r.config.hooks.PostToolUse, [{ hooks: [theirs] }]);
});

test("stripOurHooks: a file holding only ours is empty; Cursor's flat shape and its version key", () => {
  const onlyOurs = { hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: GUARD }] }] } };
  const a = stripOurHooks(onlyOurs, false);
  assert.deepEqual(a.config, {});
  assert.equal(a.empty, true);

  const cursor = { version: 1, hooks: { beforeShellExecution: [{ command: 'node "./.agent-flow-runtime/bin/agent-flow.js" guard', failClosed: true }, { command: "./lint.sh" }], preToolUse: [{ command: 'node "./.agent-flow-runtime/bin/agent-flow.js" guard', failClosed: true }] } };
  const b = stripOurHooks(cursor, true);
  assert.equal(b.removed, 2);
  assert.deepEqual(b.config, { version: 1, hooks: { beforeShellExecution: [{ command: "./lint.sh" }] } });
  assert.equal(b.empty, false);
  const c = stripOurHooks({ version: 1, hooks: { preToolUse: [cursor.hooks.preToolUse[0]] } }, true);
  assert.equal(c.empty, true, "only `version` left: nothing of the user's");

  // Nothing of ours: nothing removed, and a user's hooks file is not "empty".
  const none = stripOurHooks({ hooks: { PreToolUse: [{ hooks: [{ command: "echo" }] }] } }, false);
  assert.equal(none.removed, 0);
  assert.equal(none.empty, false);
  assert.equal(stripOurHooks({}, false).empty, true);
  assert.equal(stripOurHooks({ hooks: "nonsense" }, false).removed, 0, "an odd shape is left alone");
});

test("uninstall: a full round trip keeps the user's settings and hooks, removes the rest, and names what was edited", () => {
  const dir = repo();
  try {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }] } }, null, 2));
    assert.equal(cli(dir, ["install", "--harness", "claude", "--stop-gate"]).status, 0);
    assert.equal(cli(dir, ["hook", "install"]).status, 0);
    assert.ok(existsSync(join(dir, ".agent-flow-runtime")));
    assert.ok(existsSync(join(dir, ".git", "hooks", "pre-commit")));
    // One skill the user customised, and one skill of their own beside ours.
    writeFileSync(join(dir, ".claude", "skills", "agent-flow-implementer", "SKILL.md"), "# my own implementer\n");
    mkdirSync(join(dir, ".claude", "skills", "mine"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", "mine", "SKILL.md"), "# mine\n");

    const preview = cli(dir, ["uninstall"]);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /remove +\.claude\/skills\/agent-flow-bootstrap/);
    assert.match(preview.stdout, /keep +\.claude\/skills\/agent-flow-implementer .*edited since install/);
    assert.match(preview.stdout, /strip +\.claude\/settings\.json .*your other settings and hooks stay/);
    assert.match(preview.stdout, /remove +\.git\/hooks\/pre-commit/);
    assert.match(preview.stdout, /remove +\.agent-flow-runtime\//);
    assert.match(preview.stdout, /nothing changed: re-run with --yes/);
    assert.ok(existsSync(join(dir, ".claude", "skills", "agent-flow-bootstrap")), "a preview changes nothing");

    const r = cli(dir, ["uninstall", "--yes"]);
    assert.equal(r.status, 0, r.stderr);
    for (const s of ["agent-flow-bootstrap", "agent-flow-gardener", "agent-flow-invoking-agents", "agent-flow-qa", "agent-flow-reviewer"]) assert.ok(!existsSync(join(dir, ".claude", "skills", s)), `${s} removed`);
    assert.equal(readFileSync(join(dir, ".claude", "skills", "agent-flow-implementer", "SKILL.md"), "utf-8"), "# my own implementer\n", "the edited skill is kept as it was");
    assert.equal(readFileSync(join(dir, ".claude", "skills", "mine", "SKILL.md"), "utf-8"), "# mine\n", "a skill of the user's own is never touched");
    assert.ok(!existsSync(join(dir, ".claude", "agents", "reviewer.md")));
    const settings = read(join(dir, ".claude", "settings.json"));
    assert.deepEqual(settings, { permissions: { allow: ["Bash(ls)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }] } }, "exactly the user's settings are left");
    assert.ok(!existsSync(join(dir, ".git", "hooks", "pre-commit")));
    assert.ok(!existsSync(join(dir, ".agent-flow-runtime")));
    for (const f of ["AGENTS.md", "CONTEXT_MANIFEST.json"]) assert.ok(existsSync(join(dir, f)), `${f} is yours and stays`);
    // The record keeps only what is still there, so a later install or update still sees the edit.
    const rec = read(join(dir, ".claude", "agent-flow-install.json"));
    assert.deepEqual(Object.keys(rec.files), [".claude/skills/agent-flow-implementer"]);
    assert.match(r.stdout, /left alone \(yours\): AGENTS\.md/);
    assert.match(r.stdout, /uninstalled claude/);

    const audit = readFileSync(join(dir, ".agent-flow", "audit.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.event === "uninstall");
    assert.ok(audit && audit.removed.includes(".claude/skills/agent-flow-bootstrap") && audit.kept.includes(".claude/skills/agent-flow-implementer"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstall: a clean install leaves nothing behind but your own files", () => {
  const dir = repo();
  try {
    assert.equal(cli(dir, ["install", "--harness", "claude"]).status, 0);
    assert.equal(cli(dir, ["hook", "install"]).status, 0);
    assert.equal(cli(dir, ["uninstall", "--yes"]).status, 0);
    assert.ok(!existsSync(join(dir, ".claude")), "the folder install made is gone, settings.json and all");
    assert.ok(!existsSync(join(dir, ".agent-flow-runtime")));
    assert.ok(existsSync(join(dir, "AGENTS.md")) && existsSync(join(dir, "CONTEXT_MANIFEST.json")));
    assert.ok(existsSync(join(dir, "CLAUDE.md")), "the @AGENTS.md import is left for the user to decide");
    // And it can be put back.
    assert.equal(cli(dir, ["install", "--harness", "claude"]).status, 0);
    assert.ok(existsSync(join(dir, ".claude", "skills", "agent-flow-bootstrap")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstall --harness: one harness leaves, the others and the shared runtime and hook stay", () => {
  const dir = repo();
  try {
    assert.equal(cli(dir, ["install", "--harness", "claude"]).status, 0);
    assert.equal(cli(dir, ["install", "--harness", "cursor"]).status, 0);
    assert.equal(cli(dir, ["hook", "install"]).status, 0);
    assert.ok(existsSync(join(dir, ".cursor", "hooks.json")));
    const r = cli(dir, ["uninstall", "--harness", "cursor", "--yes"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /keep +\.agent-flow-runtime\/ .*still used by claude/);
    assert.ok(!existsSync(join(dir, ".cursor")), "cursor's skills and hooks.json are gone");
    assert.ok(existsSync(join(dir, ".claude", "skills", "agent-flow-bootstrap")), "claude is untouched");
    assert.ok(existsSync(join(dir, ".agent-flow-runtime")), "the runtime claude's hook runs is still there");
    assert.ok(existsSync(join(dir, ".git", "hooks", "pre-commit")));
    assert.ok(readFileSync(join(dir, ".claude", "settings.json"), "utf-8").includes("agent-flow"), "claude's guard hook is still wired");
    assert.equal(cli(dir, ["uninstall", "--harness", "cursor"]).status, 2, "cursor is no longer installed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstall: a skills folder shared by several harnesses goes only with the last of them", () => {
  const dir = repo();
  try {
    assert.equal(cli(dir, ["install", "--harness", "codex"]).status, 0);
    assert.equal(cli(dir, ["install", "--harness", "agents"]).status, 0);
    const first = cli(dir, ["uninstall", "--harness", "agents", "--yes"]);
    assert.match(first.stdout, /keep +\.agents\/skills\/ .*still used by codex/);
    assert.ok(existsSync(join(dir, ".agents", "skills", "agent-flow-bootstrap")), "codex still needs it");
    assert.ok(existsSync(join(dir, ".codex", "hooks.json")));
    const second = cli(dir, ["uninstall", "--harness", "codex", "--yes"]);
    assert.equal(second.status, 0, second.stderr);
    assert.ok(!existsSync(join(dir, ".agents")), "now nothing needs it");
    assert.ok(!existsSync(join(dir, ".codex", "hooks.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstall: a hook file that isn't valid JSON, or a pre-commit hook that isn't ours, is left exactly as it is", () => {
  const dir = repo();
  try {
    assert.equal(cli(dir, ["install", "--harness", "claude"]).status, 0);
    writeFileSync(join(dir, ".claude", "settings.json"), "{ not json");
    const hook = join(dir, ".git", "hooks", "pre-commit");
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\necho my own hook\n");
    const r = cli(dir, ["uninstall", "--yes"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /keep +\.claude\/settings\.json .*not valid JSON/);
    assert.match(r.stdout, /keep +\.git\/hooks\/pre-commit .*not agent-flow's hook/);
    assert.equal(readFileSync(join(dir, ".claude", "settings.json"), "utf-8"), "{ not json");
    assert.equal(readFileSync(hook, "utf-8"), "#!/bin/sh\necho my own hook\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstall: --keep-runtime and --keep-hook; a modified runtime is kept and named", () => {
  const dir = repo();
  try {
    assert.equal(cli(dir, ["install", "--harness", "claude"]).status, 0);
    assert.equal(cli(dir, ["hook", "install"]).status, 0);
    const kept = cli(dir, ["uninstall", "--yes", "--keep-runtime", "--keep-hook"]);
    assert.equal(kept.status, 0, kept.stderr);
    assert.ok(existsSync(join(dir, ".agent-flow-runtime")) && existsSync(join(dir, ".git", "hooks", "pre-commit")));
    // Reinstall, then modify the runtime: it must not be deleted out from under a local patch.
    assert.equal(cli(dir, ["install", "--harness", "claude"]).status, 0);
    writeFileSync(join(dir, ".agent-flow-runtime", "PATCHED.txt"), "local change\n");
    const r = cli(dir, ["uninstall", "--yes"]);
    assert.match(r.stdout, /keep +\.agent-flow-runtime\/ .*modified since install/);
    assert.ok(existsSync(join(dir, ".agent-flow-runtime", "PATCHED.txt")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstall: --json, nothing installed, an unknown harness, and a pipeline role is refused", () => {
  const dir = repo();
  try {
    const none = cli(dir, ["uninstall"]);
    assert.equal(none.status, 2);
    assert.match(none.stderr, /nothing to uninstall/);
    assert.equal(cli(dir, ["uninstall", "--harness", "nope"]).status, 2);

    assert.equal(cli(dir, ["install", "--harness", "claude"]).status, 0);
    const j = JSON.parse(cli(dir, ["uninstall", "--json"]).stdout);
    assert.equal(j.applied, false);
    assert.deepEqual(j.harnesses, ["claude"]);
    assert.ok(j.items.some((i) => i.label === ".claude/skills/agent-flow-bootstrap" && i.action === "remove"));
    assert.ok(!j.items.some((i) => "config" in i || "raw" in i), "no file contents in the output");
    assert.ok(j.left_alone.includes("CONTEXT_MANIFEST.json"));

    for (const role of ["implementer", "reviewer", "qa", "gardener", "bootstrap", "orchestrator"]) {
      const r = cli(dir, ["uninstall", "--yes"], { AGENT_FLOW_ROLE: role });
      assert.equal(r.status, 2, role);
      assert.match(r.stderr, /may not run `agent-flow uninstall`/);
    }
    assert.ok(existsSync(join(dir, ".claude", "skills", "agent-flow-bootstrap")), "a refused role removed nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstall removes nothing the install record doesn't vouch for in an older install (no record): an unedited copy of this version still goes", () => {
  const dir = repo();
  try {
    assert.equal(cli(dir, ["install", "--harness", "claude"]).status, 0);
    rmSync(join(dir, ".claude", "agent-flow-install.json"));
    const r = cli(dir, ["uninstall", "--yes"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(join(dir, ".claude", "skills", "agent-flow-bootstrap")), "identical to what this version writes: safe to remove");
    assert.match(r.stdout, /keep +\.agent-flow-runtime\/ .*no install record/);
    assert.deepEqual(readdirSync(dir).filter((n) => n === ".claude"), [], "the empty folder goes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstall: an old install with no record in the shared skills folder is read as the generic `agents` target", () => {
  const dir = mkdtempSync(join(tmpdir(), "af-unrec-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  mkdirSync(join(dir, ".agents", "skills", "agent-flow-bootstrap"), { recursive: true });
  writeFileSync(join(dir, ".agents", "skills", "agent-flow-bootstrap", "SKILL.md"), "old copy");
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url)), "uninstall", "--json"], { cwd: dir, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1", AGENT_FLOW_ROLE: "" } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).harnesses, ["agents"]);
});

test("uninstall: pre-rename skill dirs go when still what install wrote, edited ones stay", () => {
  const dir = repo();
  try {
    assert.equal(cli(dir, ["install", "--harness", "claude"]).status, 0);
    renameSync(join(dir, ".claude/skills/agent-flow-qa"), join(dir, ".claude/skills/qa"));
    renameSync(join(dir, ".claude/skills/agent-flow-reviewer"), join(dir, ".claude/skills/reviewer"));
    const recPath = join(dir, ".claude/agent-flow-install.json");
    const rec = read(recPath);
    rec.files[".claude/skills/qa"] = rec.files[".claude/skills/agent-flow-qa"];
    rec.files[".claude/skills/reviewer"] = rec.files[".claude/skills/agent-flow-reviewer"];
    delete rec.files[".claude/skills/agent-flow-qa"];
    delete rec.files[".claude/skills/agent-flow-reviewer"];
    writeFileSync(recPath, JSON.stringify(rec));
    appendFileSync(join(dir, ".claude/skills/reviewer/SKILL.md"), "\nour team rule\n");

    const r = cli(dir, ["uninstall", "--yes"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(join(dir, ".claude/skills/qa")), "the untouched pre-rename dir goes with the rest");
    assert.match(readFileSync(join(dir, ".claude/skills/reviewer/SKILL.md"), "utf-8"), /our team rule/, "the edited pre-rename dir is kept");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
