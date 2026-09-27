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
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWrite, existsExact, isoNow, readJson, readTextFile, toPosix } from "./fsutil.js";
import { ContextManifest, DEFAULT_STALENESS_DAYS, loadManifest, normalizeManifest } from "./manifest.js";

export interface StaleReport {
  stale_files: string[];
  missing_context_files: string[];
  missing_paths: { file: string; path: string; source: "manifest" | "prose" }[];
  invalid_timestamps: { file: string; path: string; value: unknown }[];
  unfilled_placeholders: { file: string; line: number; text: string }[];
  schema_problems: string[];
  dead_commands: { file: string; command: string }[];
  token_waste: { file: string; estimated_tokens: number }[];
  ctxlint: "not_requested" | "not_installed" | "ran" | "failed";
}

export type DetectResult =
  | { ok: true; healthy: boolean; report: StaleReport; manifest: string; legacy_schema: boolean }
  | { ok: false; error: string; path: string };

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
    for (const m of line.matchAll(/`([^`\s]+)`/g)) {
      let tok = m[1].replace(/^\.\//, "").replace(/[),.;]+$/, "");
      tok = tok.replace(/(#L\d+(-L?\d+)?|:\d+(:\d+)?)$/, ""); // line anchors
      if (!tok.includes("/")) continue; // bare names are ambiguous — skip
      if (/^[a-z][a-z0-9+.-]*:/i.test(tok)) continue; // urls, node:fs, npm:pkg
      if (/[*?<>{}$=(\[|~^!]/.test(tok)) continue; // globs, placeholders, code
      if (tok.startsWith("@") || tok.startsWith("-") || tok.startsWith("/") || tok.startsWith("~")) continue;
      if (/^\.\.?\/?$/.test(tok) || tok.startsWith("../")) continue;
      if (!/^[\w.\-/]+$/.test(tok)) continue;
      if (/^\d+(\.\d+)*\/\d/.test(tok)) continue; // ratios, versions
      out.push({ path: tok, line: idx + 1 });
    }
  });
  return out;
}

function findPlaceholders(file: string, content: string) {
  const out: { file: string; line: number; text: string }[] = [];
  content.split(/\r?\n/).forEach((line, i) => {
    const m = line.match(/\{\{[A-Z0-9_]+\}\}/);
    if (m) out.push({ file, line: i + 1, text: m[0] });
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
      if (issue.type === "stale-command") report.dead_commands.push({ file: issue.file, command: issue.command });
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
  now?: number;
}

export function detectStale(root: string, opts: DetectOptions = {}): DetectResult {
  const loaded = loadManifest(root, opts.manifestPath);
  if (!loaded.ok) return loaded;
  const { files, manifest, legacySchema, problems } = loaded.value;

  const report: StaleReport = {
    stale_files: [],
    missing_context_files: [],
    missing_paths: [],
    invalid_timestamps: [],
    unfilled_placeholders: [],
    schema_problems: problems,
    dead_commands: [],
    token_waste: [],
    ctxlint: "not_requested",
  };

  const days = typeof manifest.staleness_threshold_days === "number" && manifest.staleness_threshold_days > 0
    ? manifest.staleness_threshold_days
    : DEFAULT_STALENESS_DAYS;
  const thresholdMs = days * 86_400_000;
  const now = opts.now ?? Date.now();
  const seen = new Set<string>();

  for (const cf of files) {
    const cfPath = toPosix(cf.path).replace(/^\.\//, "");

    // The context file itself must exist — a deleted AGENTS.md used to report healthy.
    if (!existsExact(root, cfPath)) {
      report.missing_context_files.push(cfPath);
    } else if (opts.prose !== false) {
      const content = readTextFile(join(root, cfPath)) ?? "";
      report.unfilled_placeholders.push(...findPlaceholders(cfPath, content));
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
      if (!existsExact(root, ref.path)) {
        report.missing_paths.push({ file: cfPath, path: ref.path, source: "manifest" });
        continue;
      }
      const t = Date.parse(ref.last_verified);
      if (!Number.isFinite(t)) {
        // Unfilled `{{DATE}}` used to parse as NaN and silently count as fresh.
        report.invalid_timestamps.push({ file: cfPath, path: ref.path, value: ref.last_verified });
        if (!report.stale_files.includes(cfPath)) report.stale_files.push(cfPath);
        continue;
      }
      if (now - t > thresholdMs && !report.stale_files.includes(cfPath)) report.stale_files.push(cfPath);
    }
  }

  if (opts.ctxlint) runLocalCtxlint(root, report);

  const healthy =
    report.stale_files.length === 0 &&
    report.missing_context_files.length === 0 &&
    report.missing_paths.length === 0 &&
    report.invalid_timestamps.length === 0 &&
    report.unfilled_placeholders.length === 0 &&
    report.dead_commands.length === 0 &&
    report.schema_problems.length === 0;

  return { ok: true, healthy, report, manifest: loaded.value.path, legacy_schema: legacySchema };
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
        if (!ref.type) ref.type = existsSync(join(root, ref.path)) && !/\.[^/]+$/.test(ref.path) ? "directory" : "file";
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
  atomicWrite(path, JSON.stringify(out, null, 2) + "\n");
  return { repaired: path, timestamp: now, refreshed, still_missing: stillMissing, migrated_legacy_schema: legacySchema };
}

export { normalizeManifest };
