// agent-flow mcp: a read-only MCP server with no dependencies. The protocol subset it speaks, the guarantee that no tool
// can change anything, argument validation, and a real exchange over stdio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { MCP_VERSIONS, handleMessage, serve } from "../extensions/lib/mcp.js";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));

function repo(manifest = { protected_paths: ["secret/**"] }) {
  const dir = mkdtempSync(join(tmpdir(), "af-mcp-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "AGENTS.md"), "# rules\n");
  if (manifest) writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ version: "2", default_branch: "main", context_files: [{ path: "AGENTS.md", references: [] }], ...manifest }));
  return dir;
}

const calls = [];
const opts = (root, run) => ({ root, version: "9.9.9", run: run ?? ((argv) => (calls.push(argv), { status: 0, stdout: '{"ok":true}', stderr: "" })) });
const rpc = (method, params, id = 1) => ({ jsonrpc: "2.0", id, method, params });
const call = (name, args, o) => handleMessage(rpc("tools/call", { name, arguments: args }), o);
const text = (r) => r.result.content[0].text;

test("initialize: negotiates the protocol version, advertises tools and prompts only, names itself", () => {
  const o = opts("/r");
  for (const v of MCP_VERSIONS) assert.equal(handleMessage(rpc("initialize", { protocolVersion: v }), o).result.protocolVersion, v);
  const unknown = handleMessage(rpc("initialize", { protocolVersion: "1999-01-01" }), o).result;
  assert.equal(unknown.protocolVersion, MCP_VERSIONS[0], "an unknown version gets the newest we speak");
  assert.deepEqual(Object.keys(unknown.capabilities).sort(), ["prompts", "tools"], "no resources, no sampling: nothing it doesn't do");
  assert.equal(unknown.serverInfo.name, "agent-flow");
  assert.equal(unknown.serverInfo.version, "9.9.9");
  assert.match(unknown.instructions, /read-only/i);
  assert.equal(handleMessage(rpc("initialize", {}), o).result.protocolVersion, MCP_VERSIONS[0], "missing params are tolerated");
});

test("ping, notifications, unknown methods and malformed requests", () => {
  const o = opts("/r");
  assert.deepEqual(handleMessage(rpc("ping"), o), { jsonrpc: "2.0", id: 1, result: {} });
  assert.equal(handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, o), null, "a notification gets no answer");
  assert.equal(handleMessage({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 3 } }, o), null);
  assert.equal(handleMessage(rpc("resources/list"), o).error.code, -32601, "resources aren't offered");
  assert.equal(handleMessage(rpc("sampling/createMessage"), o).error.code, -32601);
  assert.equal(handleMessage(rpc("tools/call", { name: "nope" }, 7), o).error.code, -32602);
  assert.equal(handleMessage(rpc("prompts/get", { name: "nope" }, 8), o).error.code, -32602);
  for (const bad of [null, 5, "x", [], { jsonrpc: "2.0", id: 1 }]) assert.equal(handleMessage(bad, o)?.error?.code ?? null, bad && typeof bad === "object" && !Array.isArray(bad) && "id" in bad ? -32600 : -32600, JSON.stringify(bad));
  assert.equal(handleMessage({ jsonrpc: "2.0", id: 4, method: 42 }, o).error.code, -32600);
});

