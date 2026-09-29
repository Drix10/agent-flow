/**
 * Bootstrap Extension
 *
 * bootstrap_scan  — read-only reconnaissance (languages, commands, CI, existing
 *                   context files, secret suspects). Never writes.
 * bootstrap_write — writes ONE context file after a human confirms it.
 *
 * SECURITY:
 *  - Writes are confined to the repository (no `..`, no absolute paths, no
 *    symlinked escapes) and to context-file types (*.md, CONTEXT_MANIFEST.json,
 *    .codex/agents/*.toml).
 *  - Existing files are never overwritten unless `overwrite: true` AND the
 *    human confirms the overwrite.
 *  - CONTEXT_MANIFEST.json is schema-validated before it is written (FM-17).
 *  - Content containing secret-shaped strings is refused.
 *  - No network access. No git history changes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, realpathSync } from "node:fs";
import { basename, relative } from "node:path";
import { Type } from "typebox";
import { requireConfirmation } from "./lib/confirm.js";
import { atomicWrite, resolveInside, toPosix } from "./lib/fsutil.js";
import { tamperProofMatch } from "./lib/guard.js";
import { MANIFEST_FILE, loadManifestForGuard, matchAny, protectedPathsOf, validateManifest } from "./lib/manifest.js";
import { findSecrets } from "./lib/risk.js";
import { scanRepo } from "./lib/scan.js";
import { appendAudit } from "./lib/state.js";
import { repoRoot, text } from "./result.js";


export function allowedContextTarget(rel: string): boolean {
  const r = toPosix(rel);
  if (r.split("/").some((seg) => seg === ".git" || seg === "node_modules")) return false;
  if (r === MANIFEST_FILE) return true;
  if (/^\.codex\/agents\/[\w-]+\.toml$/.test(r)) return true;
  return /\.md$/i.test(r);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "bootstrap_scan",
    label: "Bootstrap scan",
    description:
      "Read-only repository scan for /bootstrap: languages, package managers, test frameworks, build/test/lint commands " +
      "(read from package.json scripts / Makefile), CI files, existing context files (AGENTS.md, CLAUDE.md, …), docs, default branch, " +
      "recent commits, and secret SUSPECTS (paths + kinds only, never values). Every field is backed by a file that was actually read.",
    parameters: Type.Object({
      repoPath: Type.Optional(Type.String({ description: "Repository root. Defaults to the main repo root of the session." })),
      maxFiles: Type.Optional(Type.Integer({ minimum: 100, maximum: 500000, description: "Cap on files walked (default 50000)." })),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const root = repoRoot(ctx, params.repoPath);
      return text(scanRepo(root, { maxFiles: params.maxFiles }));
    },
  });

  pi.registerTool({
    name: "bootstrap_write",
    label: "Bootstrap write",
    description:
      "Write ONE context file (AGENTS.md, <module>/AGENTS.md, DOCS_INDEX.md, CONTEXT_MANIFEST.json, harness agent definitions) " +
      "after the human has reviewed the exact content. A confirmation dialog is shown to the human; you cannot confirm on their behalf. " +
      "Refuses paths outside the repo, non-context file types, invalid manifests, secret-shaped content, and overwriting unless overwrite=true.",
    parameters: Type.Object({
      path: Type.String({ description: "Repo-relative path to write" }),
      content: Type.String({ description: "Full file content" }),
      overwrite: Type.Optional(Type.Boolean({ description: "Allow replacing an existing file (the human is asked explicitly)" })),
      repoPath: Type.Optional(Type.String()),
      /** Deprecated. Kept so v1.0.x prompts do not break; it is no longer a security boundary. */
      confirmation: Type.Optional(Type.String({ description: "Deprecated; ignored." })),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const root = repoRoot(ctx, params.repoPath);
      const abs = resolveInside(root, params.path);
      const rel = toPosix(relative(realpathSync(root), abs));
      if (!allowedContextTarget(rel)) {
        throw new Error(`bootstrap_write only writes context files (*.md, ${MANIFEST_FILE}, .codex/agents/*.toml); refused: ${rel}`);
      }
      // `AGENT_STATE.md` is a `.md` file, but it is a trust signal only state_update may write.
      const tamper = tamperProofMatch(rel);
      if (tamper) throw new Error(`refused: ${rel} is written only by agent-flow's own tools (${tamper})`);
      // Same rule the guard applies to write/edit: protected paths need a human's explicit override.
      if (process.env.AGENT_FLOW_ALLOW_PROTECTED !== "1") {
        const loaded = loadManifestForGuard(root);
        // A manifest that can't be loaded is fixed by rewriting it, so that one write stays possible.
        if (loaded.error && rel !== MANIFEST_FILE) throw new Error(`refused: ${MANIFEST_FILE} can't be loaded (${loaded.error}), so protected paths are unknown`);
        const prot = matchAny(protectedPathsOf(loaded.manifest), rel);
        if (prot) throw new Error(`refused: ${rel} is protected (${prot} in ${MANIFEST_FILE}). Escalate to Needs Me instead.`);
      }
      const secrets = findSecrets(params.content);
      if (secrets.length) {
        throw new Error(`refused: content contains ${secrets.map((x) => `${x.kind} (line ${x.lines.join(", ")})`).join("; ")}. Context files are sent to model providers — never put credentials in them.`);
      }
      if (basename(rel) === MANIFEST_FILE) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(params.content);
        } catch (e: any) {
          throw new Error(`refused: ${MANIFEST_FILE} is not valid JSON (${e.message})`);
        }
        const problems = validateManifest(parsed);
        if (problems.length) throw new Error(`refused: ${MANIFEST_FILE} fails schema validation:\n- ${problems.join("\n- ")}`);
      }
      const exists = existsSync(abs);
      if (exists && !params.overwrite) {
        throw new Error(`${rel} already exists. Propose a merge to the human and call again with overwrite: true only after they approve.`);
      }
      const lines = params.content.split("\n").length;
      const via = await requireConfirmation(
        ctx,
        exists ? `Overwrite ${rel}?` : `Create ${rel}?`,
        `${exists ? "REPLACES the existing file. " : ""}${lines} lines, ${params.content.length} bytes. Approve only if you reviewed this exact content.`,
      );
      atomicWrite(abs, params.content);
      appendAudit(root, { event: "bootstrap_write", path: rel, overwrite: exists, confirmed_via: via });
      return text({ written: rel, bytes: params.content.length, overwrote: exists, confirmed_via: via });
    },
  });
}
