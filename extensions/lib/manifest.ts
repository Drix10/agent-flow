/**
 * CONTEXT_MANIFEST.json — load, normalize, validate, and match paths against it.
 *
 * FM-17: a generator once wrote `contexts[].covers` while the detector read
 * `context_files[].references`. We still READ both shapes, but validation now
 * reports the legacy shape so it gets migrated instead of silently tolerated,
 * and bootstrap_write refuses to write an invalid manifest in the first place.
 */

import { isAbsolute, join } from "node:path";
import { existsSync } from "node:fs";
import { CASE_INSENSITIVE_FS, readJson, toPosix } from "./fsutil.js";

export const MANIFEST_FILE = "CONTEXT_MANIFEST.json";
export const DEFAULT_STALENESS_DAYS = 30;
export const DEFAULT_MAX_REVIEW_ROUNDS = 2;

export type RiskLevel = "low" | "medium" | "critical";

export interface ManifestRef {
  path: string;
  type?: "file" | "directory";
  last_verified: string;
  exists?: boolean;
}

export interface ManifestContextFile {
  path: string;
  references: ManifestRef[];
  confidence_markers?: Record<string, number>;
}

export interface RiskBoundary {
  path: string;
  risk_level: RiskLevel;
  reviewer_model?: string;
  rationale?: string;
}

export interface ContextManifest {
  $schema?: string;
  version?: string | number;
  repo?: string;
  generated_at?: string;
  generated_by?: string;
  last_full_scan?: string;
  lastVerified?: string;
  staleness_threshold_days?: number;
  default_branch?: string;
  context_files?: ManifestContextFile[];
  /** Legacy shape (FM-17). Read-only support. */
  contexts?: { path: string; covers?: string[] }[];
  risk_boundaries?: RiskBoundary[];
  protected_paths?: string[];
  pipeline?: { max_review_rounds?: number; auto_merge_low_risk?: boolean; models?: { fast?: string; high_reasoning?: string } };
  ci?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LoadedManifest {
  path: string;
  manifest: ContextManifest;
  files: ManifestContextFile[];
  legacySchema: boolean;
  problems: string[];
}

export type LoadResult = { ok: true; value: LoadedManifest } | { ok: false; error: string; path: string };

export function manifestPathFor(root: string, manifestPath?: string): string {
  // The CLI passes `--manifest` straight through; a bare flag arrives as `true`.
  // Fail here with a sentence, not deep inside path.isAbsolute with a TypeError.
  if (manifestPath !== undefined && typeof manifestPath !== "string") {
    throw new Error(`manifest path must be a string, got ${JSON.stringify(manifestPath)} — usage: --manifest <path>`);
  }
  const p = manifestPath ?? MANIFEST_FILE;
  return isAbsolute(p) ? p : join(root, p);
}

const PLACEHOLDER = /\{\{[^}]*\}\}/;

function validTimestamp(s: unknown): boolean {
  if (typeof s !== "string" || PLACEHOLDER.test(s)) return false;
  const t = Date.parse(s);
  return Number.isFinite(t);
}

