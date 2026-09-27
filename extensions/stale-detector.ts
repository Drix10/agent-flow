/**
 * Stale Detector Extension — /doctor and /repair-docs backends.
 *
 * SECURITY: stale_detect is read-only. It runs ctxlint ONLY if it is already
 * installed locally and only when asked (v1.0.2 ran `npx ctxlint`, which
 * downloads and executes a package from the network when it is absent).
 * stale_repair writes CONTEXT_MANIFEST.json only after a human confirms.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requireConfirmation } from "./lib/confirm.js";
import { detectStale, repairStale } from "./lib/stale.js";
import { appendAudit } from "./lib/state.js";
import { repoRoot, text } from "./result.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "stale_detect",
    label: "Stale detect",
    description:
      "Validate context against the filesystem: context files exist, manifest references exist (exact case), timestamps are valid and " +
      "within staleness_threshold_days, no unfilled {{PLACEHOLDERS}}, manifest schema valid, and every `backticked/path` in the context " +
      "prose still exists. Read-only.",
    parameters: Type.Object({
      manifestPath: Type.Optional(Type.String({ description: "Manifest path, relative to the repo root (default CONTEXT_MANIFEST.json)" })),
      repoPath: Type.Optional(Type.String({ description: "Repository root (default: main repo root of the session)" })),
      prose: Type.Optional(Type.Boolean({ description: "Also check backticked paths inside context files (default true)" })),
      ctxlint: Type.Optional(Type.Boolean({ description: "Also run a locally installed ctxlint (never downloads). Default false." })),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const root = repoRoot(ctx, params.repoPath);
      const r = detectStale(root, { manifestPath: params.manifestPath, prose: params.prose, ctxlint: params.ctxlint });
      if (!r.ok) return text({ healthy: false, error: r.error, path: r.path });
      return text({ healthy: r.healthy, report: r.report, manifest: r.manifest, legacy_schema: r.legacy_schema });
    },
  });

  pi.registerTool({
    name: "stale_repair",
    label: "Stale repair",
    description:
      "Refresh last_verified for manifest references that still exist (and migrate a legacy contexts/covers manifest). " +
      "Certifies EXISTENCE only — call it AFTER you re-read the code and corrected the context prose. A human confirms the write.",
    parameters: Type.Object({
      manifestPath: Type.Optional(Type.String()),
      repoPath: Type.Optional(Type.String()),
      confirmation: Type.Optional(Type.String({ description: "Deprecated; ignored." })),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const root = repoRoot(ctx, params.repoPath);
      const before = detectStale(root, { manifestPath: params.manifestPath, prose: false });
      if (!before.ok) throw new Error(`cannot repair: ${before.error} (${before.path})`);
      const via = await requireConfirmation(
        ctx,
        "Refresh context manifest timestamps?",
        `Marks ${before.report.stale_files.length} stale file(s) as verified now. Approve only if their content was re-checked against the code.`,
      );
      const result = repairStale(root, { manifestPath: params.manifestPath });
      appendAudit(root, { event: "stale_repair", refreshed: result.refreshed, still_missing: result.still_missing.length, confirmed_via: via });
      return text({ ...result, confirmed_via: via });
    },
  });
}
