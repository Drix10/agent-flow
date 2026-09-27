/**
 * Guard policy: pure decision function behind the Pi `tool_call` hook.
 *
 * Why this exists: FM-16 showed `allowed-tools` in SKILL.md is pre-approval,
 * not restriction — a Reviewer asked to write a file, wrote it. Pi's
 * `tool_call` event CAN block a call before it executes. This module decides.
 *
 * Enforcement strength, stated honestly:
 *  - write/edit (and look-alike custom tools): ENFORCED — blocked by path/role.
 *  - bash/powershell: BEST-EFFORT — pattern analysis of the command string.
 *    A determined model can still write through an interpreter we don't
 *    recognise. For hard isolation, also launch read-only roles with
 *    `pi --tools read,grep,find,ls` (no shell at all) or in a container.
 *
 * The role comes from AGENT_FLOW_ROLE, set by whoever launches the process.
 * The model cannot change its own role mid-session.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { CASE_INSENSITIVE_FS, toPosix } from "./fsutil.js";
import { ContextManifest, MANIFEST_FILE, contextFilePaths, matchAny } from "./manifest.js";

export const ROLES = ["orchestrator", "implementer", "reviewer", "qa", "gardener", "bootstrap"] as const;
export type Role = (typeof ROLES)[number];
export const READ_ONLY_ROLES: readonly Role[] = ["reviewer", "qa"];

export interface GuardInput {
  role: Role | null;
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
  root: string;
  manifest: ContextManifest | null;
  /** Absolute worktree path the implementer is confined to (AGENT_FLOW_WORKTREE). */
  worktree?: string;
  /** Human override for protected paths (AGENT_FLOW_ALLOW_PROTECTED=1). */
  allowProtected?: boolean;
}

export interface GuardDecision {
  block: true;
  reason: string;
  rule: string;
}

/** Role from env. Unknown values fail CLOSED (treated as reviewer), never open. */
export function parseRole(raw: string | undefined): { role: Role | null; warning?: string } {
  if (!raw || !raw.trim()) return { role: null };
  const r = raw.trim().toLowerCase() as Role;
  if ((ROLES as readonly string[]).includes(r)) return { role: r };
  return { role: "reviewer", warning: `unknown AGENT_FLOW_ROLE "${raw}" — failing closed as read-only reviewer` };
}

const FILE_WRITE_TOOLS = new Set(["write", "edit"]);
const MUTATING_CUSTOM = /(^|[_-])(write|edit|multi_?edit|patch|apply_?patch|str_?replace|create_?file|delete|remove|rename|move|mkdir|append)([_-]|$)/i;
const AGENT_FLOW_MUTATORS = new Set(["bootstrap_write", "stale_repair", "risk_baseline_update", "worktree_create", "worktree_remove", "state_update"]);

/** Which agent-flow mutating tools each role may call. */
const ROLE_TOOL_ALLOW: Record<Role, Set<string>> = {
  orchestrator: new Set(["worktree_create", "worktree_remove", "state_update"]),
  implementer: new Set([]),
  reviewer: new Set([]),
  qa: new Set([]),
  gardener: new Set(["stale_repair", "risk_baseline_update", "bootstrap_write"]),
  bootstrap: new Set(["bootstrap_write", "risk_baseline_update"]),
};

/** Files only agent-flow's own tools may write — trust signals must not be forgeable. */
const TAMPER_PROOF = [".agent-state.json", "AGENT_STATE.md", ".agent-flow/audit.jsonl", ".agent-flow/state.lock", ".git/"];

