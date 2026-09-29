/**
 * Guard Extension — real enforcement on Pi (closes FM-16 for Pi).
 *
 * Hooks Pi's `tool_call` event, which runs BEFORE any tool executes and can
 * block it. Policy lives in lib/guard.ts. Role comes from AGENT_FLOW_ROLE,
 * which the launching process sets and the model cannot change.
 *
 * Always on (any role, including none):
 *   - write/edit to manifest `protected_paths` blocked (override: AGENT_FLOW_ALLOW_PROTECTED=1)
 *   - direct writes to agent-flow state/audit files and .git/ blocked
 * With a role:
 *   - reviewer, qa: write/edit blocked; mutating shell best-effort blocked;
 *     write/edit also removed from the active tool list at session start
 *   - implementer: confined to AGENT_FLOW_WORKTREE; context files blocked
 *   - gardener: may edit *.md and CONTEXT_MANIFEST.json only
 *   - all roles: no --no-verify, no force-push, no push to the default branch
 *
 * Every block is appended to .agent-flow/audit.jsonl.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";
import { findRepoRoot } from "./lib/fsutil.js";
import { decide, parseRole, READ_ONLY_ROLES } from "./lib/guard.js";
import { ContextManifest, loadManifestForGuard, manifestPathFor } from "./lib/manifest.js";
import { appendAudit } from "./lib/state.js";
import { text } from "./result.js";

export default function (pi: ExtensionAPI) {
  const { role, warning } = parseRole(process.env.AGENT_FLOW_ROLE);
  const allowProtected = process.env.AGENT_FLOW_ALLOW_PROTECTED === "1";
  let cache: { root: string; mtime: number; manifest: ContextManifest | null; error?: string } | null = null;
  const roots = new Map<string, string>(); // cwd → main repo root (avoids a git spawn per tool call)
  const rootOf = (cwd: string) => {
    let r = roots.get(cwd);
    if (!r) roots.set(cwd, (r = findRepoRoot(cwd)));
    return r;
  };

  function manifestFor(root: string): { manifest: ContextManifest | null; error?: string } {
    let mtime = -1;
    try {
      mtime = statSync(manifestPathFor(root)).mtimeMs;
    } catch {
      /* no manifest */
    }
    if (!cache || cache.root !== root || cache.mtime !== mtime) cache = { root, mtime, ...loadManifestForGuard(root) };
    return cache;
  }

  pi.on("session_start", (_event, ctx) => {
    if (warning) ctx?.ui?.notify?.(warning, "warning");
    if (role && READ_ONLY_ROLES.includes(role)) {
      const active = pi.getActiveTools();
      pi.setActiveTools(active.filter((t) => t !== "write" && t !== "edit"));
    }
  });

  pi.on("tool_call", (event, ctx) => {
    const cwd = ctx?.cwd ?? process.cwd();
    let root = cwd;
    try {
      root = rootOf(cwd);
      const worktree = process.env.AGENT_FLOW_WORKTREE ? resolve(root, process.env.AGENT_FLOW_WORKTREE) : undefined;
      const m = manifestFor(root);
      const decision = decide({
        role,
        toolName: event.toolName,
        input: (event.input ?? {}) as Record<string, unknown>,
        cwd,
        root,
        manifest: m.manifest,
        manifestError: m.error,
        worktree,
        allowProtected,
      });
      if (!decision) return undefined;
      appendAudit(root, { event: "guard_block", role, tool: event.toolName, rule: decision.rule, reason: decision.reason });
      return { block: true, reason: decision.reason };
    } catch (e: any) {
      // Same stance as `agent-flow guard`: a confined role fails closed, an ordinary session isn't bricked by a guard bug.
      if (!role) return undefined;
      const reason = `[agent-flow guard] guard error, refusing as role "${role}": ${e?.message ?? e}`;
      appendAudit(root, { event: "guard_block", role, tool: event.toolName, rule: "guard-error", reason });
      return { block: true, reason };
    }
  });

  pi.registerTool({
    name: "guard_status",
    label: "Guard status",
    description: "Show which agent-flow role this session runs as and what the guard enforces (protected paths, read-only status, worktree confinement).",
    parameters: Type.Object({}),
    execute: async (_id, _params, _signal, _onUpdate, ctx) => {
      const root = rootOf(ctx?.cwd ?? process.cwd());
      const m = manifestFor(root);
      return text({
        role,
        warning: warning ?? null,
        read_only: role ? READ_ONLY_ROLES.includes(role) : false,
        worktree: process.env.AGENT_FLOW_WORKTREE ?? null,
        protected_paths: m.manifest?.protected_paths ?? [],
        manifest_error: m.error ?? null,
        allow_protected_override: allowProtected,
        enforcement: {
          "write/edit": "enforced (tool_call hook)",
          "bash/powershell": "best-effort pattern analysis — launch read-only roles with `pi --tools read,grep,find,ls` for a hard guarantee",
        },
      });
    },
  });
}
