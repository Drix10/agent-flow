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

export function planInit(root: string, opts: { version: string; now?: string }): InitPlan {
  const now = opts.now ?? isoNow();
  const scan = scanRepo(root);
  const branch = branchOf(root, scan);
  const files: InitFile[] = [];

  const contextFiles = discoverContextFiles(root);
  const contents = new Map<string, string>();
  for (const f of contextFiles) contents.set(f, readTextFile(join(root, f)) ?? "");
  if (!existsSync(join(root, "AGENTS.md"))) {
    const content = agentsSkeleton(root, scan, branch);
    files.push({ path: "AGENTS.md", content, exists: false });
    contextFiles.unshift("AGENTS.md");
    contents.set("AGENTS.md", content);
  }

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

  const manifest: ContextManifest = {
    ...(existsSync(join(root, "node_modules", "@drix10", "agent-flow", "schemas", "context-manifest.schema.json"))
      ? { $schema: "./node_modules/@drix10/agent-flow/schemas/context-manifest.schema.json" }
      : {}),
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
  return { files, context_files: contextFiles, references: refCount, missing_references: missing };
}
