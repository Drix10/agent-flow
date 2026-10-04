/**
 * The session brief: what a coding agent should know about this repo's guard before it hits it.
 *
 * Without it the rules are learned by running into them: a blocked write, a refused push. A short brief at session
 * start (and in each subagent, which never sees the parent's context) says what is protected, what is review-only,
 * what is always blocked and what to do instead. It is facts from the manifest and the pipeline state, never free text
 * from an issue or a reason (that text is untrusted, and a brief is read as instructions). Offline, read-only, fast,
 * and it never throws: a hook that fails must not stop a session from starting.
 *
 * Each host wants its own output shape for "add this to the model's context"; `hostOf` and `formatForHost` hold them.
 */

import { readState } from "./state.js";
import { gatesOf } from "./gates.js";
import { ContextManifest, denyReadPathsOf, leanLevel, protectedPathsOf, reviewPathsOf, trustedManifest } from "./manifest.js";

const MAX_LISTED = 8;
const MAX_ITEM = 80;

/** One path pattern, safe to put in a sentence: a single line, bounded, no backticks. */
const item = (s: string) => s.replace(/[\r\n\t`]+/g, " ").trim().slice(0, MAX_ITEM);

function list(values: string[]): string {
  const shown = values.slice(0, MAX_LISTED).map((v) => `\`${item(v)}\``);
  return shown.join(", ") + (values.length > MAX_LISTED ? `, and ${values.length - MAX_LISTED} more` : "");
}

/** The category an escalation reason starts with (`review_required`, `SPEC_ERROR`), never the rest of it. */
function categoryOf(reason: unknown): string {
  const m = /^([A-Za-z_]{2,40}):/.exec(String(reason ?? ""));
  return m ? m[1] : "needs_me";
}

export interface BriefOptions {
  /** The pipeline role this session runs as (AGENT_FLOW_ROLE), if any. */
  role?: string | null;
}

/** The brief for the repo at `root`, or "" when there is nothing to say (no manifest, so no rules to brief). */
export function buildBrief(root: string, opts: BriefOptions = {}): string {
  // One load: the trusted copy already carries the floors (protected, deny-read, review, gates, pipeline) the guard enforces.
  const trusted: ContextManifest | null = trustedManifest(root).manifest;
  if (!trusted) return "";
  const guarded = trusted;
  const protectedPaths = protectedPathsOf(guarded);
  const reviewPaths = reviewPathsOf(guarded);
  const deny = denyReadPathsOf(guarded);
  const branch = typeof guarded.default_branch === "string" && guarded.default_branch.trim() ? item(guarded.default_branch) : "the default branch";
  const lines: string[] = [
    `AGENT-FLOW ACTIVE${opts.role ? ` (you are the ${item(opts.role)})` : ""}. A guard checks every tool call in this repo. If it blocks something, stop and escalate instead of looking for a way around it; the reason it prints says what to do.`,
  ];
  if (protectedPaths.length) lines.push(`Protected, never edit, delete or move (a person changes these): ${list(protectedPaths)}.`);
  if (reviewPaths.length) lines.push(`Review-only, add lines but never edit or delete one (a person reviews the pull request): ${list(reviewPaths)}.`);
  lines.push(`Never read .env files${deny.length ? ` or ${list(deny)}` : ""}. Always blocked: --no-verify, force-pushes, pushing to ${branch} (push agent/issue-N and open a PR), editing hooks, harness settings or CI configuration${reviewPaths.length ? " other than the review-only paths" : ""}.`);
  if (opts.role) lines.push("Report back to the orchestrator instead of starting another agent or changing pipeline state yourself.");
  const lean = leanLevel(trusted);
  if (lean !== "off") lines.push("When a simplification cuts a real corner, mark it in the code with a comment `lean: <ceiling>; <when to upgrade>`; `agent-flow debt` lists them.");
  const gates = gatesOf(trusted).filter((g) => g.required !== false);
  if (gates.length) lines.push(`Before you finish, the repo's checks must pass (\`agent-flow gates run\`): ${gates.slice(0, 6).map((g) => item(g.name)).join(", ")}.`);
  try {
    const sessions = readState(root).sessions ?? [];
    const waiting = sessions.filter((s) => s.state === "Needs Me");
    const working = sessions.filter((s) => s.state === "Working");
    if (waiting.length || working.length) {
      const parts: string[] = [];
      if (waiting.length) parts.push(`${waiting.length} waiting on a person (${waiting.slice(0, 5).map((s) => `#${s.issue} ${categoryOf(s.reason)}`).join(", ")})`);
      if (working.length) parts.push(`${working.length} in progress`);
      lines.push(`Pipeline: ${parts.join("; ")}. \`agent-flow status\` has the detail.`);
    }
  } catch {
    /* a state file that can't be read is not worth failing a session start over */
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

export type Host = "claude" | "codex" | "copilot" | "qoder" | "cursor" | "zcode";
export type BriefEvent = "SessionStart" | "SubagentStart";

/**
 * Which harness is running this hook, from the environment each one builds for its hooks. Checked in this order because
 * some harnesses also set another's variables (Cursor runs Claude-format plugin hooks with CLAUDE_PLUGIN_ROOT set).
 */
export function hostOf(env: NodeJS.ProcessEnv = process.env): Host {
  const root = (env.CLAUDE_PLUGIN_ROOT ?? "").split(/[\\/]+/);
  // VS Code's Copilot never sets COPILOT_PLUGIN_DATA; it hands over a plugin root under .vscode/agent-plugins.
  const vscodeCopilot = root.includes("agent-plugins") && (env.CLAUDE_PLUGIN_ROOT ?? "").toLowerCase().includes(".vscode");
  if (env.COPILOT_PLUGIN_DATA || vscodeCopilot) return "copilot";
  if (env.PLUGIN_DATA) return "codex";
  if (env.QODER_SESSION_ID) return "qoder";
  if (env.CURSOR_VERSION) return "cursor";
  if (env.ZCODE_APP_VERSION) return "zcode";
  return "claude";
}

/** What a hook prints so `context` reaches the model on `host` at `event`; "" prints nothing at all. */
export function formatForHost(host: Host, event: BriefEvent, context: string): string {
  if (!context) return host === "copilot" ? "{}" : "";
  switch (host) {
    case "copilot":
      // Copilot reads additionalContext on SessionStart and ignores output elsewhere.
      return JSON.stringify(event === "SessionStart" ? { additionalContext: context } : {});
    case "codex":
    case "qoder":
    case "zcode":
      return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } });
    case "cursor":
      return JSON.stringify({ additional_context: context });
    default:
      // Claude Code takes raw text at SessionStart, but SubagentStart only reads the JSON form.
      return event === "SubagentStart" ? JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }) : context;
  }
}
