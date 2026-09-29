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
import { defaultBase, git } from "./git.js";
import { CASE_INSENSITIVE_FS, readJson, toPosix } from "./fsutil.js";
import { validatePolicy } from "./policy.js";

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
  secret_scan?: { ignore_paths?: string[] };
  /** Extra paths/globs agents may not read (env files are always denied). */
  deny_read?: string[];
  /** Commands the pipeline runs itself (see gates.ts). */
  gates?: unknown[];
  /** Change-size and content rules (see policy.ts). */
  policy?: unknown;
  pipeline?: { max_review_rounds?: number; max_cost_usd?: number; max_stop_blocks?: number; auto_merge_low_risk?: boolean; models?: { fast?: string; high_reasoning?: string } };
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
  if (man.deny_read !== undefined && (!Array.isArray(man.deny_read) || man.deny_read.some((p) => typeof p !== "string" || !p))) {
    problems.push("deny_read must be an array of non-empty strings");
  }
  if (man.gates !== undefined) {
    if (!Array.isArray(man.gates)) problems.push("gates must be an array");
    else {
      const names = new Set<string>();
      man.gates.forEach((g, i) => {
        const w = `gates[${i}]`;
        if (!g || typeof g !== "object" || Array.isArray(g)) return void problems.push(`${w} must be an object like {"name": "test", "command": ["npm", "test"]}`);
        const s = g as Record<string, unknown>;
        if (typeof s.name !== "string" || !/^[\w.-]+$/.test(s.name)) problems.push(`${w}.name must be letters, digits, ".", "_" or "-"`);
        else if (names.has(s.name)) problems.push(`${w}.name "${s.name}" is used twice`);
        else names.add(s.name);
        const c = s.command;
        if (!((typeof c === "string" && c.trim() !== "") || (Array.isArray(c) && c.length > 0 && c.every((a) => typeof a === "string" && a !== "")))) problems.push(`${w}.command must be a non-empty string or an array of non-empty strings`);
        if (s.cwd !== undefined && (typeof s.cwd !== "string" || !s.cwd.trim())) problems.push(`${w}.cwd must be a repo-relative path string`);
        if (s.timeout_seconds !== undefined && (typeof s.timeout_seconds !== "number" || !Number.isFinite(s.timeout_seconds) || s.timeout_seconds <= 0 || s.timeout_seconds > 86_400)) problems.push(`${w}.timeout_seconds must be a number between 1 and 86400`);
        if (s.expect_exit !== undefined && (!Number.isInteger(s.expect_exit) || (s.expect_exit as number) < 0 || (s.expect_exit as number) > 255)) problems.push(`${w}.expect_exit must be an integer 0-255`);
        if (s.required !== undefined && typeof s.required !== "boolean") problems.push(`${w}.required must be true or false`);
        if (s.on_stop !== undefined && typeof s.on_stop !== "boolean") problems.push(`${w}.on_stop must be true or false`);
      });
    }
  }
  problems.push(...validatePolicy(man.policy));
  const ignore = man.secret_scan?.ignore_paths;
  if (man.secret_scan !== undefined && (typeof man.secret_scan !== "object" || man.secret_scan === null || Array.isArray(man.secret_scan))) {
    problems.push("secret_scan must be an object like {\"ignore_paths\": []}");
  } else if (ignore !== undefined && (!Array.isArray(ignore) || ignore.some((p) => typeof p !== "string" || !p))) {
    problems.push("secret_scan.ignore_paths must be an array of non-empty strings");
  }
  const rounds = man.pipeline?.max_review_rounds;
  // 0 would escalate round 1 before the Implementer writes anything.
  if (rounds !== undefined && (!Number.isInteger(rounds) || rounds < 1 || rounds > 5)) {
    problems.push("pipeline.max_review_rounds must be an integer 1–5");
  }
  const stopBlocks = man.pipeline?.max_stop_blocks;
  if (stopBlocks !== undefined && (!Number.isInteger(stopBlocks) || stopBlocks < 1 || stopBlocks > 5)) {
    problems.push("pipeline.max_stop_blocks must be an integer 1–5");
  }
  const cost = man.pipeline?.max_cost_usd;
  if (cost !== undefined && (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0)) {
    problems.push("pipeline.max_cost_usd must be a positive number");
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
export function loadManifestForGuard(root: string): { manifest: ContextManifest | null; error?: string; fromHead?: boolean } {
  const r = loadManifest(root);
  const head = committedManifest(root);
  const base = defaultBranchManifest(root);
  if (r.ok) {
    // Protection committed to HEAD outlives an uncommitted edit: emptying protected_paths on disk
    // (a Write, an `rm`, a `git checkout` of an older copy) must not switch it off.
    // The floor is what the default branch and HEAD both committed: committing a weaker manifest on a
    // feature branch must not lower it, so the default branch's copy counts as well as HEAD's.
    const disk = r.value.manifest;
    const floors = [head, base];
    const extra = [...new Set(floors.flatMap((f) => protectedPathsOf(f)))].filter((p) => !protectedPathsOf(disk).includes(p));
    const extraDeny = [...new Set(floors.flatMap((f) => denyReadPathsOf(f)))].filter((p) => !denyReadPathsOf(disk).includes(p));
    if (!extra.length && !extraDeny.length) return { manifest: disk };
    return { manifest: { ...disk, protected_paths: [...protectedPathsOf(disk), ...extra], deny_read: [...denyReadPathsOf(disk), ...extraDeny] } };
  }
  if (r.error !== "manifest_not_found") return { manifest: null, error: r.error };
  // A manifest that was committed and then deleted still governs: absence is not permission.
  const held = head ?? base;
  return held ? { manifest: head && base ? { ...head, protected_paths: [...new Set([...protectedPathsOf(head), ...protectedPathsOf(base)])], deny_read: [...new Set([...denyReadPathsOf(head), ...denyReadPathsOf(base)])] } : held, fromHead: true } : { manifest: null };
}

/**
 * Manifest keys that decide what the orchestrator RUNS or how strictly a change is judged. An agent that can
 * edit the working copy must not be able to change them for the session that is judging its own work:
 * `gates` are commands the orchestrator executes outside the guard, and loosening `policy`, `secret_scan`
 * or `pipeline` lowers the bar. They take effect once merged to the default branch (or committed at HEAD
 * when the repository has no default-branch copy).
 */
const FLOORED_KEYS = ["gates", "policy", "secret_scan", "pipeline"] as const;

/** Set to 1 by a human who is editing gates/policy locally and wants the working copy to count right now. */
export const TRUST_WORKING_MANIFEST_ENV = "AGENT_FLOW_TRUST_WORKING_MANIFEST";

/**
 * The manifest as code that JUDGES a change should read it. `protected_paths`, `deny_read` and
 * `risk_boundaries` keep the additive floor (the working copy may add, never remove); the keys in
 * FLOORED_KEYS come from the default branch's copy, else HEAD's, and the working copy's version is ignored.
 * With no committed copy anywhere (a repo that is only starting to adopt agent-flow) the working copy is used.
 */
export function trustedManifest(root: string): { manifest: ContextManifest | null; ignoredEdits: string[] } {
  const disk = tryLoadManifest(root);
  if (process.env[TRUST_WORKING_MANIFEST_ENV] === "1") return { manifest: disk, ignoredEdits: [] };
  const base = defaultBranchManifest(root);
  const head = committedManifest(root);
  const floor = base ?? head;
  if (!floor) return { manifest: disk, ignoredEdits: [] };
  if (!disk) return { manifest: floor, ignoredEdits: [] };
  const out: Record<string, unknown> = { ...disk };
  const ignored: string[] = [];
  for (const k of FLOORED_KEYS) {
    const want = (floor as Record<string, unknown>)[k];
    const have = (disk as Record<string, unknown>)[k];
    if (stableJson(want ?? null) !== stableJson(have ?? null)) ignored.push(k);
    if (want === undefined) delete out[k];
    else out[k] = want;
  }
  const floorBoundaries = Array.isArray(floor.risk_boundaries) ? floor.risk_boundaries : [];
  if (floorBoundaries.length) {
    const seen = new Set(floorBoundaries.map((b) => JSON.stringify(b)));
    const extra = (Array.isArray(disk.risk_boundaries) ? disk.risk_boundaries : []).filter((b) => !seen.has(JSON.stringify(b)));
    out.risk_boundaries = [...floorBoundaries, ...extra];
  }
  // Like the guard: what the default branch or HEAD protects or denies to read, the working copy may add to but not remove.
  for (const key of ["protected_paths", "deny_read"] as const) {
    const of = key === "protected_paths" ? protectedPathsOf : denyReadPathsOf;
    const have = of(disk);
    const extra = [...new Set([...of(head), ...of(base)])].filter((x) => !have.includes(x));
    if (extra.length) out[key] = [...have, ...extra];
  }
  return { manifest: out as ContextManifest, ignoredEdits: ignored };
}

/** JSON with sorted keys, so reordering a manifest's keys doesn't look like an edit. */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
}