function pathArg(input: Record<string, unknown>): string | null {
  for (const k of ["path", "file_path", "filePath", "file", "target", "destination"]) {
    const v = input[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

function rel(root: string, cwd: string, p: string): { rel: string; outside: boolean } {
  const abs = resolve(cwd, p);
  let r = relative(root, abs);
  const outside = r.startsWith("..") || isAbsolute(r);
  r = toPosix(r);
  return { rel: r, outside };
}

function inside(dir: string, abs: string): boolean {
  const a = CASE_INSENSITIVE_FS ? abs.toLowerCase() : abs;
  const d = CASE_INSENSITIVE_FS ? dir.toLowerCase() : dir;
  const r = relative(d, a);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

function block(rule: string, reason: string): GuardDecision {
  return { block: true, rule, reason: `[agent-flow guard] ${reason}` };
}

// ---------------------------------------------------------------------------
// Shell analysis (best-effort)
// ---------------------------------------------------------------------------

const WRITE_VERBS = new Set([
  "rm", "rmdir", "mv", "cp", "tee", "touch", "mkdir", "ln", "chmod", "chown", "truncate", "dd", "install", "patch", "rsync", "shred", "unlink",
  // PowerShell
  "set-content", "add-content", "out-file", "remove-item", "move-item", "copy-item", "new-item", "rename-item", "clear-content", "sc", "ac", "ri", "del", "erase", "rd", "ni", "move", "copy", "ren",
]);
const GIT_MUTATING = /^git\s+(?:-C\s+\S+\s+)?(commit|push|add|rm|mv|reset|checkout|switch|restore|stash|rebase|merge|cherry-pick|revert|am|apply|clean|tag|branch\s+-[dDmMcC]|worktree\s+(add|remove|prune)|update-ref|config)\b/i;
const PKG_MUTATING = /^(npm|pnpm|yarn|bun)\s+(add|remove|rm|uninstall|un|publish|link|unlink|version|pkg|dedupe|prune|update|up|upgrade)\b|^(npm|pnpm|bun)\s+(install|i)\s+[^-\s]|^yarn\s+add\b|^pip3?\s+(install|uninstall)\b|^(uv|poetry)\s+(add|remove|pip)\b|^go\s+(get|mod\s+tidy)\b|^cargo\s+(add|remove|install)\b|^gem\s+install\b|^bundle\s+(add|update)\b/i;
const GH_MUTATING = /^gh\s+(pr\s+(create|merge|edit|close|comment|review|ready|reopen)|issue\s+(create|edit|close|comment|reopen|delete)|release\s+(create|delete|edit|upload)|repo\s+(create|delete|edit)|api\s+.*(-X|--method)\s*(POST|PUT|PATCH|DELETE))/i;
const INLINE_WRITE = /\b(node|deno|bun)\s+(-e|--eval|-p)\b.*\b(writeFile|appendFile|rmSync|unlink|rename|mkdir|createWriteStream|copyFile)|\bpython3?\s+-c\b.*(open\([^)]*['"][wa+]|\.write\(|os\.remove|os\.unlink|shutil\.|os\.rename|pathlib)|\b(perl|ruby)\s+-[a-zA-Z]*[ei]\b|\bsed\s+(-[a-zA-Z]*i|--in-place)|\bawk\s+-i\s+inplace/i;
const SNAPSHOT_OR_FIX = /(--update-?snapshots?|--updateSnapshot|--snapshot-update|--fix\b|--write\b|(\b(jest|vitest|playwright)\b.*\s-u\b))/i;
const DOWNLOAD_TO_FILE = /\b(curl\b.*\s(-o|-O|--output|--remote-name)\b|wget\b(?!.*(-O\s*-|--output-document=-)))/i;
const NO_VERIFY = /^git\s+(?:-C\s+\S+\s+)?(commit|push|merge|rebase|am)\b.*\s(--no-verify|-n)(\s|$)/i;
const FORCE_PUSH = /^git\s+(?:-C\s+\S+\s+)?push\b.*\s(--force|-f|--force-with-lease|\+\S+)(\s|=|$)/i;

function stripQuoted(cmd: string): string {
  return cmd.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** Split into simple commands and normalise the leading word. */
export function segments(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||;|\||\n|\$\(|`|\(|\)|\{|\}/)
    .map((s) =>
      s
        .trim()
        .replace(/^((\w+=\S*)\s+)+/, "")
        .replace(/^(sudo|command|exec|time|nice|env|nohup|xargs)(\s+-\S+)*\s+/i, "")
        .replace(/^(\w+=\S*\s+)+/, "")
        .trim(),
    )
    .filter(Boolean);
}

function hasRedirectWrite(cmd: string): boolean {
  const s = stripQuoted(cmd)
    .replace(/\d?>&\d/g, "")
    .replace(/&?\d?>>?\s*\/dev\/null/g, "")
    .replace(/\d?>>?\s*\$null/gi, "")
    .replace(/\d?>>?\s*nul\b/gi, "")
    .replace(/[=-]>/g, "");
  return /(^|[^<\d&])>/.test(s) || /\d>[^&]/.test(s);
}

export interface ShellFinding {
  mutating: boolean;
  why: string[];
}

export function analyzeShell(cmd: string): ShellFinding {
  const why: string[] = [];
  if (hasRedirectWrite(cmd)) why.push("output redirection to a file");
  for (const seg of segments(stripQuoted(cmd))) {
    const verb = seg.split(/\s+/)[0]?.toLowerCase().replace(/^.*[\\/]/, "").replace(/\.exe$/, "") ?? "";
    if (WRITE_VERBS.has(verb)) why.push(`\`${verb}\` modifies the filesystem`);
    if (GIT_MUTATING.test(seg)) why.push(`mutating git command (${seg.split(/\s+/).slice(0, 3).join(" ")})`);
    if (PKG_MUTATING.test(seg)) why.push("package install/publish changes dependencies");
    if (GH_MUTATING.test(seg)) why.push("mutating GitHub CLI call");
  }
  if (INLINE_WRITE.test(cmd)) why.push("inline interpreter/in-place edit that writes files");
  if (DOWNLOAD_TO_FILE.test(cmd)) why.push("download written to disk");
  return { mutating: why.length > 0, why: [...new Set(why)] };
}

/** Literal path prefixes from patterns, for "does this command mention a protected path". */
function literalPrefix(pattern: string): string {
  const p = toPosix(pattern).replace(/^\.\//, "");
  const cut = p.search(/[*?[]/);
  return (cut === -1 ? p : p.slice(0, cut)).replace(/\/+$/, "");
}

function mentions(cmd: string, patterns: string[]): string | null {
  const hay = CASE_INSENSITIVE_FS ? cmd.toLowerCase() : cmd;
  for (const p of patterns) {
    const lit = literalPrefix(p);
    if (lit.length < 3) continue;
    const needle = CASE_INSENSITIVE_FS ? lit.toLowerCase() : lit;
    if (hay.includes(needle)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------

export function decide(g: GuardInput): GuardDecision | null {
  const { role, toolName, input, cwd, root, manifest } = g;
  const tool = toolName.toLowerCase();
  const protectedPaths = (manifest?.protected_paths ?? []).filter((p): p is string => typeof p === "string" && p.length > 0);
  const ctxFiles = contextFilePaths(manifest);

  // ---- agent-flow's own mutating tools: per-role allow list -------------------
  if (AGENT_FLOW_MUTATORS.has(tool) && role && !ROLE_TOOL_ALLOW[role].has(tool)) {
    return block("role-tool", `role "${role}" may not call ${tool}.`);
  }

  // ---- file-writing tools -------------------------------------------------------
  const isFileWrite = FILE_WRITE_TOOLS.has(tool) || (!AGENT_FLOW_MUTATORS.has(tool) && MUTATING_CUSTOM.test(tool) && tool !== "bash" && tool !== "powershell");
  if (isFileWrite) {
    if (role && READ_ONLY_ROLES.includes(role)) {
      return block("read-only-role", `role "${role}" is read-only; ${toolName} is not allowed. Report findings instead of changing files.`);
    }
    const p = pathArg(input);
    if (!p) return null; // nothing path-like to judge; Pi's own validation applies
    const { rel: r, outside } = rel(root, cwd, p);
    const abs = resolve(cwd, p);

    if (!outside) {
      for (const t of TAMPER_PROOF) {
        if (r === t.replace(/\/$/, "") || r.startsWith(t)) {
          return block("tamper-proof", `${r} is written only by agent-flow tools (state_update, etc.) — direct edits would forge trust signals.`);
        }
      }
      const prot = matchAny(protectedPaths, r);
      if (prot && !g.allowProtected) {
        return block("protected-path", `${r} is protected (${prot} in ${MANIFEST_FILE}). Escalate to Needs Me instead of editing it.`);
      }
    }

    if (role === "implementer") {
      if (g.worktree && !inside(g.worktree, abs)) {
        return block("worktree-confinement", `implementer is confined to ${toPosix(relative(root, g.worktree)) || g.worktree}; refused write to ${toPosix(p)}.`);
      }
      // Paths inside the worktree: evaluate protection/context relative to the worktree root too.
      if (g.worktree) {
        const wr = toPosix(relative(g.worktree, abs));
        const prot = matchAny(protectedPaths, wr);
        if (prot && !g.allowProtected) return block("protected-path", `${wr} is protected (${prot}). Escalate instead of editing it.`);
        if (ctxFiles.includes(wr)) return block("context-file", `${wr} is a context file — only the Gardener edits context. Flag [CONTEXT_STALE] instead.`);
      } else if (!outside && ctxFiles.includes(r)) {
        return block("context-file", `${r} is a context file — only the Gardener edits context. Flag [CONTEXT_STALE] instead.`);
      }
    }

    if (role === "gardener" && !outside) {
      const okForGardener = r.endsWith(".md") || r === MANIFEST_FILE || ctxFiles.includes(r);
      if (!okForGardener) return block("gardener-scope", `the Gardener edits context files and docs only; ${r} is source/config. Open an issue for the Implementer instead.`);
    }
    if (outside && role && role !== "orchestrator") {
      return block("outside-repo", `${toPosix(p)} is outside the repository.`);
    }
    return null;
  }

  // ---- shell tools ----------------------------------------------------------------
  if (tool === "bash" || tool === "powershell") {
    const cmd = typeof input.command === "string" ? input.command : "";
    if (!cmd) return null;
    const firstLines = segments(stripQuoted(cmd));

    // Only the orchestrator (or a human session) may launch agents or pick roles.
    // Otherwise QA could run `AGENT_FLOW_ROLE=orchestrator pi -p "…"` and escape its role.
    if (role && role !== "orchestrator") {
      if (/\bAGENT_FLOW_[A-Z_]*\s*=|\$env:AGENT_FLOW_|\bunset\s+AGENT_FLOW_|Remove-Item\s+Env:AGENT_FLOW_/i.test(cmd)) {
        return block("role-escalation", `role "${role}" may not change AGENT_FLOW_* settings.`);
      }
      for (const seg of firstLines) {
        const verb = seg.split(/\s+/)[0]?.toLowerCase().replace(/^.*[\\/]/, "").replace(/\.(exe|cmd)$/, "");
        if (["pi", "claude", "codex", "gemini", "cursor-agent", "aider", "opencode", "goose"].includes(verb ?? "")) {
          return block("role-escalation", `role "${role}" may not launch another agent (${verb}). Only the orchestrator spawns roles.`);
        }
      }
    }

    // Every agent role: no bypassing hooks, no force-pushing, no pushing to the default branch.
    if (role) {
      for (const seg of firstLines) {
        if (NO_VERIFY.test(seg)) return block("no-verify", "`--no-verify` skips the pre-commit hook (hierarchy of corrections, level 3). Fix the hook failure instead.");
        if (FORCE_PUSH.test(seg)) return block("force-push", "force-push rewrites shared history. Push a new commit instead.");
        const push = seg.match(/^git\s+(?:-C\s+\S+\s+)?push\b(.*)$/i);
        const defaultBranch = manifest?.default_branch;
        const protectedBranches = ["main", "master", ...(defaultBranch ? [defaultBranch] : [])];
        if (push && protectedBranches.some((b) => new RegExp(`(\\s|:)${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(push[1]))) {
          return block("push-default-branch", "agents never push to the default branch — push agent/issue-N and open a PR.");
        }
      }
    }

    if (role && READ_ONLY_ROLES.includes(role) && SNAPSHOT_OR_FIX.test(cmd)) {
      return block("qa-no-autofix", "snapshot updates / --fix / --write change the code under test. Report the failure verbatim instead.");
    }

    const finding = analyzeShell(cmd);
    if (!finding.mutating) return null;

    if (role && READ_ONLY_ROLES.includes(role)) {
      // QA may install locked deps to run tests; nothing else that writes.
      const onlyCleanInstall = firstLines.every((s) => /^(npm\s+ci|pnpm\s+install\s+--frozen-lockfile|yarn\s+install\s+--(frozen-lockfile|immutable)|bun\s+install\s+--frozen-lockfile|pip\s+install\s+-r\s+\S+)(\s|$)/i.test(s) || !analyzeShell(s).mutating);
      if (role === "qa" && onlyCleanInstall && !hasRedirectWrite(cmd)) return null;
      return block("read-only-role", `role "${role}" is read-only; command looks mutating (${finding.why.join("; ")}). If this is a false positive, rephrase as a read-only command.`);
    }
    const tamper = mentions(cmd, TAMPER_PROOF.concat([".risk-baseline.json"]));
    if (tamper && role) return block("tamper-proof", `command writes near ${tamper}, which only agent-flow tools may change.`);
    const prot = mentions(cmd, protectedPaths);
    if (prot && !g.allowProtected) return block("protected-path", `mutating command references protected path ${prot}. Escalate to Needs Me instead.`);
    if (role === "implementer") {
      const ctx = mentions(cmd, ctxFiles.filter((f) => f.length >= 3));
      if (ctx) return block("context-file", `mutating command references context file ${ctx} — only the Gardener edits context.`);
    }
    return null;
  }

  return null;
}
