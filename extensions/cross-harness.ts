/**
 * Cross-Harness Detection Extension
 *
 * Detects the active harness (Pi, Claude Code, Codex, Gemini CLI, Cursor)
 * and exposes the correct skill directory path.
 *
 * SECURITY: Read-only. Never writes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { text } from "./result.js";

type Harness = "pi" | "claude-code" | "codex" | "gemini-cli" | "cursor" | "unknown";

const HARNESS_MARKERS: { harness: Harness; markers: string[] }[] = [
  { harness: "pi", markers: [".pi", "pi.config.json"] },
  { harness: "claude-code", markers: [".claude", "CLAUDE.md"] },
  { harness: "codex", markers: [".codex", ".agents"] },
  { harness: "gemini-cli", markers: [".gemini"] },
  { harness: "cursor", markers: [".cursor"] },
];

function getSkillPath(harness: Harness): string {
  switch (harness) {
    case "pi": return ".pi/skills/";
    case "claude-code": return ".claude/skills/";
    case "codex": return ".agents/skills/";
    case "gemini-cli": return ".gemini/skills/";
    case "cursor": return ".cursor/skills/";
    default: return ".agents/skills/"; // cross-client convention
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "detect_harness",
    label: "Detect harness",
    description: "Detect the active coding harness and return the correct skill directory path.",
    parameters: Type.Object({
      repoPath: Type.Optional(Type.String({ default: "." })),
    }),
    execute: async (_toolCallId, params) => {
      const repoPath = params.repoPath ?? ".";
      for (const { harness, markers } of HARNESS_MARKERS) {
        for (const marker of markers) {
          if (existsSync(join(repoPath, marker))) {
            return text({
              harness,
              marker: join(repoPath, marker),
              skillPath: getSkillPath(harness),
            });
          }
        }
      }
      return text({ harness: "unknown", skillPath: ".agents/skills/" });
    },
  });
}
