/**
 * Guard policy: the pure decision function behind every harness hook — Pi's
 * `tool_call` event, and the Claude Code `PreToolUse` hook (`agent-flow guard`).
 *
 * Why this exists: FM-16 showed `allowed-tools` in SKILL.md is pre-approval,
 * not restriction — a Reviewer asked to write a file, wrote it. A pre-tool
 * hook CAN block a call before it executes. This module decides.
 *
 * Enforcement strength, stated honestly:
 *  - file-writing tools: ENFORCED — every target path is resolved through
 *    symlinks and checked against role, worktree and protected paths.
 *  - shell: BEST-EFFORT — pattern analysis of the command string. A model
 *    can still write through a script file we can't see into. For hard
 *    isolation, launch read-only roles with no shell tool, or in a sandbox.
 *
 * The role comes from AGENT_FLOW_ROLE (or the harness's subagent type), set by
 * whoever launches the process. The model cannot change its own role.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { CASE_INSENSITIVE_FS, landingPath, toPosix } from "./fsutil.js";
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
const MUTATING_CUSTOM = /(^|_)(write|edit|multi_?edit|notebook_?edit|patch|apply_?patch|str_?replace|create_?file|delete|remove|rename|move|mkdir|append)(_|$)/;
/** Tools whose names look mutating but only touch the harness's own UI state. */
const HARMLESS = new Set(["todo_write", "todowrite", "todo_read"]);
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
/**
 * What keeps agents in their lane: harness agent definitions (the Claude Code
 * reviewer's tool list IS its read-only guarantee), installed skills, CI and
 * hook config. No agent role edits these; a human does.
 */
const AGENT_CONFIG = [".claude/", ".codex/", ".gemini/", ".pi/", ".agents/", ".cursor/", ".windsurf/", ".github/workflows/", ".github/skills/", ".husky/", ".githooks/"];

/** camelCase / PascalCase / kebab → snake, so `writeFile` and `NotebookEdit` are recognised. */
function toolWords(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

const PATH_KEYS = ["path", "file_path", "filePath", "file", "target", "destination", "notebook_path", "notebookPath", "new_path", "newPath", "old_path", "oldPath", "source", "from", "to"];
const PATCH_KEYS = ["input", "patch", "diff", "content"];

/** Every path a file-writing call would touch: plain keys, edit batches, and patch headers. */
export function targetPaths(input: Record<string, unknown>, isPatchTool = false): string[] {
  const out = new Set<string>();
  const take = (o: unknown) => {
    if (!o || typeof o !== "object") return;
    for (const k of PATH_KEYS) {
      const v = (o as Record<string, unknown>)[k];
      if (typeof v === "string" && v.trim()) out.add(v.trim());
    }
  };
  take(input);
  for (const k of ["edits", "changes", "files", "operations"]) {
    const arr = input[k];
    if (Array.isArray(arr)) arr.forEach(take);
  }
  if (isPatchTool) {
    for (const k of PATCH_KEYS) {
      const v = input[k];
      if (typeof v !== "string") continue;
      for (const m of v.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$|^(?:\+\+\+|---) (?:[ab]\/)?(.+)$/gm)) {
        const p = (m[1] ?? m[2] ?? m[3] ?? "").trim();
        if (p && p !== "/dev/null") out.add(p);
      }
    }
  }
  return [...out];
}

const fold = (s: string) => (CASE_INSENSITIVE_FS ? s.toLowerCase() : s);

