/**
 * Stale-context detection and repair.
 *
 * Two independent signals:
 *  1. Manifest references — every path listed in CONTEXT_MANIFEST.json must
 *     still exist (exact case) and have been verified within the threshold.
 *  2. Prose references — every `backticked/path.ext` inside the context files
 *     themselves must still exist. The manifest can drift from the prose; the
 *     agent reads the prose. This is the check that catches "the agent edits a
 *     file that was renamed six months ago".
 */

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { IGNORED_DIRS, atomicWrite, existsExact, isoNow, readJson, readTextFile, toPosix, withLock } from "./fsutil.js";
import { listRepoFiles } from "./repofiles.js";
import { checkClaims } from "./claims.js";
import { detectJsonIndent, matchExistingFormat } from "./merge.js";
import { ContextManifest, DEFAULT_STALENESS_DAYS, ManifestContextFile, loadManifest, normalizeManifest } from "./manifest.js";

export interface MissingPath {
  file: string;
  path: string;
  source: "manifest" | "prose";
  /** A confident guess at where the path went (rename/move), or absent. */
  suggestion?: string;
}

export interface StaleReport {
  stale_files: string[];
  missing_context_files: string[];
  missing_paths: MissingPath[];
  invalid_timestamps: { file: string; path: string; value: unknown }[];
  unfilled_placeholders: { file: string; line: number; text: string }[];
  schema_problems: string[];
  dead_commands: { file: string; command: string; line?: number; reason?: string; suggestion?: string }[];
  broken_links: { file: string; line: number; target: string }[];
  unknown_commits: { file: string; line: number; sha: string }[];
  token_waste: { file: string; estimated_tokens: number }[];
  ctxlint: "not_requested" | "not_installed" | "ran" | "failed";
}

export type DetectResult =
  | {
      ok: true;
      healthy: boolean;
      report: StaleReport;
      /** Manifest path, or null when running on auto-discovered context files only. */
      manifest: string | null;
      legacy_schema: boolean;
      /** "discovered": no manifest (or one listing no context files) — prose checked on auto-discovered files. */
      mode: "manifest" | "discovered";
      context_files: string[];
    }
  | { ok: false; error: string; path: string };

/**
 * Context files agents load, by harness, root and nested. Personal files
 * (CLAUDE.local.md) are left out: they aren't shared, so their drift is the owner's.
 */
const CONTEXT_FILE_RE =
  /(^|\/)(AGENTS|CLAUDE|GEMINI)\.md$|^\.cursorrules$|^\.windsurfrules$|^\.github\/copilot-instructions\.md$|(^|\/)\.cursor\/rules\/[^/]+\.mdc$|(^|\/)\.windsurf\/rules\/[^/]+\.md$/;

export const isContextFile = (rel: string) => CONTEXT_FILE_RE.test(rel);

/** Every context file in the repo: root first, then by depth and name. */
export function discoverContextFiles(root: string, files: string[] = listRepoFiles(root, { maxFiles: 50_000, linkedFiles: true }).files): string[] {
  const depth = (p: string) => p.split("/").length;
  return files.filter(isContextFile).sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0));
}

