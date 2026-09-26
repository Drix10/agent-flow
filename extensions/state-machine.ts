/**
 * State Machine Extension
 *
 * Manages the Needs Me / Working / Completed state machine.
 *
 * SECURITY: This extension writes only to AGENT_STATE.md and
 * .agent-state.json. It never modifies source code or context files.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

type SessionState = "Needs Me" | "Working" | "Completed";

interface Session {
  issue: number;
  state: SessionState;
  phase: string;
  round: number;
  startedAt: string;
  worktree: string;
  reason?: string;
}

interface StateFile {
  sessions: Session[];
  lastUpdated: string;
}

const STATE_FILE = ".agent-state.json";
const STATE_MD = "AGENT_STATE.md";

export default function (pi: ExtensionAPI) {
  async function readState(): Promise<StateFile> {
    if (!existsSync(STATE_FILE)) {
      return { sessions: [], lastUpdated: new Date().toISOString() };
    }
    const content = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(content);
  }

  async function writeState(state: StateFile): Promise<void> {
    state.lastUpdated = new Date().toISOString();
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
    await writeMarkdown(state);
  }

  async function writeMarkdown(state: StateFile): Promise<void> {
    const needsMe = state.sessions.filter((s) => s.state === "Needs Me");
    const working = state.sessions.filter((s) => s.state === "Working");
    const completed = state.sessions.filter((s) => s.state === "Completed");

    const md = `# Agent State

> Last updated: ${state.lastUpdated}

## 🔴 Needs Me (${needsMe.length})

${needsMe.map((s) => `- **Issue #${s.issue}** — ${s.reason || "action required"}`).join("\n") || "_None_"}

## 🔵 Working (${working.length})

${working.map((s) => `- **Issue #${s.issue}** — ${s.phase} (round ${s.round})`).join("\n") || "_None_"}

## 🟢 Completed (${completed.length})

${completed.map((s) => `- **Issue #${s.issue}** — done`).join("\n") || "_None_"}
`;

    await writeFile(STATE_MD, md, "utf-8");
  }

  pi.registerTool({
    name: "state_update",
    description: "Update the session state for an issue. Transitions between Needs Me, Working, and Completed.",
    parameters: {
      type: "object",
      properties: {
        issue: { type: "number" },
        state: { type: "string", enum: ["Needs Me", "Working", "Completed"] },
        phase: { type: "string" },
        round: { type: "number" },
        reason: { type: "string" },
      },
      required: ["issue", "state"],
    },
    handler: async (params: { issue: number; state: SessionState; phase?: string; round?: number; reason?: string }) => {
      const state = await readState();
      const existing = state.sessions.find((s) => s.issue === params.issue);

      if (existing) {
        existing.state = params.state;
        existing.phase = params.phase || existing.phase;
        existing.round = params.round ?? existing.round;
        existing.reason = params.reason;
      } else {
        state.sessions.push({
          issue: params.issue,
          state: params.state,
          phase: params.phase || "unknown",
          round: params.round || 0,
          startedAt: new Date().toISOString(),
          worktree: `.worktrees/issue-${params.issue}`,
          reason: params.reason,
        });
      }

      await writeState(state);
      return { updated: params.issue, state: params.state };
    },
  });

  pi.registerTool({
    name: "state_read",
    description: "Read the current session state.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      return await readState();
    },
  });
}
