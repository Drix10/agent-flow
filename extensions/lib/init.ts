/**
 * `agent-flow init` — a deterministic starter manifest (and, if missing, an
 * AGENTS.md skeleton) from what is on disk. No model involved, so nothing is
 * claimed that a file didn't say: unknowns are marked [NEEDS VERIFICATION].
 */

import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { existsExact, isoNow, readJson, readTextFile, toPosix } from "./fsutil.js";
import { git } from "./git.js";
import { ContextManifest, MANIFEST_FILE, validateManifest } from "./manifest.js";
import { ScanResult, scanRepo } from "./scan.js";
import { discoverContextFiles, extractProseRefs } from "./stale.js";

export interface InitFile {
  path: string;
  content: string;
  /** Already on disk — never overwritten. */
  exists: boolean;
}

export interface InitPlan {
  files: InitFile[];
  context_files: string[];
  references: number;
  /** Root-level context files that already hold the user's rules; a fresh AGENTS.md was not generated beside them. */
  existing_rules?: string[];
  /** Paths on disk that usually deserve `protected_paths`; suggested, never written — that call is the owner's. */
  suggested_protected_paths: string[];
  /** Prose references that don't exist today — left out of the manifest; `doctor` reports them. */
  missing_references: { file: string; path: string }[];
}

function runner(scan: ScanResult, script: string): string {
  const pm = scan.packageManagers[0];
  if (pm === "pnpm") return `pnpm run ${script}`;
  if (pm === "yarn") return `yarn ${script}`;
  if (pm === "bun") return `bun run ${script}`;
  return script === "test" || script === "start" ? `npm ${script}` : `npm run ${script}`;
}

function branchOf(root: string, scan: ScanResult): string | null {
  if (scan.git.defaultBranch) return scan.git.defaultBranch;
  // No commits yet: HEAD still names the branch you're on.
  const r = git(["symbolic-ref", "--quiet", "--short", "HEAD"], root);
  return r.ok && r.stdout ? r.stdout : null;
}

export function agentsSkeleton(root: string, scan: ScanResult, branch: string | null): string {
  const name = basename(root);
  const pkg = readJson<{ description?: unknown }>(join(root, "package.json"));
  const desc = pkg.ok && typeof pkg.value?.description === "string" && pkg.value.description.trim() ? pkg.value.description.trim() : null;
  const L: string[] = [
    `# ${name}`,
    "",
    "<!--",
    "  Root context for coding agents. Written by `agent-flow init` from a read-only scan.",
    "  Replace every [NEEDS VERIFICATION] with what the code actually does, or delete the line.",
    "  Every backticked path here is checked by `agent-flow doctor`.",
    "  Markers: [HIGH CONFIDENCE] read in code · [INFERRED] from names/patterns · [NEEDS VERIFICATION] unknown",
    "-->",
    "",
    "## What this is",
    "",
    desc ? `${desc} [INFERRED] (package.json description)` : "[NEEDS VERIFICATION] One paragraph: what this repo does and for whom.",
    "",
  ];
  const dirs = scan.topLevelDirs.filter((d) => !d.startsWith(".")).slice(0, 20);
  if (dirs.length) {
    L.push("## Where things live", "", "| Path | Purpose | Confidence |", "|---|---|---|");
    for (const d of dirs) L.push(`| \`${d}/\` | | [NEEDS VERIFICATION] |`);
    L.push("");
  }
  L.push("## Commands", "");
  if (scan.commands.length) {
    L.push("| Task | Command | Source |", "|---|---|---|");
    const seen = new Set<string>();
    for (const c of scan.commands) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      const cmd = c.source === "Makefile" ? c.command : runner(scan, c.name);
      L.push(`| ${c.name} | \`${cmd}\` | ${c.source === "Makefile" ? "Makefile" : "package.json scripts"} [HIGH CONFIDENCE] |`);
    }
  } else L.push("[NEEDS VERIFICATION] No package.json scripts or Makefile targets found. How do you build, test and lint?");
  L.push(
    "",
    "## Paved paths",
    "",
    "<!-- The one way we do common things, each with an example file. -->",
    "",
    "## Local traps",
    "",
    "<!-- Things that look right and are wrong here — and what to do instead. -->",
    "",
    "## Rules",
    "",
    "- Never modify protected paths (see `CONTEXT_MANIFEST.json` → `protected_paths`). Escalate instead.",
    ...(branch ? [`- Changes land via PR; never push to \`${branch}\` directly.`] : []),
    "- New dependencies need risk review (`agent-flow audit-risk`).",
    "- If code contradicts this file, trust the code and flag it.",
    "",
  );
  return L.join("\n");
}