export function editDistance(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** The single lowest-scoring candidate, or null on a tie (a guess we can't defend). */
function uniqueBest(cands: { path: string; score: number }[]): string | null {
  if (cands.length === 0) return null;
  cands.sort((a, b) => a.score - b.score);
  return cands.length === 1 || cands[0].score < cands[1].score ? cands[0].path : null;
}

/**
 * Where did a missing path probably go? Answers only when confident — a wrong
 * "did you mean" costs more trust than none. In order: a case-only change; the
 * same path under a new prefix; the same basename in exactly one place; a
 * renamed sibling (`service.ts` → `user-service.ts`); a small typo in the path.
 */
export function suggestPath(missing: string, files: string[]): string | null {
  const wantDir = missing.endsWith("/");
  const clean = missing.replace(/\/+$/, "");
  const dirs = new Set<string>();
  for (const f of files) for (let d = dirname(f); d !== "." && !dirs.has(d); d = dirname(d)) dirs.add(d);
  const pool = wantDir ? [...dirs] : extname(clean) ? files : [...files, ...dirs];
  const fmt = (p: string) => (wantDir ? `${p}/` : p);

  const lower = clean.toLowerCase();
  const caseOnly = pool.filter((p) => p.toLowerCase() === lower);
  if (caseOnly.length === 1) return fmt(caseOnly[0]);

  const moved = pool.filter((p) => p.endsWith(`/${clean}`));
  if (clean.includes("/") && moved.length === 1) return fmt(moved[0]);

  const base = basename(clean);
  const sameBase = pool.filter((p) => basename(p) === base);
  if (sameBase.length === 1) return fmt(sameBase[0]);

  const dir = dirname(clean);
  const ext = extname(base);
  const stem = base.slice(0, base.length - ext.length).toLowerCase();
  const limit = Math.max(2, Math.floor(stem.length / 3));
  const siblings: { path: string; score: number }[] = [];
  for (const p of pool) {
    if (dirname(p) !== dir) continue;
    const b = basename(p);
    if (extname(b) !== ext) continue;
    const s = b.slice(0, b.length - ext.length).toLowerCase();
    const d = editDistance(stem, s, limit);
    const contains = Math.min(stem.length, s.length) >= 3 && (s.includes(stem) || stem.includes(s));
    if (d <= limit || contains) siblings.push({ path: p, score: d });
  }
  const sib = uniqueBest(siblings);
  if (sib) return fmt(sib);

  const typos: { path: string; score: number }[] = [];
  for (const p of pool) {
    const d = editDistance(clean, p, 2);
    if (d <= 2) typos.push({ path: p, score: d });
  }
  const typo = uniqueBest(typos);
  return typo ? fmt(typo) : null;
}

const IGNORE_MARKER = "agent-flow:ignore-refs";

/**
 * Extract path-like tokens from `backticks`. Conservative on purpose: a
 * false "missing path" alarm trains people to ignore /doctor.
 */
export function extractProseRefs(markdown: string): { path: string; line: number }[] {
  const out: { path: string; line: number }[] = [];
  let inFence = false;
  markdown.split(/\r?\n/).forEach((line, idx) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence || line.includes(IGNORE_MARKER)) return;
    for (const m of line.matchAll(/`([^`\s]+)`(?![-‐](style|like|ish|esque)\b)/g)) {
      let tok = m[1].replace(/^\.\//, "").replace(/[),.;]+$/, "");
      tok = tok.replace(/(#L\d+(-L?\d+)?|:\d+(:\d+)?)$/, ""); // line anchors
      if (!tok.includes("/")) continue; // bare names are ambiguous — skip
      if (/^[a-z][a-z0-9+.-]*:/i.test(tok)) continue; // urls, node:fs, npm:pkg
      if (/[*?<>{}$=(\[|~^!]/.test(tok)) continue; // globs, placeholders, code
      if (tok.startsWith("@") || tok.startsWith("-") || tok.startsWith("/") || tok.startsWith("~")) continue;
      if (/^\.\.?\/?$/.test(tok) || tok.startsWith("../")) continue;
      if (!/^[\p{L}\p{N}_.\-/]+$/u.test(tok)) continue;
      const segs = tok.replace(/\/+$/, "").split("/");
      // `and/or`, `TCP/IP`, `client/server`: two dotless words are prose, not a path.
      if (segs.length === 2 && !tok.endsWith("/") && !segs.some((s) => s.includes("."))) continue;
      if (IGNORED_DIRS.has(segs[0])) continue; // build output and deps: absent on a fresh checkout by design
      if (/^\d+(\.\d+)*\/\d/.test(tok)) continue; // ratios, versions
      if (/[-_.][A-Z]$|\/[A-Z]$/.test(tok)) continue; // placeholders: `agent/issue-N`, `packages/X`
      out.push({ path: tok, line: idx + 1 });
    }
  });
  return out;
}

function findPlaceholders(file: string, content: string) {
  const out: { file: string; line: number; text: string }[] = [];
  content.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(/\{\{[A-Z0-9_]+\}\}/g)) out.push({ file, line: i + 1, text: m[0] });
  });
  return out;
}

function runLocalCtxlint(root: string, report: StaleReport): void {
  // NEVER `npx ctxlint`: when the package is absent npx downloads and executes
  // whatever is published under that name. Only a locally installed copy runs.
  const pkgPath = join(root, "node_modules", "ctxlint", "package.json");
  const pkg = readJson<{ bin?: string | Record<string, string> }>(pkgPath);
  if (!pkg.ok) {
    report.ctxlint = "not_installed";
    return;
  }
  const bin = typeof pkg.value.bin === "string" ? pkg.value.bin : pkg.value.bin?.ctxlint ?? Object.values(pkg.value.bin ?? {})[0];
  if (!bin) {
    report.ctxlint = "not_installed";
    return;
  }
  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, [join(dirname(pkgPath), bin), "--json"], {
      cwd: root,
      encoding: "utf-8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (e: any) {
    // Non-zero exit usually means "found issues" — the JSON is still on stdout.
    stdout = e.stdout?.toString?.() ?? "";
    if (!stdout) {
      report.ctxlint = "failed";
      return;
    }
  }
  try {
    const parsed = JSON.parse(stdout);
    for (const issue of parsed.issues ?? []) {
      if (issue.type === "stale-command") if (!report.dead_commands.some((d) => d.file === issue.file && d.command === issue.command)) report.dead_commands.push({ file: issue.file, command: issue.command });
      if (issue.type === "token-waste") report.token_waste.push({ file: issue.file, estimated_tokens: issue.estimated_tokens || 0 });
      if (issue.type === "stale-file-ref" && issue.path) report.missing_paths.push({ file: issue.file, path: issue.path, source: "prose" });
    }
    report.ctxlint = "ran";
  } catch {
    report.ctxlint = "failed";
  }
}

export interface DetectOptions {
  manifestPath?: string;
  /** Scan prose inside context files for backticked paths. Default true. */
  prose?: boolean;
  /** Run a locally-installed ctxlint. Default false. Never downloads. */
  ctxlint?: boolean;
  /**
   * With no manifest at all, check auto-discovered context files instead of
   * failing with manifest_not_found. A manifest that lists no context files
   * always falls back to discovery — otherwise `{}` would hide every broken ref.
   */
  discover?: boolean;
  now?: number;
}

const PLACEHOLDER = /\{\{[^}]*\}\}/;

export function detectStale(root: string, opts: DetectOptions = {}): DetectResult {
  const loaded = loadManifest(root, opts.manifestPath);
  if (!loaded.ok && !(loaded.error === "manifest_not_found" && opts.discover)) return loaded as DetectResult;
  const manifest: ContextManifest = loaded.ok ? loaded.value.manifest : {};
  let repoFiles: string[] | null = null;
  const listFiles = () => (repoFiles ??= listRepoFiles(root, { maxFiles: 50_000, linkedFiles: true }).files);
  let files: ManifestContextFile[] = loaded.ok ? loaded.value.files : [];
  const mode = files.length ? "manifest" : "discovered";
  if (mode === "discovered") files = discoverContextFiles(root, listFiles()).map((path) => ({ path, references: [] }));

  const report: StaleReport = {
    stale_files: [],
    missing_context_files: [],
    missing_paths: [],
    invalid_timestamps: [],
    unfilled_placeholders: [],
    schema_problems: loaded.ok ? loaded.value.problems : [],
    dead_commands: [],
    broken_links: [],
    unknown_commits: [],
    token_waste: [],
    ctxlint: "not_requested",
  };

  // Placeholders anywhere in the manifest land here too, so an unfilled template
  // can't pass "no unfilled placeholders" while the schema check flags the same values.
  if (loaded.ok) {
    const rel = toPosix(relative(root, loaded.value.path)) || loaded.value.path;
    report.unfilled_placeholders.push(...findPlaceholders(rel, readTextFile(loaded.value.path) ?? ""));
  }

  const days = typeof manifest.staleness_threshold_days === "number" && manifest.staleness_threshold_days > 0
    ? manifest.staleness_threshold_days
    : DEFAULT_STALENESS_DAYS;
  const thresholdMs = days * 86_400_000;
  const now = opts.now ?? Date.now();
  const seen = new Set<string>();

  for (const cf of files) {
    const cfPath = toPosix(cf.path).replace(/^\.\//, "");
    if (PLACEHOLDER.test(cfPath)) continue; // already reported as an unfilled placeholder

    // The context file itself must exist — a deleted AGENTS.md used to report healthy.
    if (!existsExact(root, cfPath)) {
      report.missing_context_files.push(cfPath);
    } else if (opts.prose !== false) {
      const content = readTextFile(join(root, cfPath)) ?? "";
      report.unfilled_placeholders.push(...findPlaceholders(cfPath, content));
      for (const c of checkClaims(root, cfPath, content)) {
        if (c.kind === "command") report.dead_commands.push({ file: cfPath, command: c.text, line: c.line, reason: c.reason, suggestion: c.suggestion });
        else if (c.kind === "link") report.broken_links.push({ file: cfPath, line: c.line, target: c.text });
        else report.unknown_commits.push({ file: cfPath, line: c.line, sha: c.text });
      }
      const cfDir = toPosix(dirname(cfPath));
      for (const ref of extractProseRefs(content)) {
        const key = `${cfPath}\0${ref.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const fromDir = cfDir && cfDir !== "." ? `${cfDir}/${ref.path}` : ref.path;
        if (!existsExact(root, ref.path) && !existsExact(root, fromDir)) {
          report.missing_paths.push({ file: cfPath, path: ref.path, source: "prose" });
        }
      }
    }

    for (const ref of cf.references) {
      // Judged whether or not the path exists (or is a placeholder), so this agrees with the schema check.
      const t = typeof ref.last_verified === "string" && !PLACEHOLDER.test(ref.last_verified) ? Date.parse(ref.last_verified) : NaN;
      if (!Number.isFinite(t)) {
        // Unfilled `{{DATE}}` used to parse as NaN and silently count as fresh.
        report.invalid_timestamps.push({ file: cfPath, path: ref.path, value: ref.last_verified });
        if (!report.stale_files.includes(cfPath)) report.stale_files.push(cfPath);
      } else if (now - t > thresholdMs && !report.stale_files.includes(cfPath)) report.stale_files.push(cfPath);
      if (!PLACEHOLDER.test(ref.path) && !existsExact(root, ref.path)) report.missing_paths.push({ file: cfPath, path: ref.path, source: "manifest" });
    }
  }

  if (opts.ctxlint) runLocalCtxlint(root, report);

  for (const m of report.missing_paths) {
    const s = suggestPath(m.path, listFiles());
    if (s) m.suggestion = s;
  }

  const healthy =
    report.stale_files.length === 0 &&
    report.missing_context_files.length === 0 &&
    report.missing_paths.length === 0 &&
    report.invalid_timestamps.length === 0 &&
    report.unfilled_placeholders.length === 0 &&
    report.dead_commands.length === 0 &&
    report.broken_links.length === 0 &&
    report.unknown_commits.length === 0 &&
    report.schema_problems.length === 0;

  return {
    ok: true,
    healthy,
    report,
    manifest: loaded.ok ? loaded.value.path : null,
    legacy_schema: loaded.ok ? loaded.value.legacySchema : false,
    mode,
    context_files: files.map((f) => toPosix(f.path).replace(/^\.\//, "")),
  };
}

export interface RepairResult {
  repaired: string;
  timestamp: string;
  refreshed: number;
  still_missing: { file: string; path: string }[];
  migrated_legacy_schema: boolean;
}

/**
 * Refresh `last_verified` for references that still exist.
 *
 * This only certifies EXISTENCE. It must run after the context prose has been
 * re-verified against the code (the Gardener's /repair-docs procedure) —
 * bumping timestamps without re-reading the code is how stale context gets
 * laundered into "fresh" context.
 *
 * Legacy `contexts/covers` manifests are migrated to `context_files`.
 */
export function repairStale(root: string, opts: { manifestPath?: string; now?: string } = {}): RepairResult {
  // Read-modify-write on a file people also edit: serialise with other agent-flow writers.
  return withLock(join(root, ".agent-flow", "manifest.lock"), () => repairLocked(root, opts));
}

function repairLocked(root: string, opts: { manifestPath?: string; now?: string }): RepairResult {
  const loaded = loadManifest(root, opts.manifestPath);
  if (!loaded.ok) throw new Error(`cannot repair: ${loaded.error} (${loaded.path})`);
  const { manifest, files, legacySchema, path } = loaded.value;
  const now = opts.now ?? isoNow();
  let refreshed = 0;
  const stillMissing: { file: string; path: string }[] = [];

  for (const cf of files) {
    for (const ref of cf.references) {
      if (existsExact(root, ref.path)) {
        ref.last_verified = now;
        ref.exists = true;
        // existsExact already proved it exists; ask the filesystem, not the
        // name, whether it's a directory — extensionless FILES (LICENSE,
        // Makefile) were recorded as directories.
        if (!ref.type) {
          let isDir = !/\.[^/]+$/.test(ref.path);
          try {
            isDir = statSync(join(root, ref.path)).isDirectory();
          } catch {
            /* keep the name heuristic */
          }
          ref.type = isDir ? "directory" : "file";
        }
        refreshed++;
      } else {
        ref.exists = false;
        stillMissing.push({ file: cf.path, path: ref.path });
      }
    }
  }

  const out: ContextManifest = { ...manifest, context_files: files, last_full_scan: now };
  if (legacySchema) {
    delete out.contexts;
    delete out.lastVerified;
  }
  // Keep the file's own indentation, line endings and BOM: the diff should show timestamps, not a reformat.
  const previous = readTextFile(path) ?? "";
  atomicWrite(path, matchExistingFormat(previous, `${JSON.stringify(out, null, detectJsonIndent(previous))}\n`));
  return { repaired: path, timestamp: now, refreshed, still_missing: stillMissing, migrated_legacy_schema: legacySchema };
}

export { normalizeManifest };