/** Structural validation. Returns human-readable problems; empty = valid. */
export function validateManifest(m: unknown): string[] {
  const problems: string[] = [];
  if (!m || typeof m !== "object" || Array.isArray(m)) return ["manifest must be a JSON object"];
  const man = m as ContextManifest;

  if (man.contexts && !man.context_files) {
    problems.push("legacy `contexts`/`covers` schema (FM-17) — migrate to `context_files` with per-reference `last_verified`");
  }
  if (man.version !== undefined && typeof man.version !== "string") problems.push(`version must be a string ("2"), got ${JSON.stringify(man.version)}`);
  if (man.default_branch !== undefined && (typeof man.default_branch !== "string" || !man.default_branch.trim())) {
    problems.push(`default_branch must be a branch name string, got ${JSON.stringify(man.default_branch)} — ignored`);
  }
  if (!man.context_files && !man.contexts) problems.push("missing `context_files` array");
  if (man.context_files !== undefined && !Array.isArray(man.context_files)) problems.push("`context_files` must be an array");

  if (Array.isArray(man.context_files)) {
    man.context_files.forEach((cf, i) => {
      if (!cf || typeof cf !== "object" || Array.isArray(cf)) {
        problems.push(`context_files[${i}] must be an object like {"path": "AGENTS.md", "references": []}, got ${JSON.stringify(cf)}`);
        return;
      }
      if (cf.path !== undefined && typeof cf.path !== "string") problems.push(`context_files[${i}].path must be a string, got ${JSON.stringify(cf.path)}`);
      else if (!cf.path) problems.push(`context_files[${i}].path missing`);
      else if (PLACEHOLDER.test(cf.path)) problems.push(`context_files[${i}].path is an unfilled template placeholder: ${cf.path}`);
      if (!Array.isArray(cf?.references)) {
        problems.push(`context_files[${i}].references must be an array`);
        return;
      }
      cf.references.forEach((r, j) => {
        const where = `context_files[${i}].references[${j}]`;
        if (!r || typeof r !== "object" || Array.isArray(r)) {
          problems.push(`${where} must be an object with path/type/last_verified, got ${JSON.stringify(r)}`);
          return;
        }
        if (r.path !== undefined && typeof r.path !== "string") problems.push(`${where}.path must be a string, got ${JSON.stringify(r.path)}`);
        else if (!r.path) problems.push(`${where}.path missing`);
        else if (PLACEHOLDER.test(r.path)) problems.push(`${where}.path is an unfilled template placeholder: ${r.path}`);
        if (!validTimestamp(r?.last_verified)) problems.push(`${where}.last_verified is not a valid ISO timestamp: ${JSON.stringify(r?.last_verified)}`);
        else if (Date.parse(r.last_verified) > Date.now() + 24 * 3600_000) problems.push(`${where}.last_verified is in the future: ${r.last_verified}`);
      });
    });
  }

  if (man.staleness_threshold_days !== undefined) {
    const d = man.staleness_threshold_days;
    if (typeof d !== "number" || !Number.isFinite(d) || d <= 0) problems.push("staleness_threshold_days must be a positive number");
  }
  if (man.protected_paths !== undefined) {
    if (typeof man.protected_paths === "string") problems.push(`protected_paths must be an array — treating the string as ["${man.protected_paths}"]`);
    else if (!Array.isArray(man.protected_paths)) problems.push("protected_paths must be an array of strings — ignored");
    else
      man.protected_paths.forEach((p, i) => {
        if (typeof p !== "string" || !p) problems.push(`protected_paths[${i}] must be a non-empty string`);
        else if (PLACEHOLDER.test(p)) problems.push(`protected_paths[${i}] is an unfilled template placeholder: ${p}`);
      });
  }
  if (man.risk_boundaries !== undefined) {
    if (!Array.isArray(man.risk_boundaries)) problems.push("risk_boundaries must be an array");
    else
      man.risk_boundaries.forEach((b, i) => {
        if (!b || typeof b.path !== "string") problems.push(`risk_boundaries[${i}].path missing`);
        else if (PLACEHOLDER.test(b.path)) problems.push(`risk_boundaries[${i}].path is an unfilled template placeholder: ${b.path}`);
        if (!["low", "medium", "critical"].includes(b?.risk_level as string))
          problems.push(`risk_boundaries[${i}].risk_level must be low | medium | critical`);
      });
  }
  const rounds = man.pipeline?.max_review_rounds;
  // 0 would escalate round 1 before the Implementer writes anything.
  if (rounds !== undefined && (!Number.isInteger(rounds) || rounds < 1 || rounds > 5)) {
    problems.push("pipeline.max_review_rounds must be an integer 1–5");
  }
  const models = man.pipeline?.models as Record<string, unknown> | undefined;
  if (models !== undefined) {
    if (typeof models !== "object" || models === null || Array.isArray(models)) problems.push("pipeline.models must be an object");
    else for (const k of ["fast", "high_reasoning"]) {
      if (models[k] !== undefined && (typeof models[k] !== "string" || !(models[k] as string).trim())) problems.push(`pipeline.models.${k} must be a non-empty string`);
    }
  }
  return problems;
}

/** Normalize either schema into `context_files` shape (legacy covers get the manifest stamp). */
export function normalizeManifest(man: ContextManifest): { files: ManifestContextFile[]; legacy: boolean } {
  if (Array.isArray(man.context_files)) {
    return {
      legacy: false,
      files: man.context_files
        .filter((cf) => cf && typeof cf.path === "string")
        .map((cf) => ({ ...cf, references: Array.isArray(cf.references) ? cf.references.filter((r) => r && typeof r.path === "string") : [] })),
    };
  }
  const stamp = man.last_full_scan ?? man.lastVerified ?? man.generated_at ?? "";
  return {
    legacy: true,
    files: (Array.isArray(man.contexts) ? man.contexts : [])
      .filter((c) => c && typeof c.path === "string")
      .map((c) => ({
        path: c.path,
        references: (Array.isArray(c.covers) ? c.covers : [])
          .filter((p) => typeof p === "string")
          .map((p) => ({ path: p, type: "file" as const, last_verified: stamp, exists: true })),
      })),
  };
}