function countMarkers(content: string) {
  const n = (re: RegExp) => (content.match(re) ?? []).length;
  return {
    high_confidence: n(/\[HIGH CONFIDENCE\]/g),
    inferred: n(/\[INFERRED\]/g),
    needs_verification: n(/\[NEEDS VERIFICATION\]/g),
  };
}

/** Directories and files whose accidental edit is expensive, from what actually exists. */
function suggestProtectedPaths(root: string): string[] {
  const out: string[] = [];
  for (const d of ["migrations", "db/migrate", "prisma/migrations", "alembic", "terraform", "infra", "infrastructure", "secrets", "ledger", "audit", "deploy"]) {
    try {
      if (statSync(join(root, d)).isDirectory()) out.push(`${d}/`);
    } catch {
      /* not there */
    }
  }
  if (existsSync(join(root, ".github", "workflows"))) out.push(".github/workflows/");
  return out;
}

export function planInit(root: string, opts: { version: string; now?: string }): InitPlan {
  const now = opts.now ?? isoNow();
  const scan = scanRepo(root);
  const branch = branchOf(root, scan);
  const files: InitFile[] = [];

  const contextFiles = discoverContextFiles(root);
  const contents = new Map<string, string>();
  for (const f of contextFiles) contents.set(f, readTextFile(join(root, f)) ?? "");
  // A CLAUDE.md, GEMINI.md or .cursorrules with real content is the user's rules. A second, empty-of-knowledge
  // AGENTS.md beside it would split the source of truth, so leave the choice (and the migration) to them.
  const existingRules = contextFiles.filter((f) => !f.includes("/") && !/^AGENTS\.md$/i.test(f) && (contents.get(f) ?? "").replace(/^\s*@AGENTS\.md\s*$/m, "").trim() !== "");
  if (!existsSync(join(root, "AGENTS.md")) && existingRules.length === 0) {
    const content = agentsSkeleton(root, scan, branch);
    files.push({ path: "AGENTS.md", content, exists: false });
    contextFiles.unshift("AGENTS.md");
    contents.set("AGENTS.md", content);
  }

  const { context_files, missing, refCount } = buildContextFiles(root, contextFiles, contents, now);

  const manifest: ContextManifest = {
    ...schemaRef(root),
    version: "2",
    repo: basename(root),
    generated_by: `agent-flow@${opts.version} init`,
    generated_at: now,
    last_full_scan: now,
    ...(branch ? { default_branch: branch } : {}),
    staleness_threshold_days: 30,
    context_files,
    protected_paths: [],
    pipeline: { max_review_rounds: 2, auto_merge_low_risk: false },
  };
  const problems = validateManifest(manifest);
  if (problems.length) throw new Error(`init built an invalid manifest (bug): ${problems.join("; ")}`);
  files.push({ path: MANIFEST_FILE, content: `${JSON.stringify(manifest, null, 2)}\n`, exists: existsSync(join(root, MANIFEST_FILE)) });
  const suggested = suggestProtectedPaths(root);
  return { files, context_files: contextFiles, suggested_protected_paths: suggested, references: refCount, missing_references: missing, ...(existingRules.length && !existsSync(join(root, "AGENTS.md")) ? { existing_rules: existingRules } : {}) };
}

