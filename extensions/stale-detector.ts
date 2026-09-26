/**
 * Stale Detector Extension
 *
 * Detects stale context files by validating references against the filesystem.
 * Integrates with ctxlint and CI.
 *
 * SECURITY: This extension only READS files. It never writes without
 * user confirmation. It never sends data to external servers.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { text } from "./result.js";

interface ContextManifest {
  context_files?: {
    path: string;
    references: {
      path: string;
      type: "file" | "directory";
      last_verified: string;
      exists: boolean;
    }[];
  }[];
  // Alternate schema some generators emit (FM-17): flat cover lists, no per-ref metadata.
  contexts?: { path: string; covers: string[] }[];
  last_full_scan?: string;
  lastVerified?: string;
  generated_at?: string;
  staleness_threshold_days?: number;
}

// Normalize either schema to the context_files shape. Covers entries get the
// manifest-level timestamp (existence is still checked; staleness only when known).
function normalize(manifest: ContextManifest) {
  if (manifest.context_files) return { files: manifest.context_files, native: true };
  const stamp = manifest.last_full_scan ?? manifest.lastVerified ?? manifest.generated_at ?? new Date().toISOString();
  return {
    native: false,
    files: (manifest.contexts ?? []).map((c) => ({
      path: c.path,
      references: (c.covers ?? []).map((p) => ({
        path: p,
        type: "file" as const,
        last_verified: stamp,
        exists: true,
      })),
    })),
  };
}

interface StaleReport {
  stale_files: string[];
  missing_paths: { file: string; path: string }[];
  dead_commands: { file: string; command: string }[];
  token_waste: { file: string; estimated_tokens: number }[];
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "stale_detect",
    label: "Stale detect",
    description: "Detect stale context files by validating references against the filesystem.",
    parameters: Type.Object({
      manifestPath: Type.Optional(Type.String({ description: "Path to CONTEXT_MANIFEST.json", default: "CONTEXT_MANIFEST.json" })),
      repoPath: Type.Optional(Type.String({ description: "Path to the repository root", default: "." })),
    }),
    execute: async (_toolCallId, params) => {
      const manifestPath = params.manifestPath ?? "CONTEXT_MANIFEST.json";
      const repoPath = params.repoPath ?? ".";
      if (!existsSync(manifestPath)) {
        return text({ error: "manifest_not_found", path: manifestPath });
      }

      const manifest: ContextManifest = JSON.parse(await readFile(manifestPath, "utf-8"));
      const { files } = normalize(manifest);
      const report: StaleReport = {
        stale_files: [],
        missing_paths: [],
        dead_commands: [],
        token_waste: [],
      };

      const thresholdMs = (manifest.staleness_threshold_days ?? 30) * 24 * 60 * 60 * 1000;
      const now = Date.now();

      for (const contextFile of files) {
        for (const ref of contextFile.references) {
          const fullPath = join(repoPath, ref.path);

          // Check if referenced path exists
          if (!existsSync(fullPath)) {
            report.missing_paths.push({ file: contextFile.path, path: ref.path });
            continue;
          }

          // Check if reference is stale
          const lastVerified = new Date(ref.last_verified).getTime();
          if (now - lastVerified > thresholdMs) {
            if (!report.stale_files.includes(contextFile.path)) {
              report.stale_files.push(contextFile.path);
            }
          }
        }
      }

      // Run ctxlint if available
      try {
        execSync("npx ctxlint --json", { stdio: "pipe", cwd: repoPath });
      } catch (error: any) {
        // ctxlint found issues—parse output
        if (error.stdout) {
          try {
            const ctxlintResult = JSON.parse(error.stdout.toString());
            if (ctxlintResult.issues) {
              for (const issue of ctxlintResult.issues) {
                if (issue.type === "stale-command") {
                  report.dead_commands.push({ file: issue.file, command: issue.command });
                }
                if (issue.type === "token-waste") {
                  report.token_waste.push({
                    file: issue.file,
                    estimated_tokens: issue.estimated_tokens || 0,
                  });
                }
              }
            }
          } catch {
            // ctxlint not available or output not parseable
          }
        }
      }

      const isHealthy =
        report.stale_files.length === 0 &&
        report.missing_paths.length === 0 &&
        report.dead_commands.length === 0;

      return text({ healthy: isHealthy, report });
    },
  });

  pi.registerTool({
    name: "stale_repair",
    label: "Stale repair",
    description: "Repair stale context files by updating manifests and rebuilding affected files. Requires user confirmation.",
    parameters: Type.Object({
      manifestPath: Type.Optional(Type.String({ default: "CONTEXT_MANIFEST.json" })),
      repoPath: Type.Optional(Type.String({ description: "Path to the repository root", default: "." })),
      confirmation: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      const manifestPath = params.manifestPath ?? "CONTEXT_MANIFEST.json";
      const repoPath = params.repoPath ?? ".";
      if (params.confirmation !== "CONFIRM_REPAIR") {
        throw new Error("Repair rejected: confirmation string required.");
      }

      const manifest: ContextManifest = JSON.parse(await readFile(manifestPath, "utf-8"));
      const now = new Date().toISOString();
      const { files, native } = normalize(manifest);

      if (!native) {
        // Covers schema has no per-ref metadata — refresh the manifest-level stamp only.
        if (manifest.last_full_scan !== undefined) manifest.last_full_scan = now;
        else if (manifest.lastVerified !== undefined) manifest.lastVerified = now;
        else manifest.last_full_scan = now;
      } else if (manifest.context_files) {
        manifest.context_files = files;
      }

      for (const contextFile of files) {
        for (const ref of contextFile.references) {
          if (existsSync(join(repoPath, ref.path))) {
            ref.last_verified = now;
            ref.exists = true;
          } else {
            ref.exists = false;
          }
        }
      }

      // Sync normalized refs back only for the native schema (covers schema keeps its shape).

      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

      return text({ repaired: manifestPath, timestamp: now });
    },
  });
}
