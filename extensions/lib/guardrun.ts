/**
 * What a guard run records, shared by every adapter (`agent-flow guard` for the hook harnesses, the Pi extension): which harness and
 * session the call came from, who ran it, and what was blocked, with credentials taken out of anything free-form.
 */

import { relative } from "node:path";
import { toPosix } from "./fsutil.js";
import { auditTarget, redactText, type GuardDecision } from "./guard.js";

/** Which harness sent a hook event, from what the event itself carries. Unknown stays "unknown": a wrong label would mislead more than none. */
export function harnessOf(ev: Record<string, unknown>, flag?: unknown): string {
  if (typeof flag === "string" && /^[a-z][a-z0-9-]{0,30}$/.test(flag)) return flag;
  if (typeof ev.harness === "string" && /^[a-z][a-z0-9-]{0,30}$/.test(ev.harness)) return ev.harness;
  if (typeof ev.cursor_version === "string" || typeof ev.conversation_id === "string") return "cursor";
  if (ev.hook_event_name === "BeforeTool" || ev.tool_name === "run_shell_command") return "gemini";
  if (typeof ev.turn_id === "string") return "codex";
  if (ev.hook_event_name === "PreToolUse" && ("permission_mode" in ev || "transcript_path" in ev)) return "claude";
  return "unknown";
}

const str = (v: unknown, max = 120) => (typeof v === "string" && v ? v.slice(0, max) : undefined);

/** The audit line for a blocked call. Nothing in it is a command the agent wrote except `target`, which is redacted and capped. */
export function blockEntry(o: {
  harness: string;
  ev: Record<string, unknown>;
  role: string | null;
  decision: GuardDecision;
  root: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Record<string, unknown> {
  const { ev, decision } = o;
  const env = o.env ?? process.env;
  const override = [env.AGENT_FLOW_ALLOW_PROTECTED === "1" && "allow_protected", env.AGENT_FLOW_ALLOW_SECRET_READ === "1" && "allow_secret_read"].filter(Boolean);
  const cwd = o.cwd ? toPosix(relative(o.root, o.cwd)) : "";
  return {
    event: "guard_block",
    harness: o.harness,
    ...(str(ev.session_id) ?? str(ev.conversation_id) ? { session: str(ev.session_id) ?? str(ev.conversation_id) } : {}),
    ...(str(ev.agent_type) ? { agent: str(ev.agent_type) } : {}),
    ...(str(ev.model) ? { model: str(ev.model) } : {}),
    role: o.role,
    tool: ev.tool_name,
    target: auditTarget(ev.tool_input),
    rule: decision.rule,
    reason: redactText(decision.reason, 400),
    source: env.AGENT_FLOW_AUDIT_SOURCE || (env.NODE_TEST_CONTEXT ? "test" : "live"),
    ...(cwd && !cwd.startsWith("..") ? { cwd } : {}),
    ...(override.length ? { override } : {}),
  };
}
