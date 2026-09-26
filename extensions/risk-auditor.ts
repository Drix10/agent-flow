/**
 * Risk Auditor Extension
 *
 * Scans for new risk surfaces: dependencies, auth code, data mutation paths.
 * Compares against a baseline of known risk surfaces.
 *
 * SECURITY: This extension only READS files. It never writes without
 * user confirmation. It never sends data to external servers.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { glob } from "glob";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { text } from "./result.js";

interface RiskSurface {
  type: "dependency" | "auth" | "payment" | "data-mutation" | "external-api";
  path: string;
  detail: string;
  firstSeen: string;
}

interface RiskBaseline {
  version: string;
  lastScan: string;
  surfaces: RiskSurface[];
}

const RISK_PATTERNS = {
  auth: /(auth|login|token|session|credential|password|secret|jwt|oauth)/i,
  payment: /(payment|billing|stripe|checkout|invoice|price|subscription)/i,
  "data-mutation": /(delete|drop|truncate|destroy|purge|migrate|alter)/i,
  "external-api": /(fetch|axios|http\.request|request\(|api\.)/i,
};

const BASELINE_FILE = ".risk-baseline.json";

const SurfaceSchema = Type.Object({
  type: Type.String(),
  path: Type.String(),
  detail: Type.String(),
  firstSeen: Type.String(),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "risk_audit",
    label: "Risk audit",
    description: "Scan for new risk surfaces: dependencies, auth code, payment code, data mutation paths, external API calls. Compares against a baseline.",
    parameters: Type.Object({
      repoPath: Type.Optional(Type.String({ default: "." })),
      baselinePath: Type.Optional(Type.String({ default: BASELINE_FILE })),
    }),
    execute: async (_toolCallId, params) => {
      const repoPath = params.repoPath ?? ".";
      const baselinePath = params.baselinePath ?? BASELINE_FILE;
      const surfaces: RiskSurface[] = [];

      // 1. Scan manifest files for dependencies
      const manifests = await glob(
        "**/{package.json,go.mod,Cargo.toml,pyproject.toml,requirements.txt}",
        { cwd: repoPath, ignore: ["node_modules/**", ".git/**"] }
      );

      for (const manifest of manifests) {
        const content = await readFile(join(repoPath, manifest), "utf-8");

        if (manifest.endsWith("package.json")) {
          const pkg = JSON.parse(content);
          const deps = {
            ...pkg.dependencies,
            ...pkg.devDependencies,
          };
          for (const [name] of Object.entries(deps)) {
            if (RISK_PATTERNS.payment.test(name)) {
              surfaces.push({
                type: "payment",
                path: manifest,
                detail: `Dependency: ${name}`,
                firstSeen: new Date().toISOString(),
              });
            }
            if (RISK_PATTERNS.auth.test(name)) {
              surfaces.push({
                type: "auth",
                path: manifest,
                detail: `Dependency: ${name}`,
                firstSeen: new Date().toISOString(),
              });
            }
          }
        }
      }

      // 2. Scan source files for auth/payment/data-mutation patterns
      const sourceFiles = await glob("**/*.{ts,js,go,rs,py}", {
        cwd: repoPath,
        ignore: ["node_modules/**", ".git/**", "dist/**", "build/**", "*.test.*"],
      });

      for (const file of sourceFiles) {
        const content = await readFile(join(repoPath, file), "utf-8");

        for (const [type, pattern] of Object.entries(RISK_PATTERNS)) {
          if (pattern.test(content)) {
            surfaces.push({
              type: type as RiskSurface["type"],
              path: file,
              detail: `Pattern match: ${pattern.source}`,
              firstSeen: new Date().toISOString(),
            });
          }
        }
      }

      // 3. Compare against baseline
      let newSurfaces: RiskSurface[] = [];
      if (existsSync(baselinePath)) {
        const baseline: RiskBaseline = JSON.parse(
          await readFile(baselinePath, "utf-8")
        );
        const baselineKeys = new Set(
          baseline.surfaces.map((s) => `${s.type}:${s.path}`)
        );
        newSurfaces = surfaces.filter(
          (s) => !baselineKeys.has(`${s.type}:${s.path}`)
        );
      } else {
        newSurfaces = surfaces;
      }

      return text({
        totalSurfaces: surfaces.length,
        newSurfaces: newSurfaces.length,
        surfaces,
        newSurfacesList: newSurfaces,
        baselineExists: existsSync(baselinePath),
      });
    },
  });

  pi.registerTool({
    name: "risk_baseline_update",
    label: "Risk baseline update",
    description: "Update the risk baseline after user review. Requires confirmation.",
    parameters: Type.Object({
      baselinePath: Type.Optional(Type.String({ default: BASELINE_FILE })),
      surfaces: Type.Optional(Type.Array(SurfaceSchema)),
      confirmation: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      const baselinePath = params.baselinePath ?? BASELINE_FILE;
      if (params.confirmation !== "CONFIRM_RISK_BASELINE") {
        throw new Error("Update rejected: confirmation string required.");
      }

      const baseline: RiskBaseline = {
        version: "1.0.0",
        lastScan: new Date().toISOString(),
        surfaces: (params.surfaces ?? []) as RiskSurface[],
      };

      await writeFile(baselinePath, JSON.stringify(baseline, null, 2), "utf-8");

      return text({ updated: baselinePath, count: baseline.surfaces.length });
    },
  });
}