/** The `$schema` pointer for an editor: the project's npm install, else the vendored runtime, else none. */
function schemaRef(root: string): { $schema?: string } {
  for (const dir of ["node_modules/@drix10/agent-flow", ".agent-flow-runtime"]) {
    if (existsSync(join(root, dir, "schemas", "context-manifest.schema.json"))) return { $schema: `./${dir}/schemas/context-manifest.schema.json` };
  }
  return {};
}

function buildContextFiles(root: string, contextFiles: string[], contents: Map<string, string>, now: string) {
  const missing: InitPlan["missing_references"] = [];
  let refCount = 0;
  const context_files = contextFiles.map((cf) => {
    const content = contents.get(cf) ?? "";
    const cfDir = toPosix(dirname(cf));
    const refs = new Map<string, { path: string; type: "file" | "directory"; last_verified: string; exists: true }>();
    for (const ref of extractProseRefs(content)) {
      const fromDir = cfDir !== "." ? `${cfDir}/${ref.path}` : ref.path;
      const hit = [ref.path, fromDir].find((p) => existsExact(root, p));
      if (!hit) {
        missing.push({ file: cf, path: ref.path });
        continue;
      }
      const key = hit.replace(/\/+$/, "");
      if (refs.has(key)) continue;
      const type = statSync(join(root, key)).isDirectory() ? "directory" : "file";
      refs.set(key, { path: type === "directory" ? `${key}/` : key, type, last_verified: now, exists: true });
    }
    refCount += refs.size;
    return { path: cf, references: [...refs.values()], confidence_markers: countMarkers(content) };
  });
  return { context_files, missing, refCount };
}

export interface SyncPlan {
  manifest: ContextManifest;
  added_files: string[];
  removed_files: string[];
  added_refs: number;
  removed_refs: number;
  missing_references: { file: string; path: string }[];
}

/**
 * Rebuild `context_files` from the context files on disk and the paths their prose names, keeping every other key
 * (protected_paths, risk_boundaries, gates, policy…) exactly as the human set it. A reference that is still named
 * keeps its `last_verified`, so syncing never makes old context look fresh. A newly named path is stamped now, as
 * `init` does: it was just read off the prose and checked to exist, which is all that stamp claims.
 */
export function syncManifest(root: string, existing: ContextManifest, opts: { version: string; now?: string }): SyncPlan {
  const now = opts.now ?? isoNow();
  const onDisk = discoverContextFiles(root);
  const contents = new Map<string, string>();
  for (const f of onDisk) contents.set(f, readTextFile(join(root, f)) ?? "");
  const built = buildContextFiles(root, onDisk, contents, now);
  const before = new Map((existing.context_files ?? []).map((c) => [c.path, c]));
  let added_refs = 0;
  let removed_refs = 0;
  const context_files = built.context_files.map((cf) => {
    const old = new Map((before.get(cf.path)?.references ?? []).map((r) => [r.path, r]));
    const refs = cf.references.map((r) => {
      const prev = old.get(r.path);
      if (!prev) added_refs++;
      return prev?.last_verified ? { ...r, last_verified: prev.last_verified } : r;
    });
    removed_refs += [...old.keys()].filter((p) => !cf.references.some((r) => r.path === p)).length;
    // Keep any extra keys the human put on the entry; only the derived parts are regenerated.
    return { ...before.get(cf.path), ...cf, references: refs };
  });
  const manifest: ContextManifest = { ...schemaRef(root), ...existing, context_files, last_full_scan: now, generated_by: `agent-flow@${opts.version} manifest sync` };
  if (!existing.$schema) delete (manifest as { $schema?: string }).$schema;
  const problems = validateManifest(manifest);
  if (problems.length) throw new Error(`the synced manifest is invalid: ${problems.join("; ")}`);
  return {
    manifest,
    added_files: onDisk.filter((f) => !before.has(f)),
    removed_files: [...before.keys()].filter((f) => !onDisk.includes(f)),
    added_refs,
    removed_refs,
    missing_references: built.missing,
  };
}