test("tools/list: eight tools, every one declared read-only with a closed input schema", () => {
  const tools = handleMessage(rpc("tools/list"), opts("/r")).result.tools;
  assert.deepEqual(tools.map((t) => t.name).sort(), ["agent_flow_audit_summary", "agent_flow_brief", "agent_flow_classify", "agent_flow_debt", "agent_flow_doctor", "agent_flow_gates", "agent_flow_state", "agent_flow_status"]);
  for (const t of tools) {
    assert.equal(t.annotations.readOnlyHint, true, t.name);
    assert.equal(t.annotations.destructiveHint, false, t.name);
    assert.equal(t.inputSchema.type, "object");
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name}: unknown arguments are refused`);
    assert.ok(t.description.length > 30 && t.title, t.name);
  }
});

test("no tool can run anything that changes state: every call is one of a short list of read-only CLI commands", () => {
  calls.length = 0;
  const o = opts("/r");
  for (const [name, args] of [["agent_flow_status", {}], ["agent_flow_state", {}], ["agent_flow_state", { issue: 7 }], ["agent_flow_classify", {}], ["agent_flow_classify", { issue: 3, base: "main", head: "feature/x" }], ["agent_flow_debt", {}], ["agent_flow_doctor", {}], ["agent_flow_audit_summary", {}], ["agent_flow_gates", {}]]) {
    const r = call(name, args, o);
    assert.equal(r.result.isError, undefined, `${name}: ${JSON.stringify(r)}`);
  }
  const READ_ONLY = new Set(["status", "state show", "classify", "debt", "doctor", "audit summary", "gates list"]);
  for (const argv of calls) {
    const verb = ["state", "audit", "gates"].includes(argv[0]) ? `${argv[0]} ${argv[1]}` : argv[0];
    assert.ok(READ_ONLY.has(verb), `unexpected CLI call: ${argv.join(" ")}`);
    assert.ok(argv.includes("--json"));
    assert.ok(!argv.some((a) => /^--(yes|force|reopen|delete-branch|pr|auto-merge)$/.test(a)), `a mutating flag in ${argv.join(" ")}`);
  }
  assert.deepEqual(calls.find((a) => a[0] === "classify" && a.includes("--issue")), ["classify", "--json", "--issue", "3", "--base", "main", "--head", "feature/x"]);
  assert.deepEqual(calls.find((a) => a[0] === "state" && a.includes("--issue")), ["state", "show", "--issue", "7", "--json"]);
});

test("arguments are validated before anything runs: a bad one is a tool error, never an option for the CLI", () => {
  calls.length = 0;
  const o = opts("/r");
  for (const [name, args, why] of [
    ["agent_flow_state", { issue: 0 }, /issue must be a positive integer/],
    ["agent_flow_state", { issue: "7" }, /issue must be a positive integer/],
    ["agent_flow_state", { issue: 1.5 }, /issue must be a positive integer/],
    ["agent_flow_state", { issue: 7, extra: 1 }, /takes no argument "extra"/],
    ["agent_flow_status", { anything: true }, /takes no argument "anything"/],
    ["agent_flow_classify", { base: "--output=/tmp/x" }, /base must be a branch, tag or commit name/],
    ["agent_flow_classify", { head: "main; rm -rf /" }, /head must be a branch/],
    ["agent_flow_classify", { base: "a..b" }, /base must be a branch/],
    ["agent_flow_classify", { base: 5 }, /base must be a branch/],
  ]) {
    const r = call(name, args, o);
    assert.equal(r.result.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(text(r), why);
  }
  assert.equal(calls.length, 0, "the CLI was never started for a bad argument");
  assert.equal(call("agent_flow_status", undefined, o).result.isError, undefined, "no arguments at all is fine");
  assert.equal(call("agent_flow_status", [], o).result.isError, undefined, "an array is not an arguments object: treated as none");
});

test("tool results: exit 0 and 1 are answers (a finding is not a failure), anything else is an error, and a throw never escapes", () => {
  const mk = (status, stdout, stderr = "") => opts("/r", () => ({ status, stdout, stderr }));
  assert.equal(text(call("agent_flow_doctor", {}, mk(0, '{"healthy":true}'))), '{"healthy":true}');
  const unhealthy = call("agent_flow_doctor", {}, mk(1, '{"healthy":false}'));
  assert.equal(unhealthy.result.isError, undefined);
  assert.equal(text(unhealthy), '{"healthy":false}');
  const failed = call("agent_flow_doctor", {}, mk(2, "", "manifest not found"));
  assert.equal(failed.result.isError, true);
  assert.match(text(failed), /agent-flow doctor failed \(exit 2\): manifest not found/);
  assert.match(text(call("agent_flow_doctor", {}, mk(null, "", "timed out"))), /exit none/);
  assert.equal(text(call("agent_flow_debt", {}, mk(0, ""))), "(no output)");
  const thrown = call("agent_flow_debt", {}, opts("/r", () => { throw new Error("boom"); }));
  assert.equal(thrown.result.isError, true);
  assert.match(text(thrown), /could not answer: boom/);
  const huge = text(call("agent_flow_debt", {}, mk(0, "x".repeat(500_000))));
  assert.ok(huge.length < 21_000 && /output cut at 20000/.test(huge), "an enormous answer is cut, not streamed whole");
});

test("brief tool and prompt answer in-process from the repo, and say so when there are no rules", () => {
  const dir = repo();
  const none = repo(null);
  try {
    const o = opts(dir);
    assert.match(text(call("agent_flow_brief", {}, o)), /^AGENT-FLOW ACTIVE\./);
    const prompt = handleMessage(rpc("prompts/get", { name: "agent-flow-brief" }), o).result;
    assert.equal(prompt.messages[0].role, "user");
    assert.match(prompt.messages[0].content.text, /Protected, never edit/);
    assert.deepEqual(handleMessage(rpc("prompts/list"), o).result.prompts.map((p) => p.name), ["agent-flow-brief"]);
    assert.match(text(call("agent_flow_brief", {}, opts(none))), /No CONTEXT_MANIFEST\.json here/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(none, { recursive: true, force: true });
  }
});

// ---- framing ----------------------------------------------------------------------------------------------------

function session(lines) {
  const input = new PassThrough();
  const written = [];
  const done = serve(input, { write: (s) => written.push(s) }, opts("/r"));
  for (const l of lines) input.write(`${l}\n`);
  input.end();
  return done.then(() => written);
}

test("serve: one JSON message per line each way; bad JSON gets a parse error, blank lines are skipped, a batch is answered as a batch", async () => {
  const out = await session([
    JSON.stringify(rpc("initialize", { protocolVersion: "2025-06-18" }, 1)),
    "",
    "   ",
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    "{ not json",
    JSON.stringify(rpc("ping", {}, 2)),
    JSON.stringify([rpc("ping", {}, 3), { jsonrpc: "2.0", method: "notifications/initialized" }, rpc("nope", {}, 4)]),
  ]);
  assert.ok(out.every((l) => l.endsWith("\n") && !l.slice(0, -1).includes("\n")), "each message is exactly one line");
  const msgs = out.map((l) => JSON.parse(l));
  assert.equal(msgs.length, 4, "the notification and the blank lines produced nothing");
  assert.equal(msgs[0].id, 1);
  assert.deepEqual(msgs[1], { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  assert.equal(msgs[2].id, 2);
  assert.ok(Array.isArray(msgs[3]) && msgs[3].length === 2, "the batch's answers come back together, without one for the notification");
  assert.equal(msgs[3][1].error.code, -32601);
});

test("serve resolves when the client closes stdin, and a CRLF-framed client works too", async () => {
  const input = new PassThrough();
  const written = [];
  const done = serve(input, { write: (s) => written.push(s) }, opts("/r"));
  input.write(`${JSON.stringify(rpc("ping", {}, 1))}\r\n`);
  input.end();
  await done;
  assert.deepEqual(JSON.parse(written[0]), { jsonrpc: "2.0", id: 1, result: {} });
});

// ---- the real thing over stdio ---------------------------------------------------------------------------------

test("agent-flow mcp (CLI): a real session over stdio, stdout carries only protocol lines, and it exits when the client does", async () => {
  const dir = repo();
  try {
    assert.equal(spawnSync(process.execPath, [BIN, "state", "update", "--issue", "7", "--state", "Needs Me", "--reason", "SPEC_ERROR: unclear"], { cwd: dir, encoding: "utf-8" }).status, 0);
    const lines = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BIN, "mcp"], { cwd: dir, env: { ...process.env, NO_COLOR: "1", AGENT_FLOW_ROLE: "" }, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      const timer = setTimeout(() => {
        child.kill();
        clearInterval(wait);
        reject(new Error(`mcp did not exit: ${out} ${err}`));
      }, 60_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        clearInterval(wait);
        resolve({ code, out, err });
      });
      for (const m of [
        rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } }, 1),
        { jsonrpc: "2.0", method: "notifications/initialized" },
        rpc("tools/list", {}, 2),
        rpc("tools/call", { name: "agent_flow_state", arguments: { issue: 7 } }, 3),
        rpc("tools/call", { name: "agent_flow_status", arguments: {} }, 4),
        rpc("tools/call", { name: "agent_flow_classify", arguments: { base: "--evil" } }, 5),
        rpc("tools/call", { name: "agent_flow_debt", arguments: {} }, 6),
      ]) child.stdin.write(`${JSON.stringify(m)}\n`);
      // Close once the last answer is out, as a client does when it is done.
      const wait = setInterval(() => {
        if (out.split("\n").filter(Boolean).length >= 6) {
          clearInterval(wait);
          child.stdin.end();
        }
      }, 50);
    });
    assert.equal(lines.code, 0, lines.err);
    assert.equal(lines.err, "", "nothing on stderr");
    const msgs = lines.out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(msgs.length, 6, "six requests, one answer each, none for the notification");
    const byId = Object.fromEntries(msgs.map((m) => [m.id, m]));
    assert.equal(byId[1].result.serverInfo.name, "agent-flow");
    assert.equal(byId[2].result.tools.length, 8);
    assert.deepEqual(JSON.parse(byId[3].result.content[0].text), { issue: 7, state: "Needs Me", phase: "unknown", round: 0, max_review_rounds: 2, reason: "SPEC_ERROR: unclear" });
    const status = JSON.parse(byId[4].result.content[0].text);
    assert.ok(Array.isArray(status.rows) && status.rows.some((r) => /needs you/.test(r.text)), "status sees the issue waiting on a person");
    assert.equal(byId[5].result.isError, true, "an option-looking revision never reaches the CLI");
    assert.equal(JSON.parse(byId[6].result.content[0].text).markers, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve: a line that never ends is refused and dropped, a huge batch is refused, and the next request still works", async () => {
  const input = new PassThrough();
  const written = [];
  const done = serve(input, { write: (s) => written.push(s) }, opts("/r"));
  // 3 MB with no newline, in chunks, then its end, then a normal ping.
  for (let i = 0; i < 3; i++) input.write("x".repeat(1_000_000));
  input.write("\n");
  input.write(`${JSON.stringify(Array.from({ length: 51 }, (_, i) => rpc("ping", {}, i + 1)))}\n`);
  input.write(`${JSON.stringify(rpc("ping", {}, 99))}\n`);
  input.end();
  await done;
  const replies = written.map((w) => JSON.parse(w));
  assert.equal(replies.filter((r) => r.error?.message.startsWith("request too large")).length, 1, "one refusal for the whole oversized line");
  assert.ok(replies.some((r) => r.error?.message.startsWith("batch too large")));
  assert.deepEqual(replies.at(-1), { jsonrpc: "2.0", id: 99, result: {} });
});
