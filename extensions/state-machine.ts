/**
 * State Machine Extension — Needs Me / Working / Completed.
 *
 * Writes only .agent-state.json, AGENT_STATE.md and .agent-flow/audit.jsonl at
 * the MAIN repo root. Transitions and the review-round cap are validated here,
 * not trusted to the orchestrator prompt.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { maxReviewRounds, trustedManifest } from "./lib/manifest.js";
import { readState, updateState } from "./lib/state.js";
import { repoRoot, text } from "./result.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "state_update",
    label: "State update",
    description:
      "Record a pipeline transition for an issue. Legal: (new)→Working|Needs Me; Working→Working|Needs Me|Completed; " +
      "Needs Me→Working|Completed; Completed is terminal (reopen: true is a human decision). `round` is the review round " +
      "(monotonic). Reporting a round above the limit (default 2, manifest pipeline.max_review_rounds) auto-escalates to Needs Me. " +
      "Needs Me requires a reason.",
    parameters: Type.Object({
      issue: Type.Integer({ minimum: 1 }),
      state: Type.Union([Type.Literal("Needs Me"), Type.Literal("Working"), Type.Literal("Completed")]),
      phase: Type.Optional(Type.String({ maxLength: 80, description: "e.g. implement, review, qa, pr, fix" })),
      round: Type.Optional(Type.Integer({ minimum: 0 })),
      reason: Type.Optional(Type.String({ maxLength: 2000 })),
      reopen: Type.Optional(Type.Boolean()),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const root = repoRoot(ctx);
      const limit = maxReviewRounds(trustedManifest(root).manifest);
      return text(updateState(root, params, limit));
    },
  });

  pi.registerTool({
    name: "state_read",
    label: "State read",
    description: "Read the current pipeline state for all issues (call before deciding what to do next).",
    parameters: Type.Object({ issue: Type.Optional(Type.Integer({ minimum: 1 })) }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const state = readState(repoRoot(ctx));
      return text(params.issue ? { session: state.sessions.find((s) => s.issue === params.issue) ?? null } : state);
    },
  });
}