function within(dir: string, abs: string): boolean {
  const r = relative(fold(dir), fold(abs));
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

function underAny(r: string, prefixes: readonly string[]): string | null {
  const f = fold(r);
  for (const t of prefixes) {
    const ft = fold(t);
    if (f === ft.replace(/\/$/, "") || f.startsWith(ft)) return t;
  }
  return null;
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
const GIT_MUTATING_SUB = /^(commit|push|add|rm|mv|reset|checkout|switch|restore|stash|rebase|merge|cherry-pick|revert|am|apply|clean|tag|worktree\s+(add|remove|prune|move)|update-ref|update-index|config|replace|filter-branch|gc|prune|notes)\b|^branch\s+.*(\s|^)-[dDmMcCf]\b/i;
const PKG_MUTATING = /^(npm|pnpm|yarn|bun)\s+(add|remove|rm|uninstall|un|publish|link|unlink|version|pkg|dedupe|prune|update|up|upgrade)\b|^(npm|pnpm|bun)\s+(install|i)\b|^yarn(\s+install)?\s*$|^yarn\s+add\b|^pip3?\s+(install|uninstall)\b|^(uv|poetry)\s+(add|remove|pip|lock)\b|^go\s+(get|mod\s+tidy)\b|^cargo\s+(add|remove|install|update)\b|^gem\s+install\b|^bundle\s+(add|update|install)\b/i;
const CLEAN_INSTALL = /^(npm\s+ci|pnpm\s+install\s+--frozen-lockfile|yarn\s+install\s+--(frozen-lockfile|immutable)|bun\s+install\s+--frozen-lockfile|pip3?\s+install\s+-r\s+\S+|uv\s+sync\s+--(locked|frozen)|poetry\s+install\s+--no-root|bundle\s+install\s+--frozen)(\s|$)/i;
const GH_MUTATING = /^gh\s+(pr\s+(create|merge|edit|close|comment|review|ready|reopen)|issue\s+(create|edit|close|comment|reopen|delete)|release\s+(create|delete|edit|upload)|repo\s+(create|delete|edit)|api\s+.*(-X|--method)\s*(POST|PUT|PATCH|DELETE))/i;
const INLINE_WRITE = /\b(node|deno|bun)\s+(-e|--eval|-p)\b.*\b(writeFile|appendFile|rmSync|unlink|rename|mkdir|createWriteStream|copyFile)|\bpython3?\s+-c\b.*(open\([^)]*['"][wa+]|\.write\(|os\.remove|os\.unlink|shutil\.|os\.rename|pathlib)|\b(perl|ruby)\s+-[a-zA-Z]*[ei]\b|\bsed\b[^|;&]*\s(-[a-zA-Z]*i[a-zA-Z]*|--in-place)(\s|=|$)|\bawk\s+-i\s+inplace/i;
/** A script fed on stdin can do anything; its text isn't in `command` to analyse. */
const OPAQUE_SCRIPT = /\b(python3?|node|ruby|perl|php|deno|bun|bash|sh|zsh)\s+(-\s*)?<</i;
/** Formatters that rewrite files unless told only to check. */
const FORMATTER = /^(gofmt\s+.*-[a-z]*w|go\s+fmt\b|black\b|isort\b|cargo\s+fmt\b|rustfmt\b|ruff\s+format\b|clang-format\s+.*-i\b|terraform\s+fmt\b|dotnet\s+format\b|mix\s+format\b|swiftformat\b|ktlint\s+.*-F\b|rubocop\s+.*-[aA]\b|biome\s+(format|check)\s+.*--(write|apply))/i;
const FORMATTER_CHECK_ONLY = /\s(--check|--diff|-check|-l|--list-different|--dry-run)(\s|$)/i;
const SNAPSHOT_OR_FIX = /(--update-?snapshots?|--updateSnapshot|--snapshot-update|--fix\b|--write\b|(\b(jest|vitest|playwright)\b.*\s-u\b))/i;
const DOWNLOAD_TO_FILE = /\b(curl\b.*\s(-o|-O|--output|--remote-name)\b|wget\b(?!.*(-O\s*-|--output-document=-)))/i;
const AGENT_CLIS = new Set(["pi", "claude", "claude-code", "codex", "gemini", "gemini-cli", "cursor-agent", "aider", "opencode", "goose", "amp", "qwen", "crush", "pi-coding-agent"]);

function stripQuoted(cmd: string): string {
  return cmd.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/**
 * The command plus every command hidden inside `sh -c '…'`, `pwsh -Command "…"`
 * or `eval "…"` — quote-stripping would otherwise make their contents invisible.
 */
export function expandCommand(cmd: string, depth = 0): string[] {
  const out = [cmd];
  if (depth > 3) return out;
  const re = /\b(?:(?:ba|z|da|k)?sh|pwsh|powershell(?:\.exe)?|cmd(?:\.exe)?|eval)\s+(?:-[A-Za-z]+\s+)*?(?:-[A-Za-z]*c\b|-Command|\/c|(?<=eval\s+))\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1/gi;
  for (const m of cmd.matchAll(re)) out.push(...expandCommand(m[2], depth + 1));
  return out;
}

/** Split into simple commands and normalise the leading word. */
export function segments(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||;|\||\n|\$\(|`|\(|\)|\{|\}/)
    .map((s) => {
      let t = s.trim();
      for (let i = 0; i < 4; i++) {
        const before = t;
        t = t
          .replace(/^((\w+=\S*)\s+)+/, "")
          .replace(/^(sudo|command|exec|time|nice|env|nohup|xargs|then|do|else)(\s+-\S+)*\s+/i, "")
          .replace(/^(npx|bunx|pnpx|npm\s+exec|pnpm\s+(dlx|exec)|yarn\s+dlx)(\s+(-y|--yes|--no-install|-p\s+\S+|--package(=|\s+)\S+|-q|--quiet))*\s+(--\s+)?/i, "")
          .trim();
        if (t === before) break;
      }
      return t;
    })
    .filter(Boolean);
}

function verbOf(seg: string): string {
  const w = seg.split(/\s+/)[0] ?? "";
  return w
    .toLowerCase()
    .replace(/^.*[\\/]/, "") // a path, or an npm @scope/
    .replace(/@.*$/, "") // an npm @version
    .replace(/\.(exe|cmd|ps1)$/, "");
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

export interface GitCall {
  sub: string;
  args: string;
  configs: string[];
}

/** `git [-C dir] [-c k=v] [--no-pager] … <sub> <args>` → its subcommand, args and `-c` values. */
export function parseGit(seg: string): GitCall | null {
  const m = seg.match(/^git(?:\.exe)?\s+(.*)$/i);
  if (!m) return null;
  let rest = m[1];
  const configs: string[] = [];
  for (;;) {
    const g =
      rest.match(/^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env)(?:=|\s+)(\S+)\s*/) ??
      rest.match(/^(--no-pager|-P|--paginate|-p|--bare|--no-replace-objects|--literal-pathspecs|--no-optional-locks|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs)\s*/);
    if (!g) break;
    if ((g[1] === "-c" || g[1] === "--config-env") && g[2]) configs.push(g[2]);
    rest = rest.slice(g[0].length);
  }
  const sm = rest.match(/^(\S+)\s*(.*)$/);
  if (!sm) return null;
  return { sub: sm[1].toLowerCase(), args: sm[2] ?? "", configs };
}

/** Short-option cluster containing `letter` (`-nm`, `-fu`), or the long form. */
function hasFlag(args: string, letter: string, long: string[]): boolean {
  if (new RegExp(`(^|\\s)-[a-zA-Z]*${letter}[a-zA-Z]*(\\s|$)`).test(args)) return true;
  return long.some((l) => new RegExp(`(^|\\s)${l}(\\s|=|$)`).test(args));
}

export interface ShellFinding {
  mutating: boolean;
  why: string[];
}

export function analyzeShell(cmd: string): ShellFinding {
  const why: string[] = [];
  for (const c of expandCommand(cmd)) {
    if (hasRedirectWrite(c)) why.push("output redirection to a file");
    for (const seg of segments(stripQuoted(c))) {
      const verb = verbOf(seg);
      if (WRITE_VERBS.has(verb)) why.push(`\`${verb}\` modifies the filesystem`);
      const g = parseGit(seg);
      if (g && GIT_MUTATING_SUB.test(`${g.sub} ${g.args}`)) why.push(`mutating git command (git ${g.sub})`);
      if (PKG_MUTATING.test(seg) && !CLEAN_INSTALL.test(seg)) why.push("package install changes dependencies or the lockfile");
      if (CLEAN_INSTALL.test(seg)) why.push("lockfile install");
      if (GH_MUTATING.test(seg)) why.push("mutating GitHub CLI call");
      if (FORMATTER.test(seg) && !FORMATTER_CHECK_ONLY.test(seg)) why.push("formatter rewrites files in place");
    }
    if (INLINE_WRITE.test(c)) why.push("inline interpreter/in-place edit that writes files");
    if (OPAQUE_SCRIPT.test(c)) why.push("script fed on stdin (contents can't be checked)");
    if (DOWNLOAD_TO_FILE.test(c)) why.push("download written to disk");
  }
  return { mutating: why.length > 0, why: [...new Set(why)] };
}

/**
 * Literal (non-glob) chunks of a pattern, for "does this command mention a
 * protected path". Splitting on glob metacharacters also catches patterns that
 * start with a wildcard: `*.env` -> [".env"].
 */
function literalChunks(pattern: string): string[] {
  const p = toPosix(pattern).replace(/^\.\//, "");
  return p
    .split(/[*?[\]]+/)
    .map((s) => s.replace(/^\/+|\/+$/g, ""))
    .filter((s) => s.length >= 3);
}

function mentions(cmd: string, patterns: readonly string[]): string | null {
  const hay = fold(cmd);
  for (const p of patterns) {
    for (const chunk of literalChunks(p)) if (hay.includes(fold(chunk))) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// File writes
// ---------------------------------------------------------------------------

function decideWrite(g: GuardInput, p: string, protectedPaths: string[], ctxFiles: string[]): GuardDecision | null {
  const { role, cwd, root } = g;
  const lexical = resolve(cwd, p);
  const landing = landingPath(lexical);
  const rootReal = landingPath(root);
  const views = [
    { abs: lexical, base: root },
    { abs: landing, base: rootReal },
  ].map(({ abs, base }) => {
    const r = relative(base, abs);
    return { abs, rel: toPosix(r), outside: r.startsWith("..") || isAbsolute(r) };
  });
  const outside = views.some((v) => v.outside);
  const shown = toPosix(p);

  for (const v of views) {
    if (v.outside) continue;
    const t = underAny(v.rel, TAMPER_PROOF);
    if (t) return block("tamper-proof", `${v.rel} is written only by agent-flow tools (state_update, etc.) — direct edits would forge trust signals.`);
    if (role) {
      const c = underAny(v.rel, AGENT_CONFIG);
      if (c) return block("agent-config", `${v.rel} is agent/CI configuration (${c}) — agents don't edit what constrains them. Escalate to a human.`);
    }
    const prot = matchAny(protectedPaths, v.rel);
    if (prot && !g.allowProtected) return block("protected-path", `${v.rel} is protected (${prot} in ${MANIFEST_FILE}). Escalate to Needs Me instead of editing it.`);
  }
  if (role && landing !== lexical && views[1].outside && !views[0].outside) {
    return block("symlink-escape", `${shown} resolves through a symlink to ${toPosix(landing)}, outside the repository.`);
  }

  if (role === "implementer" && g.worktree) {
    const wt = g.worktree;
    const wtReal = landingPath(wt);
    if (!within(wt, lexical) || !within(wtReal, landing)) {
      return block("worktree-confinement", `implementer is confined to ${toPosix(relative(root, wt)) || wt}; refused write to ${shown}${landing !== lexical ? ` (resolves to ${toPosix(landing)})` : ""}.`);
    }
    for (const [abs, base] of [
      [lexical, wt],
      [landing, wtReal],
    ] as const) {
      const wr = toPosix(relative(base, abs));
      const c = underAny(wr, AGENT_CONFIG);
      if (c) return block("agent-config", `${wr} is agent/CI configuration (${c}) — escalate instead of editing it.`);
      const t = underAny(wr, TAMPER_PROOF);
      if (t) return block("tamper-proof", `${wr} is written only by agent-flow tools.`);
      const prot = matchAny(protectedPaths, wr);
      if (prot && !g.allowProtected) return block("protected-path", `${wr} is protected (${prot}). Escalate instead of editing it.`);
      if (ctxFiles.some((f) => fold(f) === fold(wr))) return block("context-file", `${wr} is a context file — only the Gardener edits context. Flag [CONTEXT_STALE] instead.`);
    }
  } else if (role === "implementer" && views.some((v) => !v.outside && ctxFiles.some((f) => fold(f) === fold(v.rel)))) {
    return block("context-file", `${shown} is a context file — only the Gardener edits context. Flag [CONTEXT_STALE] instead.`);
  }

  if (role === "gardener" && !outside) {
    const r = views[1].rel;
    const okForGardener = r.endsWith(".md") || r === MANIFEST_FILE || ctxFiles.includes(r);
    if (!okForGardener) return block("gardener-scope", `the Gardener edits context files and docs only; ${r} is source/config. Open an issue for the Implementer instead.`);
  }
  if (outside && role && role !== "orchestrator") {
    return block("outside-repo", `${shown} is outside the repository${landing !== lexical ? ` (resolves to ${toPosix(landing)})` : ""}.`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function decideShell(g: GuardInput, cmd: string, protectedPaths: string[], ctxFiles: string[]): GuardDecision | null {
  const { role, manifest } = g;
  const segs = segments(stripQuoted(cmd));

  if (role && role !== "orchestrator") {
    // Only the orchestrator (or a human) launches agents or picks roles —
    // otherwise QA could run `AGENT_FLOW_ROLE=orchestrator pi -p …` and escape.
    if (/\bAGENT_FLOW_[A-Z_]*\s*=|\$env:AGENT_FLOW_|\bunset\s+AGENT_FLOW_|Remove-Item\s+Env:AGENT_FLOW_|\bexport\s+-n\s+AGENT_FLOW_/i.test(cmd)) {
      return block("role-escalation", `role "${role}" may not change AGENT_FLOW_* settings.`);
    }
    for (const seg of segs) {
      const v = verbOf(seg);
      if (AGENT_CLIS.has(v)) return block("role-escalation", `role "${role}" may not launch another agent (${v}). Only the orchestrator spawns roles.`);
    }
  }

  if (role) {
    // Checked on the raw text: quoting the value (`-c "core.hooksPath=…"`) must not hide it.
    if (/\bgit\b/i.test(cmd) && /\bcore\.hookspath\b/i.test(cmd)) {
      return block("no-verify", "changing core.hooksPath disables the pre-commit hook. Fix the hook failure instead.");
    }
    const defaultBranch = manifest?.default_branch;
    const protectedBranches = new Set(["main", "master", ...(typeof defaultBranch === "string" && defaultBranch ? [defaultBranch] : [])]);
    for (const seg of segs) {
      const gc = parseGit(seg);
      if (!gc) continue;
      if (gc.configs.some((c) => /^core\.hookspath=/i.test(c)) || (gc.sub === "config" && /\bcore\.hookspath\b/i.test(gc.args))) {
        return block("no-verify", "changing core.hooksPath disables the pre-commit hook. Fix the hook failure instead.");
      }
      // `-n` is --no-verify only for commit (for push it's --dry-run, which is harmless).
      const skipsHook = /(^|\s)--no-verify(\s|$)/.test(gc.args) || (gc.sub === "commit" && hasFlag(gc.args, "n", []));
      if (["commit", "merge", "rebase", "am", "cherry-pick", "revert", "push"].includes(gc.sub) && skipsHook) {
        return block("no-verify", "`--no-verify` skips the pre-commit hook. Fix the hook failure instead.");
      }
      if (gc.sub === "push") {
        if (hasFlag(gc.args, "f", ["--force", "--force-with-lease", "--force-if-includes", "--mirror", "--delete"]) || /(^|\s)\+\S/.test(gc.args) || /(^|\s)-[a-zA-Z]*d[a-zA-Z]*(\s|$)/.test(gc.args)) {
          return block("force-push", "force-push / delete rewrites shared history. Push a new commit instead.");
        }
        if (/(^|\s)--all(\s|$)/.test(gc.args)) return block("push-default-branch", "`push --all` pushes the default branch too — push agent/issue-N only.");
        const refspecs = gc.args
          .split(/\s+/)
          .filter((t) => t && !t.startsWith("-"))
          .slice(1); // first positional is the remote
        for (const spec of refspecs) {
          const dest = (spec.includes(":") ? spec.split(":").pop()! : spec).replace(/^\+/, "").replace(/^refs\/heads\//, "");
          if (protectedBranches.has(dest)) return block("push-default-branch", "agents never push to the default branch — push agent/issue-N and open a PR.");
        }
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
    const onlyCleanInstall = role === "qa" && !hasRedirectWrite(cmd) && segs.every((s) => CLEAN_INSTALL.test(s) || !analyzeShell(s).mutating);
    if (onlyCleanInstall) return null;
    return block("read-only-role", `role "${role}" is read-only; command looks mutating (${finding.why.join("; ")}). If this is a false positive, rephrase as a read-only command.`);
  }
  const tamper = mentions(cmd, TAMPER_PROOF.concat([".risk-baseline.json"]));
  if (tamper && role) return block("tamper-proof", `command writes near ${tamper}, which only agent-flow tools may change.`);
  // Not for the orchestrator: its launch prompts legitimately name `.claude/agents/…`.
  if (role && role !== "orchestrator") {
    const cfg = mentions(cmd, AGENT_CONFIG);
    if (cfg) return block("agent-config", `mutating command references agent/CI configuration (${cfg}). Escalate to a human.`);
  }
  const prot = mentions(cmd, protectedPaths);
  if (prot && !g.allowProtected) return block("protected-path", `mutating command references protected path ${prot}. Escalate to Needs Me instead.`);
  if (role === "implementer") {
    const ctx = mentions(cmd, ctxFiles.filter((f) => f.length >= 3));
    if (ctx) return block("context-file", `mutating command references context file ${ctx} — only the Gardener edits context.`);
  }
  return null;
}

// ---------------------------------------------------------------------------

export function decide(g: GuardInput): GuardDecision | null {
  const { role, toolName, input } = g;
  const tool = toolName.toLowerCase();
  const words = toolWords(toolName);
  const protectedPaths = (g.manifest?.protected_paths ?? []).filter((p): p is string => typeof p === "string" && p.length > 0);
  const ctxFiles = contextFilePaths(g.manifest);

  // ---- agent-flow's own mutating tools: per-role allow list -------------------
  if (AGENT_FLOW_MUTATORS.has(tool) && role && !ROLE_TOOL_ALLOW[role].has(tool)) {
    return block("role-tool", `role "${role}" may not call ${tool}.`);
  }

  // ---- shell tools ----------------------------------------------------------------
  if (tool === "bash" || tool === "powershell" || tool === "shell" || words === "run_shell_command" || words === "exec_command") {
    const cmd = [input.command, input.cmd, input.script].find((c): c is string => typeof c === "string" && c.length > 0) ?? (Array.isArray(input.command) ? input.command.join(" ") : "");
    if (!cmd) return null;
    for (const c of expandCommand(cmd)) {
      const d = decideShell(g, c, protectedPaths, ctxFiles);
      if (d) return d;
    }
    return null;
  }

  // ---- file-writing tools -------------------------------------------------------
  const isFileWrite = !HARMLESS.has(words) && (FILE_WRITE_TOOLS.has(tool) || (!AGENT_FLOW_MUTATORS.has(tool) && MUTATING_CUSTOM.test(words)));
  if (!isFileWrite) return null;
  if (role && READ_ONLY_ROLES.includes(role)) {
    return block("read-only-role", `role "${role}" is read-only; ${toolName} is not allowed. Report findings instead of changing files.`);
  }
  const paths = targetPaths(input, /patch|diff/.test(words));
  if (!paths.length) {
    // Can't see where it writes. A confined role fails closed; an unconfined session is left to the harness.
    if (role === "implementer" || role === "gardener" || role === "bootstrap") {
      return block("unknown-target", `${toolName} was called without a path the guard can check, so it can't be confined. Use a tool that names its target file.`);
    }
    return null;
  }
  for (const p of paths) {
    const d = decideWrite(g, p, protectedPaths, ctxFiles);
    if (d) return d;
  }
  return null;
}