/** CONTEXT_MANIFEST.json as the default branch has it (a feature branch can't weaken what main already committed). */
export function defaultBranchManifest(root: string): ContextManifest | null {
  let base: string;
  try {
    base = defaultBase(root);
  } catch {
    return null;
  }
  const r = git(["show", `${base}:${MANIFEST_FILE}`], root, 10_000);
  if (!r.ok) return null;
  try {
    const parsed = JSON.parse(r.stdout.replace(/^\uFEFF/, ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ContextManifest) : null;
  } catch {
    return null;
  }
}

/** CONTEXT_MANIFEST.json as committed at HEAD, or null (no repo, no commit, not committed, unparseable). */
export function committedManifest(root: string): ContextManifest | null {
  const r = git(["show", `HEAD:${MANIFEST_FILE}`], root, 10_000);
  if (!r.ok) return null;
  try {
    const parsed = JSON.parse(r.stdout.replace(/^\uFEFF/, ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ContextManifest) : null;
  } catch {
    return null;
  }
}

/**
 * Should a guard that itself broke refuse the call? Yes whenever protection is configured (a manifest
 * on disk or at HEAD) or the launcher asked for it; an unconfigured ordinary session isn't bricked by a bug.
 */
export function guardFailsClosed(root: string): boolean {
  if (process.env.AGENT_FLOW_GUARD_STRICT === "1") return true;
  try {
    return existsSync(join(root, MANIFEST_FILE)) || committedManifest(root) !== null || defaultBranchManifest(root) !== null;
  } catch {
    return false;
  }
}

/** deny_read as a clean string array. */
export function denyReadPathsOf(man: ContextManifest | null | undefined): string[] {
  const p = man?.deny_read;
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
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
    // `research/ledger/**` protects the directory too: deleting or moving it must not slip past.
    if (pat.endsWith("/**") && matchesPattern(pat.slice(0, -3), file)) return true;
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

/** Paths the manifest exempts from secret scanning; anything malformed is dropped (validation reports it). */
export function secretIgnorePaths(man: ContextManifest | null | undefined): string[] {
  const p = man?.secret_scan?.ignore_paths;
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

export function maxReviewRounds(man: ContextManifest | null): number {
  const r = man?.pipeline?.max_review_rounds;
  return Number.isInteger(r) && (r as number) >= 1 && (r as number) <= 5 ? (r as number) : DEFAULT_MAX_REVIEW_ROUNDS;
}

/** The per-issue cost cap in USD, or undefined when none is set. */
export function maxCostUsd(man: ContextManifest | null): number | undefined {
  const c = man?.pipeline?.max_cost_usd;
  return typeof c === "number" && Number.isFinite(c) && c > 0 ? c : undefined;
}
