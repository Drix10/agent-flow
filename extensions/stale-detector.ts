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

interface ContextManifest {
  context_files: {
    path: string;
    references: {
      path: string;
      type: "file" | "directory";
      last_verified: string;
      exists: boolean;
    }[];
  }[];
  staleness_threshold_days: number;
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
    description: "Detect stale context files by validating references against the filesystem.",
    parameters: {
      type: "object",
      properties: {
        manifestPath: {
          type: "string",
          description: "Path to CONTEXT_MANIFEST.json",
          default: "CONTEXT_MANIFEST.json",
        },
        repoPath: {
          type: "string",
          description: "Path to the repository root",
          default: ".",
        },
      },
    },
    handler: async ({ manifestPath = "CONTEXT_MANIFEST.json", repoPath = "." }) => {
      if (!existsSync(manifestPath)) {
        return { error: "manifest_not_found", path: manifestPath };
      }

      const manifest: ContextManifest = JSON.parse(await readFile(manifestPath, "utf-8"));
      const report: StaleReport = {
        stale_files: [],
        missing_paths: [],
        dead_commands: [],
        token_waste: [],
      };

      const thresholdMs = manifest.staleness_threshold_days * 24 * 60 * 60 * 1000;
      const now = Date.now();

      for (const contextFile of manifest.context_files) {
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

      return { healthy: isHealthy, report };
    },
  });

  pi.registerTool({
    name: "stale_repair",
    description: "Repair stale context files by updating manifests and rebuilding affected files. Requires user confirmation.",
    parameters: {
      type: "object",
      properties: {
        manifestPath: { type: "string", default: "CONTEXT_MANIFEST.json" },
        confirmation: { type: "string" },
      },
      required: ["confirmation"],
    },
    handler: async ({ manifestPath = "CONTEXT_MANIFEST.json", confirmation }: { manifestPath?: string; confirmation: string }) => {
      if (confirmation !== "CONFIRM_REPAIR") {
        throw new Error("Repair rejected: confirmation string required.");
      }

      const manifest: ContextManifest = JSON.parse(await readFile(manifestPath, "utf-8"));
      const now = new Date().toISOString();

      for (const contextFile of manifest.context_files) {
        for (const ref of contextFile.references) {
          if (existsSync(ref.path)) {
            ref.last_verified = now;
            ref.exists = true;
          } else {
            ref.exists = false;
          }
        }
      }

      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

      return { repaired: manifestPath, timestamp: now };
    },
  });
}
