/**
 * `agent-flow mcp`: a read-only Model Context Protocol server over stdio, so any MCP client (Claude Desktop, Cursor,
 * Windsurf, Zed, …) can ask what agent-flow knows about a repo: status, pipeline state, the risk of a diff, the debt
 * ledger, doctor, the audit summary, the gates, the brief. It changes nothing, and it is not where the guard lives: the
 * guard is the harness's own hooks. This is for hosts that have no hook of ours but can call a tool.
 *
 * Zero dependencies, like the rest: the subset of JSON-RPC 2.0 and MCP this needs (initialize, ping, tools, prompts) is
 * small. Every tool shells out to the CLI's own `--json` output through an argv array (never a shell string), so there
 * is one implementation of each answer, and arguments are validated here as well as by the CLI.
 *
 * Framing: one JSON message per line on stdin, one per line on stdout. Nothing else is ever written to stdout.
 */

import { buildBrief } from "./brief.js";

export const MCP_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
// A tool answer is read by a model: past this it is spend, not information (the CLI's own --json has the whole of it).
const MAX_OUTPUT = 20_000;
/** One request is small; a line past this is garbage, and buffering it unbounded would be a leak. */
const MAX_LINE = 1_000_000;
const MAX_BATCH = 50;
const REV = /^[A-Za-z0-9_][\w./@^~{}-]*$/;

export type RunCli = (args: string[]) => { status: number | null; stdout: string; stderr: string };

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The CLI arguments for `args`, or an error string. */
  argv?: (args: Record<string, unknown>) => string[] | string;
  /** Answer in-process instead (no CLI). */
  local?: (root: string) => string;
}

const none = { type: "object", properties: {}, additionalProperties: false };
const issue = { type: "integer", minimum: 1, description: "Issue number" };

const TOOLS: Tool[] = [
  { name: "agent_flow_status", title: "agent-flow status", description: "One screen: is the guard wired, what is protected, what are the checks, what is waiting on a person, is agent-flow current.", inputSchema: none, argv: () => ["status", "--json", "--offline"] },
  { name: "agent_flow_brief", title: "agent-flow brief", description: "What an agent should know about this repo's guard: protected and review-only paths, what is always blocked, the checks that must pass, what waits on a person.", inputSchema: none, local: (root) => buildBrief(root) || "No CONTEXT_MANIFEST.json here, so there are no agent-flow rules to brief." },
  {
    name: "agent_flow_state",
    title: "pipeline state",
    description: "The Implement → Review → QA pipeline's state: every issue, or one, with its phase, round and escalation reason.",
    inputSchema: { type: "object", properties: { issue }, additionalProperties: false },
    argv: (a) => (a.issue === undefined ? ["state", "show", "--json"] : ["state", "show", "--issue", String(a.issue), "--json"]),
  },
  {
    name: "agent_flow_classify",
    title: "risk classification",
    description: "The mechanical risk level of a change: protected paths touched, review-only paths, risk boundaries, dependency changes, policy violations. With an issue, classifies that issue's worktree; with base and head, a revision range.",
    inputSchema: { type: "object", properties: { issue, base: { type: "string", description: "Base revision" }, head: { type: "string", description: "Head revision" } }, additionalProperties: false },
    argv: (a) => {
      const out = ["classify", "--json"];
      if (a.issue !== undefined) out.push("--issue", String(a.issue));
      for (const k of ["base", "head"] as const) if (a[k] !== undefined) out.push(`--${k}`, String(a[k]));
      return out;
    },
  },
  { name: "agent_flow_debt", title: "deferred shortcuts", description: "Every `lean:` shortcut comment in the code with its ceiling and the condition for revisiting it; the ones with none are flagged.", inputSchema: none, argv: () => ["debt", "--json"] },
  { name: "agent_flow_doctor", title: "context drift", description: "Check the context files against the codebase: missing paths, dead commands, broken links, stale timestamps, schema problems.", inputSchema: none, argv: () => ["doctor", "--json", "--offline"] },
  { name: "agent_flow_audit_summary", title: "audit summary", description: "From the hash-chained audit log: guard blocks per role and rule, escalations, rounds per issue, role runs and cost.", inputSchema: none, argv: () => ["audit", "summary", "--json"] },
  { name: "agent_flow_gates", title: "gates", description: "The checks the pipeline runs itself (tests, lint, build) and where each can run. Lists them; running them is `agent-flow gates run`.", inputSchema: none, argv: () => ["gates", "list", "--json"] },
];

export interface McpOptions {
  root: string;
  version: string;
  run: RunCli;
}

type Json = Record<string, any>;
const result = (id: unknown, value: unknown) => ({ jsonrpc: "2.0", id, result: value });
const error = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

function textResult(text: string, isError = false) {
  const cut = text.length > MAX_OUTPUT;
  return { content: [{ type: "text", text: cut ? `${text.slice(0, MAX_OUTPUT)}\n[… output cut at ${MAX_OUTPUT} characters]` : text }], ...(isError ? { isError: true } : {}) };
}

