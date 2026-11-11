// What the guard writes to the audit log for a block: the harness it came from (never a guess), the session, and credentials taken out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { blockEntry, harnessOf } from "../extensions/lib/guardrun.js";
import { redactText } from "../extensions/lib/guard.js";

test("harnessOf reads the harness from the event, and says unknown when it can't", () => {
  assert.equal(harnessOf({ hook_event_name: "PreToolUse", permission_mode: "default", tool_name: "Bash" }), "claude");
  assert.equal(harnessOf({ hook_event_name: "BeforeTool", tool_name: "run_shell_command" }), "gemini");
  assert.equal(harnessOf({ turn_id: "t1", tool_name: "Bash" }), "codex");
  assert.equal(harnessOf({ cursor_version: "1.2", command: "ls" }), "cursor");
  assert.equal(harnessOf({ harness: "opencode", tool_name: "shell" }), "opencode");
  assert.equal(harnessOf({ tool_name: "Bash" }), "unknown");
  assert.equal(harnessOf({ tool_name: "Bash" }, "copilot"), "copilot", "an explicit --harness wins");
  assert.equal(harnessOf({ tool_name: "Bash" }, "../../x"), "unknown", "and is validated");
});

test("blockEntry carries harness, session, agent, model, source and a repo-relative cwd; overrides are named", () => {
  const e = blockEntry({
    harness: "claude",
    ev: { tool_name: "Bash", tool_input: { command: "git push origin main" }, session_id: "s-1", agent_type: "reviewer", model: "m-1" },
    role: null,
    decision: { block: true, rule: "push-default-branch", reason: "[agent-flow guard] nope" },
    root: "/repo",
    cwd: "/repo/sub",
    env: { AGENT_FLOW_ALLOW_PROTECTED: "1" },
  });
  assert.deepEqual([e.event, e.harness, e.session, e.agent, e.model, e.rule, e.cwd, e.source], ["guard_block", "claude", "s-1", "reviewer", "m-1", "push-default-branch", "sub", "live"]);
  assert.deepEqual(e.override, ["allow_protected"]);
  const t = blockEntry({ harness: "pi", ev: { tool_name: "bash", tool_input: {} }, role: null, decision: { block: true, rule: "r", reason: "x" }, root: "/repo", env: { AGENT_FLOW_AUDIT_SOURCE: "probe" } });
  assert.equal(t.source, "probe");
  assert.ok(!("cwd" in t) && !("override" in t));
});

test("redactText removes credentials from free text", () => {
  const cases = [
    ["curl -u admin:hunter2 https://api.example.com/x", /hunter2/],
    ["git clone https://user:s3cr3tpass@host.example/r.git", /s3cr3tpass/],
    ["tool --password hunter2 --token=abcd1234", /hunter2|abcd1234/],
    ["curl -H 'Authorization: Token abcdefghijklmnop12345' x", /abcdefghijklmnop12345/],
    ["use sk_live_abcdefghijklmnop1234 now", /sk_live_abcdefghijklmnop1234/],
    ["glpat-abcdefghijklmnopqrst", /glpat-abcdefghijklmnopqrst/],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk", /eyJhbGciOiJIUzI1NiJ9/],
    ["AKIA" + "ABCDEFGHIJKLMNOP", /AKIAABCDEFGHIJKLMNOP/],
  ];
  for (const [text, leak] of cases) {
    const r = redactText(text);
    assert.doesNotMatch(r, leak, text);
    assert.match(r, /REDACTED/, text);
  }
  assert.equal(redactText("git status"), "git status");
  assert.equal(redactText("x".repeat(300), 20).length, 20);
});

test("the hook writes the inferred harness and the session id into the audit line", () => {
  const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "af-gr-"));
  try {
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    const hook = (ev, ...extra) => spawnSync(process.execPath, [BIN, "guard", ...extra], { cwd: dir, encoding: "utf-8", input: JSON.stringify({ cwd: dir, ...ev }), env: { ...process.env, AGENT_FLOW_ROLE: "", AGENT_FLOW_HOME: join(dir, "home") } });
    assert.equal(hook({ hook_event_name: "PreToolUse", permission_mode: "default", session_id: "S1", tool_name: "Bash", tool_input: { command: "git push origin main" } }).status, 2);
    assert.equal(hook({ tool_name: "Bash", tool_input: { command: "git push origin main" } }, "--harness", "copilot").status, 2);
    const lines = readFileSync(join(dir, ".agent-flow", "audit.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.harness), ["claude", "copilot"]);
    assert.equal(lines[0].session, "S1");
    assert.equal(lines[0].source, "test", "a run under node --test tags itself as a test");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
