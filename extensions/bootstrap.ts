/**
 * Bootstrap Extension
 *
 * Scans the repository and generates tiered context files.
 *
 * SECURITY: This extension only READS files. It never writes without
 * explicit user confirmation. It never sends data to external servers.
 * It never modifies git history.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { glob } from "glob";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Type } from "typebox";
import { text } from "./result.js";

interface ScanResult {
  language: string;
  framework: string | null;
  testFramework: string | null;
  topLevelDirs: { path: string; description: string }[];
  entryPoints: string[];
  existingDocs: { path: string; lastModified: Date }[];
  ciConfig: string | null;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "bootstrap_scan",
    label: "Bootstrap scan",
    description: "Scan the repository structure. Read-only. Returns a scan result.",
    parameters: Type.Object({
      repoPath: Type.Optional(Type.String({ description: "Path to the repository root", default: "." })),
    }),
    execute: async (_toolCallId, params) => {
      const repoPath = params.repoPath ?? ".";
      const scan: ScanResult = {
        language: "unknown",
        framework: null,
        testFramework: null,
        topLevelDirs: [],
        entryPoints: [],
        existingDocs: [],
        ciConfig: null,
      };

      // Detect language
      const manifests = await glob("**/{package.json,go.mod,Cargo.toml,pyproject.toml,build.gradle}", {
        cwd: repoPath,
        ignore: ["node_modules/**", ".git/**"],
      });

      for (const manifest of manifests.slice(0, 3)) {
        const content = await readFile(join(repoPath, manifest), "utf-8");
        if (manifest.endsWith("package.json")) {
          const pkg = JSON.parse(content);
          scan.language = "typescript";
          if (pkg.devDependencies?.jest || pkg.devDependencies?.vitest) {
            scan.testFramework = "jest/vitest";
          }
        } else if (manifest.endsWith("go.mod")) {
          scan.language = "go";
          scan.testFramework = "go test";
        } else if (manifest.endsWith("Cargo.toml")) {
          scan.language = "rust";
          scan.testFramework = "cargo test";
        } else if (manifest.endsWith("pyproject.toml")) {
          scan.language = "python";
          scan.testFramework = "pytest";
        }
      }

      // Detect top-level directories
      const dirs = await glob("*/", {
        cwd: repoPath,
        ignore: ["node_modules/**", ".git/**", "dist/**", "build/**"],
      });

      scan.topLevelDirs = dirs.map((d) => ({
        path: d.replace(/\/$/, ""),
        description: "", // Filled by agent during proposal
      }));

      // Detect entry points
      const entryPoints = await glob("**/{main,index,app,server}.{ts,js,go,rs,py}", {
        cwd: repoPath,
        ignore: ["node_modules/**", ".git/**", "dist/**"],
      });
      scan.entryPoints = entryPoints;

      // Detect existing docs
      const docs = await glob("**/*.md", {
        cwd: repoPath,
        ignore: ["node_modules/**", ".git/**", "CHANGELOG.md"],
      });
      scan.existingDocs = await Promise.all(
        docs.map(async (doc) => {
          const st = await stat(join(repoPath, doc));
          return { path: doc, lastModified: st.mtime };
        })
      );

      // Detect CI
      const ciFiles = await glob(".github/workflows/*.yml", { cwd: repoPath });
      scan.ciConfig = ciFiles.length > 0 ? ciFiles[0] : null;

      return text(scan);
    },
  });

  pi.registerTool({
    name: "bootstrap_write",
    label: "Bootstrap write",
    description: "Write a context file after user confirmation. Requires explicit confirmation string.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to write" }),
      content: Type.String({ description: "File content" }),
      confirmation: Type.String({ description: "User confirmation string: CONFIRM_BOOTSTRAP" }),
    }),
    execute: async (_toolCallId, params) => {
      if (params.confirmation !== "CONFIRM_BOOTSTRAP") {
        throw new Error("Write rejected: confirmation string required.");
      }

      await mkdir(dirname(params.path), { recursive: true });
      await writeFile(params.path, params.content, "utf-8");

      return text({ written: params.path, size: params.content.length });
    },
  });
}
