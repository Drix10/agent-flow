// install --harness gemini|codex|cursor wires the guard hook, keeps other hooks, is idempotent; Cursor's event shapes are understood.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(PKG, "bin/agent-flow.js");

function proj(fn) {
  const dir = mkdtempSync(join(tmpdir(), "af-hook-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ version: "1", protected_paths: ["keep/**"] }));
    mkdirSync(join(dir, "node_modules/@drix10"), { recursive: true });
    // A real copy: pkgRoot is realpath'd, so a symlink into the checkout would look like "not installed here".
    for (const f of ["bin", "extensions", "skills", "templates", "schemas", ".codex", ".gemini", "package.json"]) cpSync(join(PKG, f), join(dir, "node_modules/@drix10/agent-flow", f), { recursive: true });
    return fn(dir, (...a) => spawnSync(process.execPath, [join(dir, "node_modules/@drix10/agent-flow/bin/agent-flow.js"), ...a], { cwd: dir, encoding: "utf-8" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const guard = (dir, ev) => spawnSync(process.execPath, [BIN, "guard"], { cwd: dir, input: JSON.stringify(ev), encoding: "utf-8" });

test("gemini and codex: hook written in place, other hooks kept, idempotent", () => {
  for (const [h, file, ev] of [["gemini", ".gemini/settings.json", "BeforeTool"], ["codex", ".codex/hooks.json", "PreToolUse"]]) {
    proj((dir, cli) => {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), JSON.stringify({ theme: "x", hooks: { [ev]: [{ matcher: "z", hooks: [{ type: "command", command: "echo mine" }] }] } }));
      assert.equal(cli("install", "--harness", h).status, 0);
      const first = readFileSync(join(dir, file), "utf-8");
      const j = JSON.parse(first);
      assert.equal(j.theme, "x");
      assert.equal(j.hooks[ev].length, 2);
      assert.match(JSON.stringify(j.hooks[ev]), /echo mine/);
      assert.match(JSON.stringify(j.hooks[ev]), /agent-flow.*guard/);
      cli("install", "--harness", h);
      assert.equal(readFileSync(join(dir, file), "utf-8"), first);
    });
  }
});

test("cursor: three fail-closed events, and its tool-less payloads are guarded", () => {
  proj((dir, cli) => {
    assert.equal(cli("install", "--harness", "cursor").status, 0);
    const j = JSON.parse(readFileSync(join(dir, ".cursor/hooks.json"), "utf-8"));
    assert.equal(j.version, 1);
    for (const e of ["beforeShellExecution", "beforeReadFile", "preToolUse"]) assert.equal(j.hooks[e][0].failClosed, true);
    assert.equal(guard(dir, { command: "rm -rf keep", cwd: dir }).status, 2);
    assert.equal(guard(dir, { command: "ls", cwd: dir }).status, 0);
    assert.equal(guard(dir, { file_path: join(dir, ".env"), cwd: dir }).status, guard(dir, { tool_name: "Read", tool_input: { file_path: join(dir, ".env") }, cwd: dir }).status);
  });
});

test("codex-style payloads: exec_command is a shell, apply_patch a write", () => {
  proj((dir) => {
    assert.equal(guard(dir, { tool_name: "exec_command", tool_input: { cmd: "rm -rf keep" }, cwd: dir }).status, 2);
    assert.equal(guard(dir, { tool_name: "run_shell_command", tool_input: { command: "rm -rf keep" }, cwd: dir }).status, 2);
    assert.equal(guard(dir, { tool_name: "write_file", tool_input: { file_path: join(dir, "keep/a.txt"), content: "x" }, cwd: dir }).status, 2);
  });
});

test("harness payload shapes from the review: patches, replace, argv shells, workdir, string input, wiring", () => {
  proj((dir) => {
    const patch = "*** Begin Patch\n*** Update File: keep/a\n@@\n-a\n+b\n*** End Patch";
    const blocked = (ev) => assert.equal(guard(dir, { cwd: dir, ...ev }).status, 2, JSON.stringify(ev));
    const allowed = (ev) => assert.equal(guard(dir, { cwd: dir, ...ev }).status, 0, JSON.stringify(ev));
    blocked({ tool_name: "apply_patch", tool_input: { command: patch } });
    blocked({ tool_name: "apply_patch", tool_input: { patchText: patch } });
    blocked({ tool_name: "replace", tool_input: { file_path: "keep/a", old_string: "a", new_string: "b" } });
    blocked({ tool_name: "edit_file", tool_input: { target_file: "keep/a" } });
    blocked({ tool_name: "shell", tool_input: { command: ["bash", "-lc", "rm -rf keep"] } });
    blocked({ tool_name: "local_shell", tool_input: { command: ["rm", "-rf", "keep"] } });
    blocked({ tool_name: "unified_exec", tool_input: { cmd: "rm -rf keep" } });
    blocked({ tool_name: "run_shell_command", tool_input: { command: "rm -rf a", dir_path: "keep" } });
    blocked({ tool_name: "bash", tool_input: { command: "rm -rf a", workdir: "keep" } });
    blocked({ tool_name: "Shell", tool_input: "rm -rf keep" });
    blocked({ tool_name: "write_file", tool_input: { file_path: ".gemini/settings.json", content: "{}" } });
    blocked({ tool_name: "write_file", tool_input: { file_path: ".cursor/hooks.json", content: "{}" } });
    blocked({ tool_name: "read_many_files", tool_input: { include: [".env"] } });
    allowed({ tool_name: "local_shell", tool_input: { command: ["ls", "-la"] } });
    allowed({ tool_name: "run_shell_command", tool_input: { command: "ls", dir_path: "." } });
  });
});

test("install keeps user hooks that merely mention agent-flow and guard", () => {
  proj((dir, cli) => {
    mkdirSync(join(dir, ".gemini"), { recursive: true });
    writeFileSync(join(dir, ".gemini/settings.json"), JSON.stringify({ hooks: { BeforeTool: [{ matcher: "x", hooks: [{ type: "command", command: "./scripts/agent-flow-guard.sh" }] }] } }));
    cli("install", "--harness", "gemini");
    const s = readFileSync(join(dir, ".gemini/settings.json"), "utf-8");
    assert.match(s, /agent-flow-guard\.sh/);
    assert.match(s, /agent-flow\/bin\/agent-flow\.js\\" guard/);
  });
});

test("install --harness claude in a repo with no node_modules vendors the runtime and the hook runs from it", () => {
  const dir = mkdtempSync(join(tmpdir(), "af-vendor-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "app.py"), "print(1)\n");
    writeFileSync(join(dir, ".env"), "K=1\n");
    const r = spawnSync(process.execPath, [BIN, "install", "--harness", "claude"], { cwd: dir, encoding: "utf-8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const cmd = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf-8")).hooks.PreToolUse[0].hooks[0].command;
    assert.match(cmd, /\.agent-flow-runtime\/bin\/agent-flow\.js/);
    assert.equal(spawnSync("git", ["ls-files", "--others", "package.json"], { cwd: dir, encoding: "utf-8" }).stdout.trim(), "");
    const bin = join(dir, ".agent-flow-runtime/bin/agent-flow.js");
    const g = spawnSync(process.execPath, [bin, "guard"], { cwd: dir, input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "cat .env" } }), encoding: "utf-8" });
    assert.equal(g.status, 2, "the vendored guard blocks an env-file read");
    assert.equal(spawnSync(process.execPath, [bin, "guard", "--check"], { cwd: dir, encoding: "utf-8" }).status, 0);
    assert.equal(spawnSync(process.execPath, [bin, "schema", "reviewer"], { cwd: dir, encoding: "utf-8" }).status, 0, "schemas are vendored too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the vendored runtime is invisible to scans: no risk surfaces, no dependency-manifest bump", () => {
  const dir = mkdtempSync(join(tmpdir(), "af-vendor-scan-"));
  try {
    const git = (...a) => spawnSync("git", ["-c", "user.email=a@b", "-c", "user.name=n", ...a], { cwd: dir, encoding: "utf-8" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "app.py"), "print(1)\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "feat");
    assert.equal(spawnSync(process.execPath, [BIN, "install", "--harness", "claude"], { cwd: dir, encoding: "utf-8" }).status, 0);
    git("add", "-A");
    git("commit", "-qm", "install");
    const run = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: "utf-8" }).stdout;
    assert.doesNotMatch(run("classify", "--base", "main"), /dependency manifest/);
    assert.doesNotMatch(run("audit-risk"), /agent-flow-runtime/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a vendored install: local state is git-excluded, the pre-commit hook finds the runtime, and manifest sync keeps the human's keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "af-vendor-flow-"));
  try {
    const git = (...a) => spawnSync("git", ["-c", "user.email=a@b", "-c", "user.name=n", ...a], { cwd: dir, encoding: "utf-8" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "AGENTS.md"), "# rules\nSee `src/`.\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.py"), "print(1)\n");
    const manifest = { version: "2", repo: "x", context_files: [{ path: "AGENTS.md", references: [] }], protected_paths: ["src/secret/**"], risk_boundaries: [{ path: "src/**", risk_level: "critical" }], gates: [{ name: "t", command: "true", os: ["linux"] }] };
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify(manifest, null, 4));
    const af = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: "utf-8" });
    const inst = af("install", "--harness", "claude");
    assert.equal(inst.status, 0, inst.stdout);
    assert.match(inst.stdout, /commit what install wrote \(including \.agent-flow-runtime\//);
    assert.equal(git("check-ignore", "-q", ".agent-flow/audit.jsonl").status, 0, ".agent-flow/ is excluded");
    assert.notEqual(git("check-ignore", "-q", ".agent-flow-runtime/bin/agent-flow.js").status, 0, "the runtime is not");

    const vend = join(dir, ".agent-flow-runtime/bin/agent-flow.js");
    assert.equal(spawnSync(process.execPath, [vend, "hook", "install"], { cwd: dir, encoding: "utf-8" }).status, 0);
    const hook = readFileSync(join(dir, ".git/hooks/pre-commit"), "utf-8");
    assert.match(hook, /\.agent-flow-runtime\/bin\/agent-flow\.js/);

    const dry = af("manifest", "sync", "--json");
    const plan = JSON.parse(dry.stdout);
    assert.deepEqual(plan.added_files, ["CLAUDE.md"], "install's CLAUDE.md is picked up");
    assert.equal(plan.written, false, "nothing written without --yes");
    assert.equal(af("manifest", "sync", "--yes").status, 0);
    const after = JSON.parse(readFileSync(join(dir, "CONTEXT_MANIFEST.json"), "utf-8"));
    assert.deepEqual([after.protected_paths, after.risk_boundaries, after.gates], [manifest.protected_paths, manifest.risk_boundaries, manifest.gates]);
    assert.deepEqual(after.context_files.find((c) => c.path === "AGENTS.md").references.map((r) => r.path), ["src/"]);
    assert.match(readFileSync(join(dir, "CONTEXT_MANIFEST.json"), "utf-8"), /^\{\n {4}"/, "indentation kept");
    assert.match(JSON.parse(af("manifest", "sync", "--json").stdout).changed + "", /false/, "a second sync is a no-op");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-installing replaces the vendored runtime: a file the new version dropped does not linger", () => {
  const dir = mkdtempSync(join(tmpdir(), "af-vendor-replace-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    const inst = () => spawnSync(process.execPath, [BIN, "install", "--harness", "claude", "--force"], { cwd: dir, encoding: "utf-8" });
    assert.equal(inst().status, 0);
    const stale = join(dir, ".agent-flow-runtime/extensions/lib/removed-in-new-version.js");
    writeFileSync(stale, "export default 1;\n");
    assert.equal(inst().status, 0);
    assert.equal(spawnSync("git", ["ls-files", "--others", "--exclude-standard", "--", ".agent-flow-runtime/extensions/lib/removed-in-new-version.js"], { cwd: dir, encoding: "utf-8" }).stdout.trim(), "", "ls-files lists it only if it still exists");
    assert.throws(() => readFileSync(stale), /ENOENT/);
    assert.equal(spawnSync(process.execPath, [join(dir, ".agent-flow-runtime/bin/agent-flow.js"), "--version"], { encoding: "utf-8" }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
