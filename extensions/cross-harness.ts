/**
 * Cross-Harness Detection Extension.
 *
 * v1.0.2 "detected the active harness" by looking for marker directories in the
 * repo — so any repo with a `.claude/` folder reported Claude Code, even though
 * this code only ever runs inside Pi (it is a Pi extension). Now it reports the
 * truth: you are in Pi, and here are the harnesses this repo is configured for.
 *
 * SECURITY: read-only.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { repoRoot, text } from "./result.js";

export const HARNESSES = [
  { harness: "pi", markers: [".pi"], skillPath: ".pi/skills/", contextFile: "AGENTS.md" },
  { harness: "claude-code", markers: [".claude", "CLAUDE.md"], skillPath: ".claude/skills/", contextFile: "CLAUDE.md (import @AGENTS.md)" },
  { harness: "codex", markers: [".codex"], skillPath: ".agents/skills/", contextFile: "AGENTS.md" },
  { harness: "gemini-cli", markers: [".gemini", "GEMINI.md"], skillPath: ".gemini/skills/", contextFile: "GEMINI.md or settings.context.fileName=AGENTS.md" },
  { harness: "cursor", markers: [".cursor", ".cursorrules"], skillPath: ".cursor/skills/", contextFile: "AGENTS.md" },
  { harness: "copilot", markers: [".github/copilot-instructions.md", ".github/skills"], skillPath: ".github/skills/", contextFile: "AGENTS.md" },
] as const;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "detect_harness",
    label: "Detect harness",
    description: "Report the running harness (always Pi — this is a Pi extension) and which other harnesses this repo is configured for, with their skill and context-file paths.",
    parameters: Type.Object({ repoPath: Type.Optional(Type.String()) }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const root = repoRoot(ctx, params.repoPath);
      const configured = HARNESSES.filter((h) => h.markers.some((m) => existsSync(join(root, m)))).map((h) => ({
        harness: h.harness,
        evidence: h.markers.filter((m) => existsSync(join(root, m))),
        skillPath: h.skillPath,
        contextFile: h.contextFile,
      }));
      return text({
        runningIn: "pi",
        role: process.env.AGENT_FLOW_ROLE ?? null,
        configured,
        crossClientSkillPath: ".agents/skills/",
        note: "Outside Pi, use the `agent-flow` CLI (npx agent-flow …) for the same checks.",
      });
    },
  });
}
