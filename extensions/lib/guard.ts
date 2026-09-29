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
 *  - shell: BEST-EFFORT — the command is lexed and pattern-analysed: redirect
 *    targets and the paths of common write verbs are resolved (tracking `cd`)
 *    and checked like file writes. An interpreter or a script file we can't
 *    see into can still get around it. For hard isolation, launch read-only
 *    roles with no shell tool, or run the agent in a container/sandbox.
 *  - hook-skipping, force-push, remote-branch deletion and pushes to the
 *    default branch are blocked for EVERY agent session, role or not: the
 *    guard only ever sees agent tool calls, never a human's own terminal.
 *
 * The role comes from AGENT_FLOW_ROLE (or the harness's subagent type), set by
 * whoever launches the process. The model cannot change its own role.
 */

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, parse as parsePath, relative, resolve } from "node:path";
import { CASE_INSENSITIVE_FS, escapesBase, landingPath, toPosix, walk } from "./fsutil.js";
import { ContextManifest, MANIFEST_FILE, contextFilePaths, denyReadPathsOf, matchAny, matchesPattern, protectedPathsOf } from "./manifest.js";
import { isEnvFile } from "./risk.js";

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
  /** Human override for the secret-read rule (AGENT_FLOW_ALLOW_SECRET_READ=1). */
  allowSecretRead?: boolean;
  /** Most files inspected under a directory being removed before the guard assumes it holds a protected path (default 20000). */
  walkLimit?: number;
  /**
   * Set when CONTEXT_MANIFEST.json exists but can't be loaded. Protected paths are
   * then unknown, so writes fail closed (a trailing comma must not switch the guard off).
   */
  manifestError?: string;
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
const MUTATING_CUSTOM = /(^|_)(write|edit|multi_?edit|notebook_?edit|patch|apply_?patch|str_?replace|create_?file|create_or_update_file|update_?file|push_?files|delete|remove|rename|move|mkdir|append)(_|$)/;
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
const TAMPER_PROOF = [".agent-state.json", "AGENT_STATE.md", ".agent-flow/audit.jsonl", ".agent-flow/state.lock", ".risk-baseline.json", ".git/"];
/**
 * The wiring that makes the guard run: the hook registration and the installed copy of agent-flow itself.
 * While protection is configured, no session edits these; a human does (AGENT_FLOW_ALLOW_PROTECTED=1).
 */
const GUARD_WIRING = [".claude/settings.json", ".claude/settings.local.json", "node_modules/@drix10/agent-flow/"];

