/**
 * Classify Extension — mechanical risk classification of a real diff.
 *
 * Replaces the JavaScript snippet v1.0.2 asked the model to "run" in its head.
 * Output decides reviewer tier and whether a human must approve.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { Type } from "typebox";
import { classifyDiff } from "./lib/classify.js";
import { resolveInside } from "./lib/fsutil.js";
import { trustedManifest } from "./lib/manifest.js";
import { worktreeRel } from "./lib/worktree.js";
import { repoRoot, text } from "./result.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "risk_classify",
    label: "Risk classify",
    description:
      "Classify a change set by what it actually touches: protected paths (→ critical + violation), manifest risk_boundaries, " +
      "dependency manifests (→ medium, needs risk review), manifest review_paths (→ medium, human_approval_required; review_violations when " +
      "more than harmless added lines changed), path-segment heuristics when no boundaries are set. Returns risk_level, " +
      "reviewer_tier, human_approval_required, review_required, review_violations and reasons. Use after implementation; its result overrides any earlier guess.",
    parameters: Type.Object({
      issue: Type.Optional(Type.Integer({ minimum: 1, description: "Classify .worktrees/issue-N (working tree + commits vs base)" })),
      base: Type.Optional(Type.String({ description: "Base revision (default: manifest default_branch or detected default branch)" })),
      head: Type.Optional(Type.String({ description: "Head revision; omit to include uncommitted + untracked files" })),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const root = repoRoot(ctx);
      const cwd = params.issue ? resolveInside(root, worktreeRel(params.issue)) : resolve(ctx?.cwd ?? root);
      return text(classifyDiff(cwd, root, trustedManifest(root).manifest, params.base, params.head));
    },
  });
}