/** An argument problem, as the message a tool result carries (a bad argument is the caller's to fix, not a protocol error). */
function checkArgs(tool: Tool, args: Record<string, unknown>): string | null {
  const allowed = Object.keys((tool.inputSchema.properties as Json) ?? {});
  for (const k of Object.keys(args)) if (!allowed.includes(k)) return `${tool.name} takes no argument "${k}"${allowed.length ? ` (it takes: ${allowed.join(", ")})` : ""}`;
  if (args.issue !== undefined && (!Number.isInteger(args.issue) || (args.issue as number) < 1)) return "issue must be a positive integer";
  for (const k of ["base", "head"]) {
    if (args[k] !== undefined && (typeof args[k] !== "string" || !REV.test(args[k] as string) || (args[k] as string).includes(".."))) return `${k} must be a branch, tag or commit name`;
  }
  return null;
}

/** Handle one JSON-RPC message; the response, or null for a notification (which gets none). */
export function handleMessage(msg: unknown, o: McpOptions): Json | null {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return error(null, -32600, "invalid request");
  const m = msg as Json;
  const isRequest = m.id !== undefined && m.id !== null;
  if (typeof m.method !== "string") return isRequest ? error(m.id, -32600, "invalid request: no method") : null;
  const params = (m.params && typeof m.params === "object" ? m.params : {}) as Json;
  if (!isRequest) return null; // notifications/initialized, notifications/cancelled, …: nothing to answer

  switch (m.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = (MCP_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_VERSIONS[0];
      return result(m.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: { name: "agent-flow", title: "agent-flow", version: o.version },
        instructions: "A read-only view of this repository's agent-flow setup: status, pipeline state, the risk of a diff, deferred shortcuts, context drift, the audit summary, the gates and the brief. It changes nothing. The guard that blocks tool calls is the harness's own hook, not this server.",
      });
    }
    case "ping":
      return result(m.id, {});
    case "tools/list":
      return result(m.id, { tools: TOOLS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return error(m.id, -32602, `unknown tool: ${String(params.name)}`);
      const args = (params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<string, unknown>;
      const bad = checkArgs(tool, args);
      if (bad) return result(m.id, textResult(bad, true));
      try {
        if (tool.local) return result(m.id, textResult(tool.local(o.root)));
        const argv = tool.argv!(args);
        if (typeof argv === "string") return result(m.id, textResult(argv, true));
        const r = o.run(argv);
        // Exit 1 is a finding (unhealthy, protected path touched), not a failure of the tool.
        if (r.status === 0 || r.status === 1) return result(m.id, textResult(r.stdout.trim() || r.stderr.trim() || "(no output)"));
        return result(m.id, textResult(`agent-flow ${argv[0]} failed (exit ${r.status ?? "none"}): ${(r.stderr || r.stdout).trim().slice(0, 2000)}`, true));
      } catch (e) {
        return result(m.id, textResult(`agent-flow could not answer: ${e instanceof Error ? e.message : String(e)}`, true));
      }
    }
    case "prompts/list":
      return result(m.id, { prompts: [{ name: "agent-flow-brief", title: "agent-flow brief", description: "The rules this repo's guard enforces and what to do when it blocks something.", arguments: [] }] });
    case "prompts/get": {
      if (params.name !== "agent-flow-brief") return error(m.id, -32602, `unknown prompt: ${String(params.name)}`);
      const text = buildBrief(o.root) || "No CONTEXT_MANIFEST.json here, so there are no agent-flow rules to brief.";
      return result(m.id, { description: "agent-flow brief", messages: [{ role: "user", content: { type: "text", text } }] });
    }
    default:
      return error(m.id, -32601, `method not found: ${m.method}`);
  }
}

/** Read newline-delimited JSON-RPC from `input`, answer on `output`; resolves when `input` closes. */
export function serve(input: NodeJS.ReadableStream, output: { write(s: string): unknown }, o: McpOptions): Promise<void> {
  return new Promise((resolve) => {
    const send = (r: Json | null) => r && output.write(`${JSON.stringify(r)}\n`);
    const onLine = (line: string) => {
      const text = line.trim();
      if (!text) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return void send(error(null, -32700, "parse error"));
      }
      try {
        // A batch is answered as a batch of the responses that exist.
        if (Array.isArray(parsed)) {
          if (parsed.length > MAX_BATCH) return void send(error(null, -32600, `batch too large (at most ${MAX_BATCH})`));
          const out = parsed.map((m) => handleMessage(m, o)).filter((r): r is Json => r !== null);
          if (out.length) output.write(`${JSON.stringify(out)}\n`);
        } else send(handleMessage(parsed, o));
      } catch (e) {
        send(error((parsed as Json)?.id, -32603, `internal error: ${e instanceof Error ? e.message : String(e)}`));
      }
    };
    // Lines are split here, not by readline, so one with no end can't grow the buffer without limit.
    let buf = "";
    let skipping = false;
    input.setEncoding?.("utf8");
    input.on("data", (chunk: string | Buffer) => {
      buf += chunk.toString();
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (skipping) skipping = false; // the tail of an oversized line
        else onLine(line);
      }
      if (buf.length > MAX_LINE) {
        if (!skipping) send(error(null, -32600, `request too large (over ${MAX_LINE} bytes)`));
        skipping = true;
        buf = "";
      }
    });
    input.on("end", () => {
      if (buf.trim() && !skipping) onLine(buf);
      resolve();
    });
    input.on("error", () => resolve());
  });
}