export function loadManifest(root: string, manifestPath?: string): LoadResult {
  const path = manifestPathFor(root, manifestPath);
  if (!existsSync(path)) return { ok: false, error: "manifest_not_found", path };
  const parsed = readJson<ContextManifest>(path);
  if (!parsed.ok) return { ok: false, error: parsed.error, path };
  const problems = validateManifest(parsed.value);
  if (problems.length === 1 && problems[0] === "manifest must be a JSON object") {
    return { ok: false, error: problems[0], path };
  }
  const { files, legacy } = normalizeManifest(parsed.value);
  // Downstream code iterates protected_paths: a hand-written string would be
  // walked char by char (or crash `.filter`). Validation above reports it.
  if (parsed.value.protected_paths !== undefined) parsed.value.protected_paths = protectedPathsOf(parsed.value);
  return { ok: true, value: { path, manifest: parsed.value, files, legacySchema: legacy, problems } };
}

/** protected_paths as a clean string array, whatever shape the manifest has: a string is one pattern, junk entries are dropped. */
export function protectedPathsOf(man: { protected_paths?: unknown } | null | undefined): string[] {
  const p = man?.protected_paths;
  if (typeof p === "string") return p.trim() ? [p] : [];
  if (!Array.isArray(p)) return [];
  return p.filter((x): x is string => typeof x === "string" && x.length > 0);
}

/** Load the manifest if present; never throws. Used by the classifier and state machine. */
export function tryLoadManifest(root: string): ContextManifest | null {
  const r = loadManifest(root);
  return r.ok ? r.value.manifest : null;
}

/**
 * For the guard: the manifest, or why an existing one can't be loaded. "Absent"
 * and "present but unparseable" must differ — the second fails closed.
 */
export function loadManifestForGuard(root: string): { manifest: ContextManifest | null; error?: string } {
  const r = loadManifest(root);
  if (r.ok) return { manifest: r.value.manifest };
  return r.error === "manifest_not_found" ? { manifest: null } : { manifest: null, error: r.error };
}

// ---------------------------------------------------------------------------
// Path patterns: `src/billing/` (dir prefix), `src/auth.ts` (exact),
// `**/migrations/**`, `*.lock` (globs). Matching is on repo-relative POSIX paths,
// case-insensitive on Windows/macOS.
// ---------------------------------------------------------------------------

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, CASE_INSENSITIVE_FS ? "i" : "");
}

function norm(p: string): string {
  let s = toPosix(p).trim().replace(/^\.\//, "");
  if (CASE_INSENSITIVE_FS) s = s.toLowerCase();
  return s;
}

export function matchesPattern(pattern: string, file: string): boolean {
  if (!pattern || !file) return false;
  const f = norm(file);
  // `/config/` is gitignore-style "from the repo root"; files are already repo-relative, so it means `config/`.
  const pat = toPosix(pattern).trim().replace(/^\.\//, "").replace(/^\/+/, "");
  if (!pat) return false;
  if (/[*?]/.test(pat)) {
    const re = globToRegExp(pat.endsWith("/") ? `${pat}**` : pat);
    // A glob with no slash matches the basename anywhere (like .gitignore).
    if (!pat.includes("/")) return re.test(f.split("/").pop() ?? f);
    return re.test(f);
  }
  const p = norm(pat).replace(/\/+$/, "");
  return f === p || f.startsWith(`${p}/`);
}

export function matchAny(patterns: readonly string[] | string | undefined, file: string): string | null {
  for (const p of protectedPathsOf({ protected_paths: patterns })) if (matchesPattern(p, file)) return p;
  return null;
}

/** Files agents treat as "context" (only the Gardener may edit them). */
export function contextFilePaths(man: ContextManifest | null): string[] {
  const set = new Set<string>([MANIFEST_FILE, "DOCS_INDEX.md"]);
  if (man) for (const cf of normalizeManifest(man).files) set.add(toPosix(cf.path).replace(/^\.\//, ""));
  return [...set];
}

export function maxReviewRounds(man: ContextManifest | null): number {
  const r = man?.pipeline?.max_review_rounds;
  return Number.isInteger(r) && (r as number) >= 1 && (r as number) <= 5 ? (r as number) : DEFAULT_MAX_REVIEW_ROUNDS;
}