/** The tamper-proof pattern `rel` falls under, if any. */
export const tamperProofMatch = (rel: string): string | null => underAny(rel, TAMPER_PROOF);

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
  return r === "" || !escapesBase(r);
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
const GIT_MUTATING_SUB = /^(commit|push|add|rm|mv|reset|checkout|switch|restore|stash|rebase|merge|cherry-pick|revert|am|apply|clean|tag|worktree\s+(add|remove|prune|move)|update-ref|update-index|config(?!.*\s(--get\S*|--list|-l|--show-\S+)(\s|$))|replace|filter-branch|gc|prune|notes|pull|clone|init|submodule\s+(add|update|init|deinit|sync|foreach)|remote\s+(add|remove|rm|rename|set-url|set-head|set-branches|prune))\b|^branch\b(.*\s)?(-[a-zA-Z]*[dDmMcCfu]|--(delete|move|copy|force|set-upstream-to|unset-upstream|edit-description|track|create-reflog))\b/i;
const PKG_MUTATING = /^(npm|pnpm|yarn|bun)\s+(add|remove|rm|uninstall|un|publish|link|unlink|version|pkg|dedupe|prune|update|up|upgrade)\b|^(npm|pnpm|bun)\s+(install|i)\b|^yarn(\s+install)?\s*$|^yarn\s+add\b|^pip3?\s+(install|uninstall)\b|^(uv|poetry)\s+(add|remove|pip|lock)\b|^go\s+(get|mod\s+tidy)\b|^cargo\s+(add|remove|install|update)\b|^gem\s+install\b|^bundle\s+(add|update|install)\b/i;
const CLEAN_INSTALL = /^(npm\s+ci|pnpm\s+install\s+--frozen-lockfile|yarn\s+install\s+--(frozen-lockfile|immutable)|bun\s+install\s+--frozen-lockfile|pip3?\s+install\s+-r\s+\S+|uv\s+sync\s+--(locked|frozen)|poetry\s+install\s+--no-root|bundle\s+install\s+--frozen)(\s|$)/i;
const GH_MUTATING = /^gh\s+(pr\s+(create|merge|edit|close|comment|review|ready|reopen)|issue\s+(create|edit|close|comment|reopen|delete)|release\s+(create|delete|edit|upload)|repo\s+(create|delete|edit)|api\s+.*(-X|--method)[\s=]*(POST|PUT|PATCH|DELETE)|api\b(?!.*(-X|--method)[\s=]*GET\b).*\s(-f|-F|--field|--raw-field|--input)(\s|=|$))/i;
const INLINE_WRITE = /\b(node|deno|bun)\s+(-e|--eval|-p)\b.*\b(writeFile|appendFile|rmSync|unlink|rename|mkdir|createWriteStream|copyFile)|\bpython3?\s+-c\b.*(open\([^)]*['"][wa+]|\.write\(|os\.remove|os\.unlink|shutil\.|os\.rename|pathlib)|\b(perl|ruby)\b[^|;&\n]*\s-(?!-)[a-zA-Z]*[ei]|\bsed\b[^|;&\n]*\s(-(?!-)[a-zA-Z]*i|--in-place)|\bawk\s+-i\s+inplace/i;
/** A script fed on stdin can do anything; its text isn't in `command` to analyse. */
const OPAQUE_SCRIPT = /\b(python3?|node|ruby|perl|php|deno|bun|bash|sh|zsh)\s+(-\s*)?<</i;
/** Formatters that rewrite files unless told only to check. */
const FORMATTER = /^(prettier\b.*\s(-w|--write)\b|gofmt\s+.*-[a-z]*w|go\s+fmt\b|black\b|isort\b|cargo\s+fmt\b|rustfmt\b|ruff\s+format\b|clang-format\s+.*-i\b|terraform\s+fmt\b|dotnet\s+format\b|mix\s+format\b|swiftformat\b|ktlint\s+.*-F\b|rubocop\s+.*-[aA]\b|biome\s+(format|check)\s+.*--(write|apply))/i;
const FORMATTER_CHECK_ONLY = /\s(--check|--diff|-check|-l|--list-different|--dry-run)(\s|$)/i;
const SNAPSHOT_OR_FIX = /(--update-?snapshots?|--updateSnapshot|--snapshot-update|--fix\b|--write\b|(\b(jest|vitest|playwright)\b.*\s-u\b))/i;
// curl short options cluster (`-sSo f`); -D/-c write header dumps and cookie jars. `-X` is skipped: `-XPOST` isn't -O.
const DOWNLOAD_TO_NOWHERE = /(\s-[a-zA-Z]*o|\s--output)(\s+|=)(\/dev\/null|-)(\s|$)/;
const DOWNLOAD_TO_FILE = /\bcurl\b[^|;&\n]*\s(-(?![-X])[a-zA-Z]*[oODc]|--(output|remote-name|output-dir|dump-header|cookie-jar|trace|trace-ascii|stderr)\b)|\bwget\b(?![^|;&\n]*(\s-[a-zA-Z]*O\s*-(\s|$)|--output-document=-))/;
const AGENT_CLIS = new Set(["pi", "claude", "claude-code", "codex", "gemini", "gemini-cli", "cursor-agent", "aider", "opencode", "goose", "amp", "qwen", "crush", "pi-coding-agent"]);

/**
 * `"rm" f`, `'rm' f`, `r"m" f` and `\rm f` all run rm, but quote-stripping
 * would erase the command word. Unquote every quoted bare word first — no
 * spaces or metacharacters, so nothing that could turn into an operator.
 */
export function unquoteBareWords(cmd: string): string {
  const bare = /^[\w./@+:,=%^-]+$/;
  let out = "";
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === "\\" && i + 1 < cmd.length) {
      out += /[\w./-]/.test(cmd[i + 1]) ? cmd[i + 1] : ch + cmd[i + 1];
      i += 2;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== ch) j += ch === '"' && cmd[j] === "\\" ? 2 : 1;
      const body = cmd.slice(i + 1, j);
      out += bare.test(body) ? body : cmd.slice(i, j + 1);
      i = j + 1;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

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
      for (let i = 0; i < 8; i++) {
        const before = t;
        // Wrappers that run their argument as a command: their option values must not become the verb.
        t = t
          .replace(/^((\w+=\S*)\s+)+/, "")
          .replace(/^(sudo|doas)(\s+(-[ugCDhpRrTU]\s*\S+|-\S+))*\s+/i, "")
          .replace(/^nice(\s+(-n\s*\S+|--adjustment(=|\s+)\S+|-\S+))*\s+/i, "")
          .replace(/^timeout(\s+(-[sk]\s*\S+|-\S+))*\s+\d[\d.]*[smhd]?\s+/i, "")
          .replace(/^env(\s+(-[uCS]\s*\S+|-\S*|\w+=\S*))*\s+/i, "")
          .replace(/^xargs(\s+(-[IdEsLnPa]\s*\S+|-\S+))*\s+/i, "")
          .replace(/^(stdbuf|ionice|chrt|taskset)(\s+(-[cnp]\s+\S+|-\S+|\d\S*))*\s+/i, "")
          .replace(/^(command|exec|time|nohup|builtin|busybox|then|do|else|!)(\s+-\S+)*\s+/i, "")
          .replace(/^python[\d.]*\s+-m\s+/i, "")
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
  // `&>file` / `&>>file` write too (fd dups like `2>&1` were removed above).
  return /(^|[^<\d])>/.test(s) || /\d>[^&]/.test(s);
}

export interface GitCall {
  sub: string;
  args: string;
  configs: string[];
  /** The last `-C <dir>`: where git actually runs. */
  dir?: string;
}

/** `git [-C dir] [-c k=v] [--no-pager] … <sub> <args>` → its subcommand, args and `-c` values. */
export function parseGit(seg: string): GitCall | null {
  const m = seg.match(/^git(?:\.exe)?\s+(.*)$/i);
  if (!m) return null;
  let rest = m[1];
  const configs: string[] = [];
  let dir: string | undefined;
  for (;;) {
    const g =
      rest.match(/^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env)(?:=|\s+)(\S+)\s*/) ??
      rest.match(/^(--no-pager|-P|--paginate|-p|--bare|--no-replace-objects|--literal-pathspecs|--no-optional-locks|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs)\s*/);
    if (!g) break;
    if ((g[1] === "-c" || g[1] === "--config-env") && g[2]) configs.push(g[2]);
    if (g[1] === "-C" && g[2]) {
      // Each relative -C is taken from the directory the previous one selected; an absolute one starts over.
      const next = g[2].replace(/^["']|["']$/g, "");
      dir = dir && !isAbsolute(next) ? join(dir, next) : next;
    }
    rest = rest.slice(g[0].length);
  }
  const sm = rest.match(/^(\S+)\s*(.*)$/);
  if (!sm) return null;
  return { sub: sm[1].toLowerCase(), args: sm[2] ?? "", configs, ...(dir ? { dir } : {}) };
}

/** Short-option cluster containing `letter` (`-nm`, `-fu`), or the long form. */
function hasFlag(args: string, letter: string, long: string[]): boolean {
  if (new RegExp(`(^|\\s)-[a-zA-Z]*${letter}[a-zA-Z]*(\\s|$)`).test(args)) return true;
  return long.some((l) => new RegExp(`(^|\\s)${l}(\\s|=|$)`).test(args));
}

/**
 * git accepts any unambiguous prefix of a long option, so `--no-verif`,
 * `--forc` and `--mirr` work. Match every prefix of `name` at least `min`
 * chars long; an ambiguous one makes git error out, so blocking it costs nothing.
 */
function hasLong(args: string, name: string, min: number): boolean {
  return args.split(/\s+/).some((t) => {
    const n = t.split("=")[0];
    return n.length >= min && n.startsWith("--") && name.startsWith(n);
  });
}

export interface ShellFinding {
  mutating: boolean;
  why: string[];
}

export function analyzeShell(cmd: string, depth = 0): ShellFinding {
  const why: string[] = [];
  for (const raw of expandCommand(cmd)) {
    const c = unquoteBareWords(raw);
    if (hasRedirectWrite(c)) why.push("output redirection to a file");
    for (const seg of segments(stripQuoted(c))) {
      const verb = verbOf(seg);
      const onlyDevices = verb === "tee" && seg.split(/\s+/).slice(1).filter((w) => !w.startsWith("-")).every((w) => DEVICE.test(w));
      if (WRITE_VERBS.has(verb) && !onlyDevices) why.push(`\`${verb}\` modifies the filesystem`);
      if (verb === "find") {
        if (/\s-(delete|fprint0?|fprintf|fls)\b/.test(seg)) why.push("`find` deletes or writes files");
        for (const m of seg.matchAll(/\s-(?:exec|execdir|ok|okdir)\s+(.+?)(?=\s(?:\\|\+)(?:\s|$)|$)/g)) {
          if (depth < 3) why.push(...analyzeShell(m[1], depth + 1).why);
        }
      }
      const g = parseGit(seg);
      if (g && GIT_MUTATING_SUB.test(`${g.sub} ${g.args}`) && !gitReadOnly(g)) why.push(`mutating git command (git ${g.sub})`);
      if (PKG_MUTATING.test(seg) && !CLEAN_INSTALL.test(seg)) why.push("package install changes dependencies or the lockfile");
      if (CLEAN_INSTALL.test(seg)) why.push("lockfile install");
      if (GH_MUTATING.test(seg)) why.push("mutating GitHub CLI call");
      if (FORMATTER.test(seg) && !FORMATTER_CHECK_ONLY.test(seg)) why.push("formatter rewrites files in place");
    }
    if (INLINE_WRITE.test(c)) why.push("inline interpreter/in-place edit that writes files");
    if (OPAQUE_SCRIPT.test(c)) why.push("script fed on stdin (contents can't be checked)");
    if (DOWNLOAD_TO_FILE.test(c) && !DOWNLOAD_TO_NOWHERE.test(c)) why.push("download written to disk");
  }
  return { mutating: why.length > 0, why: [...new Set(why)] };
}

/**
 * Literal (non-glob) chunks of a pattern, for "does this command mention a
 * protected path". Splitting on glob metacharacters also catches patterns that
 * start with a wildcard: `*.env` -> [".env"].
 */
function literalChunks(pattern: string): { text: string; whole: boolean; starts: boolean; root: boolean }[] {
  const p = toPosix(pattern).replace(/^\.\//, "");
  const out: { text: string; whole: boolean; starts: boolean; root: boolean }[] = [];
  for (const m of p.matchAll(/[^*?[\]]+/g)) {
    const after = p[m.index + m[0].length];
    const text = m[0].replace(/^\/+|\/+$/g, "");
    // A chunk that ends a path segment in the pattern (`.git/`, `config/`,
    // `*.env`) must end a segment in the command too: `.git` is not `.github`.
    // Likewise one that starts a segment must start one: `config/` is not `myconfig`.
    const starts = m.index === 0 || p[m.index - 1] === "/" || m[0].startsWith("/");
    if (text.length >= 3) out.push({ text, whole: after === undefined || m[0].endsWith("/"), starts, root: m.index === 0 });
  }
  return out;
}

const PATH_END = /^($|[\s/'"`;&|)<>])/;
const PATH_START = /(^|[\s/'"`;&|(<>=:])$/;
const ROOT_START = /(^|[\s'"`;&|(<>=:])(\.\/)?$/;

function mentions(cmd: string, patterns: readonly string[]): string | null {
  const hay = fold(cmd);
  for (const p of patterns) {
    for (const { text, whole, starts, root } of literalChunks(p)) {
      const needle = fold(text);
      for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
        if (starts && !PATH_START.test(hay.slice(Math.max(0, i - 1), i))) continue;
        // `config/` means the repo's config/, not src/config/ (same as the file-tool check).
        // `./config/` still counts.
        if (root && !ROOT_START.test(hay.slice(Math.max(0, i - 3), i))) continue;
        if (!whole || PATH_END.test(hay.slice(i + needle.length, i + needle.length + 1))) return p;
      }
    }
  }
  return null;
}

/** Mutation reasons whose targets `shellWrites` resolves to real paths (redirects, the verbs in WRITE_ARGS). */
const resolvedWhy = (why: string) =>
  why === "output redirection to a file" || Object.keys(WRITE_ARGS).some((v) => why === `\`${v}\` modifies the filesystem`);
const DATA_VERBS = new Set(["echo", "printf", "print", "logger", "write-host", "write-output", "say"]);
const PATTERN_VERBS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "sed", "awk", "gawk", "perl"]);
const MESSAGE_OPT = /^(-m|--message|-t|--title|-b|--body|--subject)$/;

/**
 * The words of a command that can name a file: quotes removed, and data dropped —
 * commit/PR messages, echo/printf text, search patterns and sed/awk scripts. A
 * commit message saying "load config/ lazily" writes nothing to config/.
 * Heredoc-fed interpreters keep their raw text: that body is code, not data.
 */
function pathWords(cmd: string): string {
  if (OPAQUE_SCRIPT.test(cmd)) return cmd;
  const out: string[] = [];
  for (const sc of lexShell(cmd)) {
    out.push(...sc.writes.map((w) => w.text));
    // `F=config/x; rm $F`: an assigned value may be the path a later word expands to.
    for (const w of sc.words) {
      const as = w.text.match(/^[A-Za-z_]\w*=(.+)$/);
      if (as) out.push(as[1]);
    }
    let a = effectiveArgv(sc.words).map((w) => w.text);
    const v = cmdName(effectiveArgv(sc.words)[0]);
    if (DATA_VERBS.has(v)) continue;
    if (v === "git") {
      const g = parseGit(a.join(" "));
      const at = g ? a.findIndex((w, i) => i > 0 && w.toLowerCase() === g.sub) : -1;
      a = a.slice(at > 0 ? at + 1 : 1);
    } else {
      out.push(a[0] ?? "");
      a = a.slice(1);
    }
    let patternTaken = !PATTERN_VERBS.has(v) || v === "perl";
    let endOpts = false;
    for (let i = 0; i < a.length; i++) {
      const w = a[i];
      if (w === "--" && !endOpts) {
        endOpts = true;
        continue;
      }
      if (endOpts) {
        if (!patternTaken) patternTaken = true;
        else out.push(w);
        continue;
      }
      if (MESSAGE_OPT.test(w) || (/^-[a-zA-Z]*m$/.test(w) && v === "git") || ((w === "-e" || w === "--regexp" || w === "--expression") && PATTERN_VERBS.has(v))) {
        i++;
        if (w === "-e" || w === "--regexp" || w === "--expression") patternTaken = true;
        continue;
      }
      if (/^(--message|--title|--body|--subject|--regexp|--expression)=/.test(w) || (/^-m./.test(w) && v === "git")) continue;
      if (!patternTaken && !w.startsWith("-")) {
        patternTaken = true;
        continue;
      }
      out.push(w);
    }
  }
  return out.join(" ");
}

/** git reads that the mutating-subcommand regex would otherwise flag. */
function gitReadOnly(g: GitCall): boolean {
  const a = g.args.trim();
  const pos = a.split(/\s+/).filter((w) => w && !w.startsWith("-"));
  switch (g.sub) {
    case "stash":
      return /^(list|show)\b/.test(a);
    case "notes":
      return a === "" || /^(list|show)\b/.test(a);
    case "tag":
      return a === "" || /^(-l|--list|-n\d*|--contains|--no-contains|--points-at|--merged|--no-merged|-v|--verify|--sort|--format)\b/.test(a);
    case "config":
      if (/^(get|list)\b/.test(a)) return true;
      return pos.length === 1 && !/(^|\s)(--(add|unset|unset-all|replace-all|rename-section|remove-section|edit)|-e)\b/.test(a);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Shell lexing: where a command writes (best-effort)
// ---------------------------------------------------------------------------

export interface ShWord {
  text: string;
  /** Contains `$…`, a substitution or brace expansion: the real value is unknowable here. */
  dynamic: boolean;
  /** Contains an unquoted `*`, `?` or `[`. */
  glob: boolean;
}

export interface ShCmd {
  words: ShWord[];
  /** Files its redirections write (`>`, `>>`, `>|`, `&>`, `2>`, `<>`). */
  writes: ShWord[];
  /** Files it reads through `<` (`cat < .env`). */
  reads: ShWord[];
}

/**
 * Just enough of a POSIX shell lexer to know what each simple command's words
 * are (quotes removed) and which files its redirections write. Regexes over
 * the raw text can't tell `echo "a > b"` from `echo a > b`, or see past quotes.
 * `$(…)` / backtick bodies are lexed as commands of their own; heredoc bodies
 * are skipped as data.
 */
export function lexShell(src: string, depth = 0): ShCmd[] {
  const cmds: ShCmd[] = [];
  let cur: ShCmd = { words: [], writes: [], reads: [] };
  let w = null as ShWord | null;
  let redirect = null as "write" | "read" | "heredoc" | "heredoc-strip" | null;
  const heredocs: { delim: string; strip: boolean }[] = [];
  const word = () => (w ??= { text: "", dynamic: false, glob: false });
  const endWord = () => {
    if (!w) return;
    if (/\{[^}]*(,|\.\.)[^}]*\}/.test(w.text)) w.dynamic = true;
    if (redirect === "heredoc" || redirect === "heredoc-strip") heredocs.push({ delim: w.text, strip: redirect === "heredoc-strip" });
    else if (redirect === "write") cur.writes.push(w);
    else if (redirect === "read") cur.reads.push(w);
    else cur.words.push(w);
    redirect = null;
    w = null;
  };
  const endCmd = () => {
    endWord();
    redirect = null;
    if (cur.words.length || cur.writes.length || cur.reads.length) cmds.push(cur);
    cur = { words: [], writes: [], reads: [] };
  };
  const inner = (body: string) => {
    if (depth < 4) cmds.push(...lexShell(body, depth + 1));
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      endCmd();
      i++;
      for (const h of heredocs.splice(0)) {
        while (i < src.length) {
          const nl = src.indexOf("\n", i);
          const line = src.slice(i, nl < 0 ? src.length : nl);
          i = nl < 0 ? src.length : nl + 1;
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
        }
      }
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i++;
    } else if (c === "#" && !w) {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl;
    } else if (c === "\\") {
      if (src[i + 1] !== "\n") word().text += src[i + 1] ?? "";
      i += 2;
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j < 0 ? src.length : j;
      word().text += src.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      const x = word();
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < src.length && '"\\$`\n'.includes(src[i + 1])) {
          x.text += src[i + 1];
          i += 2;
          continue;
        }
        if (src[i] === "$" || src[i] === "`") x.dynamic = true;
        x.text += src[i++];
      }
      i++;
    } else if (c === "`") {
      const j = src.indexOf("`", i + 1);
      const end = j < 0 ? src.length : j;
      inner(src.slice(i + 1, end));
      const x = word();
      x.dynamic = true;
      x.text += "`";
      i = end + 1;
    } else if (c === "$" && (src[i + 1] === "(" || src[i + 1] === "{")) {
      const open = src[i + 1];
      const close = open === "(" ? ")" : "}";
      let d = 0;
      let j = i + 1;
      for (; j < src.length; j++) {
        if (src[j] === open) d++;
        else if (src[j] === close && --d === 0) break;
      }
      if (open === "(") inner(src.slice(i + 2, j));
      const x = word();
      x.dynamic = true;
      x.text += "$";
      i = j + 1;
    } else if (c === "$") {
      const x = word();
      x.dynamic = true;
      x.text += c;
      i++;
    } else if (c === "&" && src[i + 1] === ">") {
      endWord();
      i += src[i + 2] === ">" ? 3 : 2;
      redirect = "write";
    } else if (c === ">" || c === "<") {
      // A bare number right before the operator is its fd (`2>`), not an argument.
      if (w && /^\d+$/.test(w.text) && !w.dynamic) w = null;
      else endWord();
      if (c === "<") {
        const op = src.slice(i).match(/^(<<<|<<-|<<|<>|<&|<\(|<)/)![0];
        i += op === "<(" ? 1 : op.length; // `<(cmd)` is a command, not a file
        redirect = op === "<<-" ? "heredoc-strip" : op === "<<" ? "heredoc" : op === "<>" ? "write" : op === "<(" ? null : "read";
        continue;
      }
      let j = i + 1;
      if (src[j] === ">" || src[j] === "|") j++;
      if (src[j] === "&") {
        // `>&2` / `>&-` duplicate an fd; bash's `>& file` means `&> file`.
        const dup = src.slice(j + 1).match(/^\s*(\d+|-)(?=[\s;&|)]|$)/);
        i = dup ? j + 1 + dup[0].length : j + 1;
        redirect = dup ? null : "write";
        continue;
      }
      if (src[j] === "(") {
        i = j; // process substitution: `>(cmd)` is a command, not a file
        redirect = null;
        continue;
      }
      i = j;
      redirect = "write";
    } else if (c === ";" || c === "|" || c === "&" || c === "(" || c === ")") {
      endCmd();
      i += (c === "|" || c === "&" || c === ";") && src[i + 1] === c ? 2 : 1;
    } else {
      const x = word();
      if (c === "*" || c === "?" || c === "[") x.glob = true;
      x.text += c;
      i++;
    }
  }
  endCmd();
  return cmds;
}

/** Wrappers that run their argument as a command, with the options that take a separate value. */
const WRAPPERS: Record<string, RegExp | null> = {
  sudo: /^-[ugCDhpRrTU]$/,
  doas: /^-[uC]$/,
  nice: /^-n$/,
  ionice: /^-[cnp]$/,
  timeout: /^-[sk]$/,
  env: /^-[uCS]$/,
  xargs: /^-[IdEsLnPa]$/,
  stdbuf: /^-[ioe]$/,
  chrt: null,
  taskset: null,
  command: null,
  exec: /^-a$/,
  time: /^-[fo]$/,
  nohup: null,
  builtin: null,
  busybox: null,
  then: null,
  do: null,
  else: null,
  "!": null,
  "{": null,
  npx: /^(-p|--package|-c|--call)$/,
  bunx: /^(-p|--package)$/,
  pnpx: null,
};

const cmdName = (w: ShWord | undefined) =>
  basename(toPosix(w?.text ?? ""))
    .toLowerCase()
    .replace(/@[^/]*$/, "")
    .replace(/\.(exe|cmd|ps1)$/, "");

/** The words of the command that actually runs: assignments, wrappers and `npx`/`python -m` peeled off. */
export function effectiveArgv(words: readonly ShWord[]): ShWord[] {
  let a = words.slice();
  for (let n = 0; n < 10 && a.length; n++) {
    while (a.length && (/^[A-Za-z_]\w*=/.test(a[0].text) || a[0].text === "{" || a[0].text === "}")) a.shift();
    const v = cmdName(a[0]);
    const two = `${v} ${a[1]?.text ?? ""}`;
    if (Object.hasOwn(WRAPPERS, v) || /^(npm exec|pnpm (dlx|exec)|yarn dlx)$/.test(two)) {
      const vals = WRAPPERS[v] ?? /^(-p|--package)$/;
      a = a.slice(Object.hasOwn(WRAPPERS, v) ? 1 : 2);
      while (a.length && a[0].text.startsWith("-") && a[0].text !== "-") {
        const opt = a.shift()!.text;
        if (opt === "--") break;
        if (vals.test(opt)) a.shift();
      }
      if (v === "env") while (a.length && /^[A-Za-z_]\w*=/.test(a[0].text)) a.shift();
      if (v === "timeout" && a.length) a.shift(); // the duration
      if ((v === "chrt" || v === "taskset" || v === "ionice") && a.length && /^[\d,x-]+$/.test(a[0].text)) a.shift();
      continue;
    }
    if (/^python[\d.]*$/.test(v) && a[1]?.text === "-m" && a.length > 2) {
      a = a.slice(2);
      continue;
    }
    break;
  }
  return a;
}

/** Per verb: options that take a separate value, and which positionals it writes. */
const WRITE_ARGS: Record<string, { vals: RegExp; writes: "all" | "last" | "notFirst" }> = {
  rm: { vals: /^$/, writes: "all" },
  rmdir: { vals: /^$/, writes: "all" },
  unlink: { vals: /^$/, writes: "all" },
  shred: { vals: /^-[ns]$/, writes: "all" },
  touch: { vals: /^-[dtr]$/, writes: "all" },
  mkdir: { vals: /^-m$/, writes: "all" },
  truncate: { vals: /^-[sr]$/, writes: "all" },
  tee: { vals: /^$/, writes: "all" },
  mv: { vals: /^-[tS]$/, writes: "all" },
  cp: { vals: /^-[tS]$/, writes: "last" },
  ln: { vals: /^-[tS]$/, writes: "last" },
  install: { vals: /^-[tSmog]$/, writes: "last" },
  rsync: { vals: /^-[eT]$/, writes: "last" },
  chmod: { vals: /^$/, writes: "notFirst" },
  chown: { vals: /^$/, writes: "notFirst" },
  chgrp: { vals: /^$/, writes: "notFirst" },
};

function splitArgs(args: readonly ShWord[], vals: RegExp): { pos: ShWord[]; opts: [string, ShWord | undefined][] } {
  const pos: ShWord[] = [];
  const opts: [string, ShWord | undefined][] = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    if (t === "--") {
      pos.push(...args.slice(i + 1));
      break;
    }
    if (t.startsWith("-") && t !== "-" && !args[i].dynamic) {
      const eq = t.indexOf("=");
      if (t.startsWith("--") && eq > 0) opts.push([t.slice(0, eq), { ...args[i], text: t.slice(eq + 1) }]);
      else if (vals.test(t)) opts.push([t, args[++i]]);
      else opts.push([t, undefined]);
    } else pos.push(args[i]);
  }
  return { pos, opts };
}

/** Paths a simple command writes through its arguments (redirections are in `ShCmd.writes`). */
export function writeTargets(argv: readonly ShWord[]): ShWord[] {
  const v = cmdName(argv[0]);
  const args = argv.slice(1);
  if (v === "dd") return args.filter((a) => a.text.startsWith("of=")).map((a) => ({ ...a, text: a.text.slice(3) }));
  if (v === "sed" || v === "perl") {
    const inPlace = args.some((a) => /^-(?!-)[a-zA-Z0-9]*i/.test(a.text) || /^--in-place/.test(a.text));
    if (!inPlace) return [];
    const { pos, opts } = splitArgs(args, v === "sed" ? /^-[efl]$/ : /^-[eE]$/);
    const scriptGiven = opts.some(([o]) => /^(-[a-zA-Z]*[efE]|--(expression|file))$/.test(o));
    return scriptGiven ? pos : pos.slice(1);
  }
  if (v === "chmod" || v === "chown" || v === "chgrp") {
    // `chmod -x file`: a mode may start with a dash, so peel off only the options chmod really has.
    const known = /^(--?(R|f|v|c|h|H|L|P|recursive|silent|quiet|verbose|changes|dereference|no-dereference|preserve-root|no-preserve-root)|--)$/;
    const rest = args.filter((a) => !known.test(a.text));
    return rest.some((a) => a.text.startsWith("--reference=")) ? rest.filter((a) => !a.text.startsWith("--reference=")) : rest.slice(1);
  }
  const spec = Object.hasOwn(WRITE_ARGS, v) ? WRITE_ARGS[v] : undefined;
  if (!spec) return [];
  const { pos, opts } = splitArgs(args, spec.vals);
  const out = opts.filter(([o]) => o === "-t" || o === "--target-directory").map(([, val]) => val ?? { text: "", dynamic: true, glob: false });
  if (v === "install" && opts.some(([o]) => /^-[a-zA-Z]*d/.test(o))) return [...out, ...pos];
  if (spec.writes === "all") out.push(...pos);
  else if (spec.writes === "notFirst") out.push(...pos.slice(1));
  else if (!out.length && pos.length) out.push(v === "ln" && pos.length === 1 ? { text: ".", dynamic: false, glob: false } : pos[pos.length - 1]);
  return out;
}

const GLOB_SEG = /[*?[]/;

function globRegExp(seg: string): RegExp {
  let re = "";
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else if (ch === "[") {
      const j = seg.indexOf("]", i + 2);
      if (j < 0) re += "\\[";
      else {
        re += `[${seg.slice(i + 1, j).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = j;
      }
    } else re += ch.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, CASE_INSENSITIVE_FS ? "i" : "");
}

/** What the shell would expand an absolute glob to right now (dotfiles only when the segment starts with a dot). */
function expandGlob(abs: string, limit = 2000): string[] {
  const { root } = parsePath(abs);
  let dirs = [root];
  for (const seg of abs.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    if (!GLOB_SEG.test(seg)) {
      dirs = dirs.map((d) => join(d, seg));
      continue;
    }
    const re = globRegExp(seg);
    const next: string[] = [];
    for (const d of dirs) {
      let names: string[] = [];
      try {
        names = readdirSync(d);
      } catch {
        continue;
      }
      for (const n of names) if ((seg.startsWith(".") || !n.startsWith(".")) && re.test(n) && next.length < limit) next.push(join(d, n));
    }
    dirs = next;
  }
  return dirs;
}

/** Could a glob target match `..` or something we can't see? (`.*` does on older shells.) */
const globMayEscape = (p: string) => toPosix(p).split("/").some((seg) => GLOB_SEG.test(seg) && /^[.[]/.test(seg));

/** Could a glob target expand into a protected pattern's literal leading directories? (`c*` vs `config/`) */
function globHitsProtected(relGlob: string, patterns: readonly string[]): string | null {
  const t = relGlob.split("/").filter(Boolean);
  for (const p of patterns) {
    const lit: string[] = [];
    for (const seg of toPosix(p).replace(/^\.\//, "").split("/").filter(Boolean)) {
      if (GLOB_SEG.test(seg)) break;
      lit.push(seg);
    }
    if (lit.length && t.length >= lit.length && lit.every((seg, i) => globRegExp(t[i]).test(seg))) return p;
  }
  return null;
}

const DEVICE = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;

// ---------------------------------------------------------------------------
// The CLI twins of agent-flow's own mutating tools
// ---------------------------------------------------------------------------

const CLI_COMMANDS = new Set(["doctor", "init", "audit-risk", "baseline", "classify", "check-staged", "state", "worktree", "scan", "install", "hook", "schema", "template", "report", "repair", "guard"]);

/**
 * May `role` run `agent-flow <argv…>`? Returns a block reason, or null if allowed.
 * `argv` is what follows the binary (process.argv.slice(2)). Applies the same
 * per-role allow list as the equivalent Pi tool, so a read-only role can't
 * mutate pipeline state through the CLI from a shell. No role → allowed.
 */
export function roleMayRunCli(role: Role | null, argv: readonly string[]): string | null {
  if (!role) return null;
  // Both the CLI's own parse (first two non-flag words, flags swallowing a value) and
  // a looser scan, so flag placement can't change which subcommand the guard sees.
  const pairs: [string, string | undefined][] = [];
  const strict: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (!a.includes("=") && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) i++;
    } else strict.push(a);
  }
  pairs.push([strict[0], strict[1]]);
  const loose = argv.filter((a) => !a.startsWith("-"));
  const at = loose.findIndex((a) => CLI_COMMANDS.has(a));
  if (at >= 0) pairs.push([loose[at], loose[at + 1]]);
  for (const [sub, act] of pairs) {
    const tool =
      sub === "state" && act === "update"
        ? "state_update"
        : sub === "baseline" && act === "accept"
          ? "risk_baseline_update"
          : sub === "repair"
            ? "stale_repair"
            : sub === "init"
              ? "bootstrap_write"
            : sub === "worktree" && (act === "create" || act === "remove")
              ? `worktree_${act}`
              : null;
    if (tool && !ROLE_TOOL_ALLOW[role].has(tool)) return `role "${role}" may not run \`agent-flow ${sub}${tool === "stale_repair" || tool === "bootstrap_write" ? "" : ` ${act}`}\` (the CLI twin of ${tool}).`;
    if (sub === "install" || (sub === "hook" && act === "install")) {
      return `role "${role}" may not run \`agent-flow ${sub === "hook" ? "hook install" : "install"}\` — it rewrites agent/hook configuration; a human runs setup.`;
    }
  }
  return null;
}

/** `agent-flow …`, `npx @drix10/agent-flow …`, `node …/bin/agent-flow.js …` → the CLI's argv, else null. */
function agentFlowArgv(argv: readonly ShWord[]): string[] | null {
  const v = cmdName(argv[0]);
  const isCli = (w: ShWord | undefined) => /^agent-flow(\.[cm]?js)?$/.test(cmdName(w));
  if (isCli(argv[0])) return argv.slice(1).map((w) => w.text);
  if (/^(node|nodejs|bun|deno|tsx|ts-node)$/.test(v)) {
    let i = 1;
    while (i < argv.length && argv[i].text.startsWith("-")) i += /^(-r|--require|--import|--loader|-C|--conditions)$/.test(argv[i].text) ? 2 : 1;
    if (v === "deno" && argv[i]?.text === "run") i++;
    if (isCli(argv[i])) return argv.slice(i + 1).map((w) => w.text);
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
    return { abs, rel: toPosix(r), outside: escapesBase(r) };
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
    const wiring = protectedPaths.length && !g.allowProtected ? underAny(v.rel, GUARD_WIRING) : null;
    if (wiring) return block("guard-wiring", `${v.rel} is what runs the guard (${wiring}); editing it would let an agent switch its own protection off. A human changes it.`);
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

/**
 * Hook-skipping, force-push, remote deletes and pushes to the default branch.
 * Never legitimate for an AI agent, and the guard only sees agent tool calls,
 * so this applies to every session — role or not.
 */
function decideGit(gc: GitCall, protectedBranches: Set<string>): GuardDecision | null {
  if (gc.configs.some((c) => /^core\.hookspath=/i.test(c)) || (gc.sub === "config" && /\bcore\.hookspath\b/i.test(gc.args) && !/(^|\s)(--get\S*|--list|-l|--show-\S+)(\s|$)/.test(gc.args))) {
    return block("no-verify", "changing core.hooksPath disables the pre-commit hook. Fix the hook failure instead.");
  }
  // `-n` is --no-verify only for commit (for push it's --dry-run, which is harmless).
  const skipsHook = hasLong(gc.args, "--no-verify", 6) || (gc.sub === "commit" && hasFlag(gc.args, "n", []));
  if (["commit", "merge", "rebase", "am", "cherry-pick", "revert", "push"].includes(gc.sub) && skipsHook) {
    return block("no-verify", "`--no-verify` skips the pre-commit hook. Fix the hook failure instead.");
  }
  if (gc.sub !== "push" && gc.sub !== "fetch" && gc.sub !== "update-ref" && gc.sub !== "replace") return null;
  if (gc.sub === "fetch") {
    // A refspec (`main:main`, `+HEAD:main`) rewrites LOCAL refs — including the
    // default branch — while looking like a read. Plain fetches only move
    // remote-tracking refs, so they stay allowed. URLs hold colons too, so
    // they (and flag words) are excluded before looking for a refspec.
    const toks = gc.args.split(/\s+/).filter((t) => t && !t.startsWith("-") && !/^[a-z][a-z0-9+.-]*:\/\//i.test(t));
    if (toks.slice(1).some((t) => t.includes(":"))) {
      return block("fetch-refspec", "fetch with a <src>:<dst> refspec rewrites local branches — fetch the remote (or a branch name) without a refspec instead.");
    }
    return null;
  }
  // Plumbing with no legitimate agent use: direct ref writes, and object
  // replacement that changes what every branch (including the default one) shows.
  if (gc.sub === "update-ref") {
    return block("ref-rewrite", "git update-ref rewrites refs directly, bypassing every branch protection here. There is no agent workflow that needs it.");
  }
  if (gc.sub === "replace") {
    // Bare or list-only (`-l`, `--format=…`) reads; anything else names objects to swap.
    const rest = gc.args.replace(/--format([= ]\S+)?/g, " ").replace(/-l\b|--list\b/g, " ").trim();
    if (rest) {
      return block("ref-rewrite", "git replace swaps commits repo-wide, changing what the default branch shows. There is no agent workflow that needs it.");
    }
    return null;
  }
  if (gc.sub !== "push") return null;
  const a = gc.args;
  const forced =
    hasFlag(a, "f", []) ||
    /(^|\s)-[a-zA-Z]*d[a-zA-Z]*(\s|$)/.test(a) ||
    /(^|\s)\+\S/.test(a) ||
    ["--force", "--force-with-lease", "--force-if-includes"].some((n) => hasLong(a, n, 5)) ||
    hasLong(a, "--mirror", 4) ||
    hasLong(a, "--delete", 4) ||
    hasLong(a, "--prune", 5);
  if (forced) return block("force-push", "force-push / delete rewrites shared history. Push a new commit instead.");
  if (hasLong(a, "--all", 4)) return block("push-default-branch", "`push --all` pushes the default branch too — push agent/issue-N only.");
  // No refspec: git pushes the current branch, which may be the default one.
  // (`--dry-run`/`-n` and tag-only pushes transfer no branch, so they stay allowed;
  // git itself rejects `--dry-run=<value>`, so a prefix match can't hide a real push.)
  const refspecs = a
    .replace(/(^|\s)(-o|--push-option|--repo|--receive-pack|--exec)(=|\s+)\S+/g, " ")
    .split(/\s+/)
    .filter((t) => t && !t.startsWith("-"))
    .slice(1); // first positional is the remote
  if (!refspecs.length && !hasLong(a, "--dry-run", 5) && !hasFlag(a, "n", []) && !hasLong(a, "--tags", 4)) {
    return block("explicit-refspec", "push without a refspec pushes the current branch — name it explicitly (e.g. `git push origin agent/issue-N`).");
  }
  for (const spec of refspecs) {
    const s = spec.replace(/^\+/, "");
    const dest = (s.includes(":") ? s.slice(s.lastIndexOf(":") + 1) : s).replace(/^refs\/heads\//, "");
    // `:` alone pushes every matching branch, the default one included.
    if (protectedBranches.has(dest) || s === ":") return block("push-default-branch", "agents never push to the default branch — push agent/issue-N and open a PR.");
    // An empty source (`:branch`) deletes the remote branch.
    if (s.startsWith(":")) return block("force-push", `\`git push <remote> ${spec}\` deletes the remote branch. Push a new commit instead.`);
  }
  return null;
}

/** `~`, `~/x`, absolute and cwd-relative paths; null when the shell's answer isn't knowable here. */
function resolveShellPath(cwd: string | null, p: string): string | null {
  if (p === "~" || p.startsWith("~/")) return join(homedir(), p.slice(1));
  if (p.startsWith("~")) return null;
  if (isAbsolute(p)) return resolve(p);
  return cwd === null ? null : resolve(cwd, p);
}

/** Every path a command line writes, with the cwd in effect for it (`cd X && …` is followed; `sh -c '…'` is entered). */
const DESTRUCTIVE_VERBS = new Set(["rm", "rmdir", "unlink", "shred", "mv"]);

/** `a/{b,c}/d` → the words the shell would make, when the only reason it's "dynamic" is a plain comma list. */
function braceVariants(w: ShWord, limit = 64): ShWord[] {
  if (!w.dynamic || /[$`]/.test(w.text) || !/\{[^{}]*,[^{}]*\}/.test(w.text)) return [w];
  let texts = [w.text];
  for (let guard = 0; guard < 8 && texts.some((t) => /\{[^{}]*,[^{}]*\}/.test(t)); guard++) {
    const next: string[] = [];
    for (const t of texts) {
      const m = t.match(/\{([^{}]*,[^{}]*)\}/);
      if (!m) next.push(t);
      else for (const alt of m[1].split(",")) next.push(t.slice(0, m.index) + alt + t.slice(m.index! + m[0].length));
      if (next.length > limit) return [w];
    }
    texts = next;
  }
  return texts.some((t) => /[{}]/.test(t)) ? [w] : texts.map((text) => ({ ...w, text, dynamic: false }));
}

/** Where `find` would delete: its start points, when the expression removes files. */
function findDeleteRoots(argv: readonly ShWord[]): ShWord[] {
  const args = argv.slice(1);
  const expr = args.findIndex((a) => /^(-|!|\()/.test(a.text) && a.text !== "-");
  const roots = expr < 0 ? args : args.slice(0, expr);
  const tail = args.slice(expr < 0 ? args.length : expr).map((a) => a.text);
  const removes = tail.includes("-delete") || tail.some((t, i) => /^-(exec|execdir|ok|okdir)$/.test(t) && /^(rm|rmdir|unlink|shred|mv)$/.test(cmdName({ text: tail[i + 1] ?? "", dynamic: false, glob: false })));
  if (!removes) return [];
  return roots.length ? [...roots] : [{ text: ".", dynamic: false, glob: false }];
}

/** Archive extraction targets that name a directory explicitly: `tar -xf a.tgz -C dir`, `unzip a.zip -d dir`. */
function extractRoots(v: string, argv: readonly ShWord[]): ShWord[] {
  const args = argv.slice(1);
  const at = (flag: RegExp) => args.findIndex((a) => flag.test(a.text));
  if (v === "tar" || v === "bsdtar") {
    const extracting = args.some((a) => /^(-[a-zA-Z]*x[a-zA-Z]*|--extract|--get|x[a-zA-Z]*)$/.test(a.text));
    const i = at(/^(-C|--directory)$/);
    if (extracting && i >= 0 && args[i + 1]) return [args[i + 1]];
    const eq = args.find((a) => a.text.startsWith("--directory="));
    return extracting && eq ? [{ ...eq, text: eq.text.slice("--directory=".length) }] : [];
  }
  if (v === "unzip") {
    const i = at(/^-d$/);
    return i >= 0 && args[i + 1] ? [args[i + 1]] : [];
  }
  return [];
}

type ShellWrite = { word: ShWord; cwd: string | null; destructive?: boolean };

function shellWrites(src: string, cwd: string | null, depth = 0): ShellWrite[] {
  const out: ShellWrite[] = [];
  for (const sc of lexShell(src)) {
    for (const w of sc.writes) for (const x of braceVariants(w)) out.push({ word: x, cwd });
    const argv = effectiveArgv(sc.words);
    const v = cmdName(argv[0]);
    if (v === "cd" || v === "pushd" || v === "chdir" || v === "set-location" || v === "sl") {
      const t = argv.slice(1).find((x) => !/^-[LPe@]+$/.test(x.text));
      cwd = !t ? homedir() : t.dynamic || t.glob || t.text === "-" ? null : resolveShellPath(cwd, t.text);
      continue;
    }
    if (v === "popd") {
      cwd = null;
      continue;
    }
    if (/^((ba|z|da|k)?sh|eval)$/.test(v) && depth < 3) {
      const ci = argv.findIndex((x) => /^-[a-zA-Z]*c$/.test(x.text));
      const script = v === "eval" ? argv.slice(1) : ci > 0 && argv[ci + 1] ? [argv[ci + 1]] : [];
      if (!script.some((x) => x.dynamic)) out.push(...shellWrites(script.map((x) => x.text).join(" "), cwd, depth + 1));
    }
    const destructive = DESTRUCTIVE_VERBS.has(v);
    for (const w of writeTargets(argv)) for (const x of braceVariants(w)) out.push({ word: x, cwd, destructive });
    if (v === "find") for (const w of findDeleteRoots(argv)) for (const x of braceVariants(w)) out.push({ word: x, cwd, destructive: true });
    for (const w of extractRoots(v, argv)) for (const x of braceVariants(w)) out.push({ word: x, cwd });
  }
  return out;
}

/** Repo-relative views of an absolute path: lexical, through symlinks, and inside its worktree. */
function shellRels(g: GuardInput, p: string): string[] {
  const rels = new Set<string>();
  const add = (base: string, abs: string) => {
    const r = relative(base, abs);
    if (r && !escapesBase(r)) rels.add(toPosix(r));
  };
  const landing = landingPath(p);
  add(g.root, p);
  add(landingPath(g.root), landing);
  if (g.worktree) {
    add(g.worktree, p);
    add(landingPath(g.worktree), landing);
  }
  for (const r of [...rels]) {
    const m = r.match(/^\.worktrees\/[^/]+\/(.+)$/);
    if (m) rels.add(m[1]);
  }
  return [...rels];
}

/**
 * Does removing or moving directory `rel` take a protected path with it? Checked lexically (a protected
 * pattern that lives under `rel`, even if nothing exists there yet) and against the files actually inside.
 */
function protectedInside(g: GuardInput, abs: string, rel: string, protectedPaths: readonly string[]): string | null {
  const here = fold(rel).replace(/\/+$/, "");
  const root = rel === "" || rel === ".";
  for (const p of protectedPaths) {
    const lit: string[] = [];
    for (const seg of toPosix(p).replace(/^\.\//, "").replace(/^\/+/, "").split("/").filter(Boolean)) {
      if (GLOB_SEG.test(seg)) break;
      lit.push(seg);
    }
    const litPath = fold(lit.join("/"));
    if (root || (litPath && litPath.startsWith(`${here}/`))) return p;
  }
  const dirAbs = abs;
  try {
    const walked = walk(dirAbs, { maxFiles: g.walkLimit ?? 20_000 });
    // Too big to check: assume the protected path is in there rather than let `rm -rf` through.
    if (walked.truncated && protectedPaths.length) return protectedPaths[0];
    const files = walked.files;
    const base = toPosix(rel).replace(/\/+$/, "");
    for (const f of files) {
      const hit = matchAny(protectedPaths, base ? `${base}/${f}` : f);
      if (hit) return hit;
    }
  } catch {
    /* not a directory, or unreadable: nothing inside to protect */
  }
  return null;
}

/** git subcommands that rewrite the working tree wholesale, judged against the manifest's protected paths. */
function decideGitBulk(g: GuardInput, gc: GitCall, protectedPaths: string[]): GuardDecision | null {
  if (!protectedPaths.length || g.allowProtected) return null;
  const why = (what: string) =>
    block("bulk-git-protected", `\`git ${gc.sub}\` ${what}, which can overwrite or delete protected paths (${protectedPaths.slice(0, 3).join(", ")}${protectedPaths.length > 3 ? ", …" : ""}). Name the files you mean, or escalate to Needs Me.`);
  const a = gc.args.trim();
  const toks = a.split(/\s+/).filter(Boolean);
  const positional = toks.filter((t) => !t.startsWith("-") || t === "-");
  // A pathspec that is the whole tree, sits above a protected path, or is one.
  const runsIn = gc.dir ? resolve(g.cwd, gc.dir) : g.cwd;
  const bulkSpec = (spec: string): boolean => {
    if (spec === "." || spec === "./" || spec === ":/" || spec === ":" || /^:\(/.test(spec) || spec === "*") return true;
    const abs = resolve(runsIn, spec.replace(/^:\/?/, ""));
    const rel = toPosix(relative(g.root, abs));
    if (escapesBase(rel)) return false;
    return !!matchAny(protectedPaths, rel) || !!protectedInside(g, abs, rel, protectedPaths);
  };
  const specsAfterDashDash = () => {
    const i = toks.indexOf("--");
    return i >= 0 ? toks.slice(i + 1) : [];
  };
  switch (gc.sub) {
    case "reset":
      return hasLong(a, "--hard", 3) || hasLong(a, "--merge", 3) ? why("--hard/--merge discards working-tree changes to every file") : null;
    case "clean":
      return (hasFlag(a, "f", ["--force"]) && !hasFlag(a, "n", ["--dry-run"])) ? why("deletes untracked files") : null;
    case "stash":
      return /^(list|show)\b/.test(a) ? null : why("stashes (reverts) every tracked change");
    case "checkout":
    case "switch":
      if (hasFlag(a, "f", ["--force", "--discard-changes"]) && gc.sub === "switch") return why("--discard-changes overwrites local changes");
      if (gc.sub === "checkout" && hasFlag(a, "f", ["--force"])) return why("--force overwrites local changes");
      if (gc.sub === "checkout") {
        const specs = toks.includes("--") ? specsAfterDashDash() : positional.filter((t) => t === "." || t === ":/");
        if (specs.some(bulkSpec)) return why("restores paths from the index or another commit");
      }
      return null;
    case "restore": {
      const stagedOnly = /(^|\s)(--staged|-S)(\s|$)/.test(a) && !/(^|\s)(--worktree|-W)(\s|$)/.test(a);
      if (stagedOnly) return null;
      const specs = toks.includes("--") ? specsAfterDashDash() : positional;
      return specs.some(bulkSpec) ? why("restores paths from the index or another commit") : null;
    }
    case "rm":
    case "mv": {
      const specs = toks.includes("--") ? specsAfterDashDash() : positional;
      return specs.some(bulkSpec) ? why("removes or renames tracked paths") : null;
    }
    default:
      return null;
  }
}

/** Commands that name a file without reading its contents. */
const NAME_ONLY_VERBS = new Set(["ls", "dir", "stat", "test", "[", "[[", "cd", "pushd", "echo", "printf", "which", "dirname", "basename", "realpath", "readlink", "file", "mkdir", "touch", "rm", "rmdir", "unlink", "chmod", "chown", "chgrp", "find", "wslpath", "true", "false"]);
const READ_TOOL = /^(read|notebook_?read|view|read_file|read_many_files|grep|search_file_content|glob|cat|open_file)$/;

/** The deny-read pattern (or "env file") that a repo-relative path falls under, or null. */
function deniedRead(g: GuardInput, abs: string): string | null {
  const deny = denyReadPathsOf(g.manifest);
  for (const rel of shellRels(g, abs)) {
    if (isEnvFile(rel)) return "environment file";
    const hit = matchAny(deny, rel);
    if (hit) return hit;
  }
  return null;
}

function secretReadBlock(what: string, why: string): GuardDecision {
  return block("secret-read", `${what} reads ${why}. Real credentials stay out of agent context: use the variable name, ask a human, or (human only) launch with AGENT_FLOW_ALLOW_SECRET_READ=1.`);
}

/** Shell: any command that names an env file (or a manifest deny_read path) as an argument or `<` input. */
function decideSecretRead(g: GuardInput, cmd: string): GuardDecision | null {
  if (g.allowSecretRead) return null;
  for (const sc of lexShell(cmd)) {
    const argv = effectiveArgv(sc.words);
    const verb = cmdName(argv[0]);
    const words: ShWord[] = [...sc.reads];
    if (verb === "git") {
      // `git add .env` names a file without showing it; `git show HEAD:.env`, `git diff .env` and friends print it.
      const gc = parseGit(argv.map((w) => w.text).join(" "));
      const reads = !!gc && /^(show|diff|log|blame|annotate|cat-file|grep|archive|difftool|show-branch|whatchanged|format-patch)$/.test(gc.sub);
      for (const w of argv.slice(1)) if (!w.dynamic && (reads || w.text.includes(":"))) words.push(w);
    } else if (!NAME_ONLY_VERBS.has(verb)) {
      // The first operand of a search or edit command is its pattern or script, not a file: `grep ".env" src`.
      let patternPending = PATTERN_VERBS.has(verb) && verb !== "perl" && !argv.slice(1).some((w) => /^(-[a-zA-Z]*[ef]|--(regexp|expression|file))/.test(w.text));
      for (const w of argv.slice(1)) {
        if (patternPending && !w.text.startsWith("-")) {
          patternPending = false;
          continue;
        }
        // `--env-file=.env` reads it as surely as `cat .env` does.
        const value = w.text.startsWith("--") && w.text.includes("=") ? { ...w, text: w.text.slice(w.text.indexOf("=") + 1) } : w;
        if (!value.dynamic && (!value.text.startsWith("-") || value === w)) words.push(value);
      }
    }
    for (const w of words) {
      if (w.dynamic || !w.text) continue;
      // `curl -F f=@.env`, `git show HEAD:.env`, `--post-file=.env`: the path can sit after `=`, `@` or `:`.
      const forms = new Set([w.text, w.text.slice(w.text.lastIndexOf("=") + 1), w.text.slice(w.text.lastIndexOf("@") + 1), w.text.slice(w.text.lastIndexOf(":") + 1)]);
      for (const form of forms) {
        if (!form || (form.startsWith("-") && form.length > 1 && !form.includes("/"))) continue;
        const abs = resolveShellPath(g.cwd, form);
        const hit = abs && deniedRead(g, abs);
        if (hit) return secretReadBlock(`\`${verb || "command"}\``, `${w.text} (${hit})`);
      }
    }
  }
  return null;
}

function decideShellTarget(g: GuardInput, t: ShellWrite, protectedPaths: string[], ctxFiles: string[]): GuardDecision | null {
  const { role } = g;
  const w = t.word;
  const confined = role === "implementer" && !!g.worktree;
  const wtShown = g.worktree ? toPosix(relative(g.root, g.worktree)) || g.worktree : "";
  if (DEVICE.test(w.text)) return null;
  const abs = w.dynamic ? null : resolveShellPath(t.cwd, w.text);
  if (!abs) {
    return confined ? block("worktree-confinement", `can't tell where \`${w.text || "(empty)"}\` points (a variable, substitution or unknown cwd), so it can't be confined to ${wtShown}. Write to a literal path inside the worktree.`) : null;
  }
  if (confined && w.glob && globMayEscape(w.text)) return block("worktree-confinement", `the glob \`${w.text}\` could match \`..\`; name the files explicitly.`);
  const hits = w.glob ? expandGlob(abs) : [];
  for (const p of hits.length ? hits : [abs]) {
    if (DEVICE.test(toPosix(p))) continue;
    if (confined) {
      const landing = landingPath(p);
      if (!within(g.worktree!, p) || !within(landingPath(g.worktree!), landing)) {
        return block("worktree-confinement", `implementer is confined to ${wtShown}; the command writes ${toPosix(p)}${landing !== p ? ` (resolves to ${toPosix(landing)})` : ""}.`);
      }
    }
    // `rm -rf .` (or a parent of the repo): everything protected goes with it.
    if (t.destructive && !g.allowProtected && protectedPaths.length && !escapesBase(toPosix(relative(landingPath(p), landingPath(g.root))))) {
      return block("protected-path", `command removes or moves ${toPosix(p)}, which contains the whole repository including protected paths (${MANIFEST_FILE}). Escalate to Needs Me instead.`);
    }
    for (const rel of shellRels(g, p)) {
      // Git internals stay writable for a plain session (`.git/info/exclude`), but its hooks never are:
      // deleting or `chmod -x`-ing the pre-commit hook silently turns the commit gate off.
      const tamper = underAny(rel, TAMPER_PROOF);
      if (tamper && (role || tamper !== ".git/" || t.destructive || /^\.git\/hooks(\/|$)/i.test(rel))) {
        return block("tamper-proof", `command writes ${rel}, which only agent-flow tools may change.`);
      }
      const wiring = protectedPaths.length && !g.allowProtected ? underAny(rel, GUARD_WIRING) : null;
      if (wiring) return block("guard-wiring", `command writes ${rel}, which is what runs the guard (${wiring}); a human changes it.`);
      const cfg = role && role !== "orchestrator" ? underAny(rel, AGENT_CONFIG) : null;
      if (cfg) return block("agent-config", `command writes ${rel}, agent/CI configuration (${cfg}). Escalate to a human.`);
      if (!g.allowProtected) {
        const prot = matchAny(protectedPaths, rel) ?? (GLOB_SEG.test(rel) ? globHitsProtected(rel, protectedPaths) : null);
        if (prot) return block("protected-path", `command writes ${rel}, which is protected (${prot} in ${MANIFEST_FILE}). Escalate to Needs Me instead.`);
        if (t.destructive && rel === MANIFEST_FILE) return block("manifest-integrity", `${MANIFEST_FILE} holds the protected paths; deleting or moving it switches protection off. A human does that.`);
        // `rm -rf research` / `mv research /tmp` removes what is protected inside it.
        const inside = t.destructive ? protectedInside(g, p, rel, protectedPaths) : null;
        if (inside) return block("protected-path", `command removes or moves ${rel}, which contains protected path ${inside} (${MANIFEST_FILE}). Escalate to Needs Me instead.`);
      }
      if (role === "implementer" && ctxFiles.some((f) => fold(f) === fold(rel))) return block("context-file", `command writes context file ${rel} — only the Gardener edits context.`);
    }
  }
  return null;
}

/** The specific rules first (they name the exact path or role); whole-tree git rewrites are the catch-all. */
function decideShell(g: GuardInput, cmd: string, protectedPaths: string[], ctxFiles: string[], top = true): GuardDecision | null {
  const specific = decideShellCore(g, cmd, protectedPaths, ctxFiles, top);
  if (specific) return specific;
  for (const seg of segments(stripQuoted(unquoteBareWords(cmd)))) {
    const gc = parseGit(seg);
    const d = gc && decideGitBulk(g, gc, protectedPaths);
    if (d) return d;
  }
  return null;
}

function decideShellCore(g: GuardInput, cmd: string, protectedPaths: string[], ctxFiles: string[], top = true): GuardDecision | null {
  const { role, manifest } = g;
  cmd = unquoteBareWords(cmd);
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

  // Every session, role or not. Checked on the raw text too: quoting the value
  // (`-c "core.hooksPath=…"`) must not hide it.
  if (/\bgit\b/i.test(cmd) && /\bcore\.hookspath\b/i.test(cmd) && !/\bconfig\s+(--get\S*|--list|-l|--show-\S+)\s/i.test(cmd)) {
    return block("no-verify", "changing core.hooksPath disables the pre-commit hook. Fix the hook failure instead.");
  }
  const defaultBranch = manifest?.default_branch;
  const protectedBranches = new Set(["main", "master", ...(typeof defaultBranch === "string" && defaultBranch ? [defaultBranch] : [])]);
  for (const seg of segs) {
    const gc = parseGit(seg);
    const d = gc && decideGit(gc, protectedBranches);
    if (d) return d;
  }

  const secret = decideSecretRead(g, cmd);
  if (secret) return secret;

  // `agent-flow state update …` from a shell is the same act as the state_update tool.
  if (role) {
    for (const sc of lexShell(cmd)) {
      const cli = agentFlowArgv(effectiveArgv(sc.words));
      const why = cli && roleMayRunCli(role, cli);
      if (why) return block("role-tool", why);
    }
  }

  if (role && READ_ONLY_ROLES.includes(role) && SNAPSHOT_OR_FIX.test(` ${pathWords(cmd)} `)) {
    return block("qa-no-autofix", "snapshot updates / --fix / --write change the code under test. Report the failure verbatim instead.");
  }

  const finding = analyzeShell(cmd);
  // Only the outermost command: `sh -c '…'` bodies are entered with the right cwd from here.
  const writes = top ? shellWrites(cmd, g.cwd).filter((t) => !DEVICE.test(t.word.text)) : [];
  if (!finding.mutating && !writes.length) return null;

  if (role && READ_ONLY_ROLES.includes(role)) {
    // QA may install locked deps to run tests; nothing else that writes.
    const onlyCleanInstall = role === "qa" && !writes.length && !hasRedirectWrite(cmd) && segs.every((s) => CLEAN_INSTALL.test(s) || !analyzeShell(s).mutating);
    if (onlyCleanInstall) return null;
    const why = finding.why.length ? finding.why : ["writes a file"];
    return block("read-only-role", `role "${role}" is read-only; command looks mutating (${why.join("; ")}). If this is a false positive, rephrase as a read-only command.`);
  }
  for (const t of writes) {
    const d = decideShellTarget(g, t, protectedPaths, ctxFiles);
    if (d) return d;
  }
  // Every write was resolved to a real path and checked above; the text scan below
  // is only for what couldn't be (`git rm`, formatters, variables…). Without this,
  // `ls migrations/ > list.txt` is "a mutating command that mentions migrations/".
  const fullyResolved =
    writes.length > 0 && writes.every((t) => !t.word.dynamic && resolveShellPath(t.cwd, t.word.text)) && finding.why.every(resolvedWhy);
  if (!finding.mutating || fullyResolved) return null;
  const hay = pathWords(cmd);
  const tamper = mentions(hay, TAMPER_PROOF);
  if (tamper && role) return block("tamper-proof", `command writes near ${tamper}, which only agent-flow tools may change.`);
  // Not for the orchestrator: its launch prompts legitimately name `.claude/agents/…`.
  if (role && role !== "orchestrator") {
    const cfg = mentions(hay, AGENT_CONFIG);
    if (cfg) return block("agent-config", `mutating command references agent/CI configuration (${cfg}). Escalate to a human.`);
  }
  const prot = mentions(hay, protectedPaths);
  if (prot && !g.allowProtected) return block("protected-path", `mutating command references protected path ${prot}. Escalate to Needs Me instead.`);
  if (role === "implementer") {
    const ctx = mentions(hay, ctxFiles.filter((f) => f.length >= 3));
    if (ctx) return block("context-file", `mutating command references context file ${ctx} — only the Gardener edits context.`);
  }
  return null;
}

// ---------------------------------------------------------------------------

export function decide(g: GuardInput): GuardDecision | null {
  const d = decideKnown(g);
  if (d || !g.manifestError) return d;
  const { toolName, input } = g;
  const words = toolWords(toolName);
  const tool = toolName.toLowerCase();
  const cmd = [input.command, input.cmd, input.script].find((c): c is string => typeof c === "string" && c.length > 0);
  const isShell = tool === "bash" || tool === "powershell" || tool === "shell" || words === "run_shell_command" || words === "exec_command";
  const isFileWrite = !HARMLESS.has(words) && (FILE_WRITE_TOOLS.has(tool) || (!AGENT_FLOW_MUTATORS.has(tool) && MUTATING_CUSTOM.test(words)));
  let writes = false;
  if (isShell && cmd) writes = expandCommand(cmd).some((c) => analyzeShell(c).mutating || shellWrites(c, g.cwd).some((t) => !DEVICE.test(t.word.text)));
  else if (isFileWrite) {
    const paths = targetPaths(input, /patch|diff/.test(words));
    // Fixing the manifest itself is how you get out of this state.
    writes = !(paths.length > 0 && paths.every((p) => basename(toPosix(p)) === MANIFEST_FILE));
  }
  if (!writes) return null;
  return block("manifest-unreadable", `${MANIFEST_FILE} can't be loaded (${g.manifestError}), so protected paths are unknown and writes are refused. Fix the manifest first (\`agent-flow doctor\` shows the problem).`);
}

function decideKnown(g: GuardInput): GuardDecision | null {
  const { role, toolName, input } = g;
  const tool = toolName.toLowerCase();
  const words = toolWords(toolName);
  const protectedPaths = protectedPathsOf(g.manifest);
  const ctxFiles = contextFilePaths(g.manifest);

  // ---- agent-flow's own mutating tools: per-role allow list -------------------
  if (AGENT_FLOW_MUTATORS.has(tool) && role && !ROLE_TOOL_ALLOW[role].has(tool)) {
    return block("role-tool", `role "${role}" may not call ${tool}.`);
  }

  // ---- shell tools ----------------------------------------------------------------
  if (tool === "bash" || tool === "powershell" || tool === "shell" || words === "run_shell_command" || words === "exec_command") {
    const cmd = [input.command, input.cmd, input.script].find((c): c is string => typeof c === "string" && c.length > 0) ?? (Array.isArray(input.command) ? input.command.join(" ") : "");
    if (!cmd) return null;
    for (const [i, c] of expandCommand(cmd).entries()) {
      const d = decideShell(g, c, protectedPaths, ctxFiles, i === 0);
      if (d) return d;
    }
    return null;
  }

  // ---- git-host MCP tools: the remote API is a push too -------------------------------
  const remoteWrite = /(^|_)(push_files|create_or_update_file|delete_file)$/.test(words);
  if (remoteWrite || /(^|_)merge_pull_request$/.test(words)) {
    const man = g.manifest?.default_branch;
    const defaults = new Set(["main", "master", ...(typeof man === "string" && man ? [man] : [])]);
    if (remoteWrite) {
      const branch = typeof input.branch === "string" ? input.branch.replace(/^refs\/heads\//, "") : "";
      if (!branch || defaults.has(branch)) {
        return block("push-default-branch", `${toolName} ${branch ? `writes to ${branch}` : "names no branch, so it writes to the default branch"} through the remote API. Push agent/issue-N and open a PR.`);
      }
    } else if (role && role !== "orchestrator") {
      return block("role-tool", `role "${role}" may not merge pull requests (${toolName}).`);
    }
  }

  // ---- read tools: env files and deny_read paths ---------------------------------
  if (READ_TOOL.test(words) && !g.allowSecretRead) {
    const listed = Array.isArray(input.paths) ? input.paths.filter((p): p is string => typeof p === "string") : [];
    for (const p of [...targetPaths(input), ...listed]) {
      const hit = deniedRead(g, resolve(g.cwd, p));
      if (hit) return secretReadBlock(toolName, `${p} (${hit})`);
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
