/**
 * Risk Auditor Extension — /audit-risk backend.
 *
 * risk_audit is read-only. risk_baseline_update writes .risk-baseline.json
 * after a human confirms; it never silently wipes the baseline.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requireConfirmation } from "./lib/confirm.js";
import { resolveInside } from "./lib/fsutil.js";
import { BASELINE_FILE, auditRisk, updateBaseline } from "./lib/risk.js";
import { appendAudit } from "./lib/state.js";
import { repoRoot, text } from "./result.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "risk_audit",
    label: "Risk audit",
    description:
      "Scan for risk surfaces — every dependency (package.json, requirements*.txt, pyproject.toml, go.mod, Cargo.toml, Gemfile), " +
      "auth, payment, destructive data mutation, external HTTP, process exec, and secret-shaped strings (values never returned) — " +
      "and diff against .risk-baseline.json. Read-only. Heuristic: treat results as leads for review, not verdicts.",
    parameters: Type.Object({
      repoPath: Type.Optional(Type.String()),
      baselinePath: Type.Optional(Type.String({ description: `Relative to the repo root (default ${BASELINE_FILE})` })),
      includeTests: Type.Optional(Type.Boolean({ description: "Also scan test files for code patterns (default false)" })),
      full: Type.Optional(Type.Boolean({ description: "Return every surface, not just new ones (large output)" })),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const root = repoRoot(ctx, params.repoPath);
      const baseline = resolveInside(root, params.baselinePath ?? BASELINE_FILE);
      const r = auditRisk(root, baseline, { includeTests: params.includeTests });
      const { surfaces, ...summary } = r;
      return text(params.full ? r : { ...summary, newSurfacesList: r.newSurfacesList.slice(0, 200) });
    },
  });

  pi.registerTool({
    name: "risk_baseline_update",
    label: "Risk baseline update",
    description:
      "Accept reviewed risk surfaces into .risk-baseline.json. Omit acceptKeys to accept the entire current scan; pass keys (from " +
      "risk_audit newSurfacesList[].key) to accept only those. A human confirms the write.",
    parameters: Type.Object({
      repoPath: Type.Optional(Type.String()),
      baselinePath: Type.Optional(Type.String()),
      acceptKeys: Type.Optional(Type.Array(Type.String(), { maxItems: 5000 })),
      confirmation: Type.Optional(Type.String({ description: "Deprecated; ignored." })),
      /** v1.0.2 compatibility: surfaces were passed wholesale. Now ignored in favour of a fresh scan. */
      surfaces: Type.Optional(Type.Array(Type.Any())),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const root = repoRoot(ctx, params.repoPath);
      const baseline = resolveInside(root, params.baselinePath ?? BASELINE_FILE);
      const scope = params.acceptKeys ? `${params.acceptKeys.length} reviewed surface(s)` : "ALL current surfaces";
      const via = await requireConfirmation(ctx, "Update risk baseline?", `Accept ${scope} as known risk. Future audits will not report them as new.`);
      const r = updateBaseline(root, baseline, params.acceptKeys, {});
      appendAudit(root, { event: "risk_baseline_update", count: r.count, accepted: params.acceptKeys?.length ?? "all", confirmed_via: via });
      return text({ ...r, confirmed_via: via });
    },
  });
}
