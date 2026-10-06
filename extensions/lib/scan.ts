/**
 * Read-only repository reconnaissance for /agent-flow-bootstrap.
 *
 * Every field is backed by a file we actually read, so the bootstrap agent can
 * mark it [HIGH CONFIDENCE]. Anything we could not determine is null, never a
 * guess — v1.0.2 labelled every repo with a package.json as "typescript" and
 * hardcoded pytest for any pyproject.toml.
 */

import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readJson, readTextFile } from "./fsutil.js";
import { listRepoFiles } from "./repofiles.js";
import { defaultBranch, git } from "./git.js";
import { scanRiskSurfaces } from "./risk.js";
import { isContextFile } from "./stale.js";

export interface ScanResult {
  root: string;
  languages: string[];
  packageManagers: string[];
  monorepo: { tool: string; packages: string[] } | null;
  testFrameworks: string[];
  commands: { name: string; command: string; source: string }[];
  topLevelDirs: string[];
  entryPoints: string[];
  existingContextFiles: string[];
  docs: { path: string; lastCommit: string | null }[];
  ci: string[];
  git: { defaultBranch: string | null; recentCommits: string[]; isRepo: boolean };
  secretSuspects: { path: string; detail: string }[];
  truncated: boolean;
}

const CONTEXT_FILES = [
  "AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.local.md", "GEMINI.md", ".cursorrules", ".windsurfrules",
  ".github/copilot-instructions.md", "Root_AGENT.md", "CONTEXT_MANIFEST.json", "DOCS_INDEX.md",
];

const ENTRY = /(^|\/)(main|index|app|server|cli|__main__|manage|lib|mod)\.(ts|tsx|js|mjs|cjs|go|rs|py|rb|java|kt)$/;
const CI = /^(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml|\.circleci\/config\.yml|azure-pipelines\.yml|Jenkinsfile|\.buildkite\/[^/]+\.ya?ml|bitbucket-pipelines\.yml|\.drone\.yml)$/;

/**
 * The single-line commands a workflow's `run:` steps execute, including each plain line of a `run: |` block.
 * Lines that only make sense with their neighbours (loops, conditionals, continuations) are left out.
 */
function ciRunLines(yml: string): string[] {
  const out: string[] = [];
  const lines = yml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:-\s+)?run:\s*(.*?)\s*$/);
    if (!m) continue;
    const indent = m[1].length;
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() && lines[j].search(/\S/) <= indent) break;
      block.push(lines[j].trim());
    }
    const head = m[2];
    // YAML folds a plain or `>` scalar's lines into one command (`go test` + `./...` is `go test ./...`).
    if (!/^[|]/.test(head)) {
      const joined = (/^>/.test(head) ? block : [head, ...block]).filter(Boolean).join(" ").replace(/^["']|["']$/g, "");
      if (joined) out.push(joined);
      continue;
    }
    let continued = false;
    let depth = 0;
    for (const t of block) {
      const wasContinued = continued;
      continued = /\\$/.test(t);
      // Count every compound-statement opener and closer on the line, so `if x; then y; fi` nets to zero.
      depth += (t.match(/(^|[;&|]\s*|\b(?:then|do|else)\s+)(?:for|while|until|if|case)\b/g) ?? []).length;
      depth = Math.max(0, depth - (t.match(/(^|[;&|(]\s*|\s)(?:done|fi|esac)\b/g) ?? []).length);
      // Inside a loop, after a `\`, or using a variable, the line isn't a command anyone can copy and run alone.
      if (!t || t.startsWith("#") || continued || wasContinued || depth > 0 || /\$/.test(t) || /^(then|else|elif|fi|do|done|esac)\b/.test(t) || /^(for|while|until|if|case)\b/.test(t)) continue;
      out.push(t);
    }
  }
  return out;
}

export function scanRepo(root: string, opts: { maxFiles?: number } = {}): ScanResult {
  const { files, truncated } = listRepoFiles(root, { maxFiles: opts.maxFiles ?? 50_000, linkedFiles: true });
  const has = (f: string) => files.includes(f);
  const languages = new Set<string>();
  const pms = new Set<string>();
  const tests = new Set<string>();
  const commands: ScanResult["commands"] = [];

  // --- Node ---------------------------------------------------------------
  const pkgFiles = files.filter((f) => basename(f) === "package.json");
  let rootPkg: any = null;
  for (const f of pkgFiles) {
    const r = readJson<any>(join(root, f));
    if (!r.ok) continue;
    const pkg = r.value;
    if (f === "package.json") rootPkg = pkg;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const tsLike = "typescript" in deps || existsSync(join(root, dirname(f), "tsconfig.json"));
    languages.add(tsLike ? "typescript" : "javascript");
    for (const t of ["jest", "vitest", "mocha", "ava", "tap", "jasmine", "@playwright/test", "cypress", "uvu"]) if (t in deps) tests.add(t);
    const testScript: string = pkg.scripts?.test ?? "";
    if (/node\s+--test/.test(testScript)) tests.add("node:test");
    if (f === "package.json" && pkg.scripts) {
      for (const name of ["build", "test", "lint", "typecheck", "type-check", "check", "format", "dev", "start"]) {
        if (pkg.scripts[name]) commands.push({ name, command: pkg.scripts[name], source: "package.json#scripts" });
      }
    }
  }
  if (has("pnpm-lock.yaml")) pms.add("pnpm");
  if (has("yarn.lock")) pms.add("yarn");
  if (has("package-lock.json")) pms.add("npm");
  if (has("bun.lockb") || has("bun.lock")) pms.add("bun");

  let monorepo: ScanResult["monorepo"] = null;
  if (has("pnpm-workspace.yaml")) monorepo = { tool: "pnpm", packages: [] };
  else if (Array.isArray(rootPkg?.workspaces) || Array.isArray(rootPkg?.workspaces?.packages)) monorepo = { tool: "npm/yarn workspaces", packages: [] };
  else if (has("nx.json")) monorepo = { tool: "nx", packages: [] };
  else if (has("turbo.json")) monorepo = { tool: "turborepo", packages: [] };
  else if (has("go.work")) monorepo = { tool: "go workspace", packages: [] };
  if (monorepo || pkgFiles.length > 1) {
    monorepo = monorepo ?? { tool: "multiple package.json", packages: [] };
    monorepo.packages = pkgFiles.filter((f) => f !== "package.json").map((f) => dirname(f)).slice(0, 200);
  }

  // --- Python / Go / Rust / JVM / Ruby / .NET -----------------------------
  if (files.some((f) => /(^|\/)(pyproject\.toml|setup\.py|setup\.cfg|requirements[^/]*\.txt|Pipfile)$/.test(f))) {
    languages.add("python");
    const py = files.filter((f) => /(^|\/)(pyproject\.toml|requirements[^/]*\.txt|setup\.cfg|tox\.ini)$/.test(f)).map((f) => readTextFile(join(root, f)) ?? "").join("\n");
    if (/\bpytest\b/.test(py) || files.some((f) => /(^|\/)(conftest\.py|pytest\.ini)$/.test(f))) tests.add("pytest");
    else if (files.some((f) => /(^|\/)test_[^/]+\.py$/.test(f))) tests.add("unittest (inferred from test_*.py)");
    if (has("uv.lock")) pms.add("uv");
    if (has("poetry.lock")) pms.add("poetry");
  }
  if (files.some((f) => basename(f) === "go.mod")) {
    languages.add("go");
    tests.add("go test");
  }
  if (files.some((f) => basename(f) === "Cargo.toml")) {
    languages.add("rust");
    tests.add("cargo test");
  }
  if (files.some((f) => /(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/.test(f))) languages.add("jvm");
  if (files.some((f) => basename(f) === "Gemfile")) languages.add("ruby");
  if (files.some((f) => /\.(csproj|sln)$/.test(f))) languages.add("dotnet");
  if (files.some((f) => /(^|\/)CMakeLists\.txt$/.test(f) || /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(f))) {
    languages.add(files.some((f) => /\.(cc|cpp|cxx|hh|hpp|hxx)$/.test(f) || /(^|\/)CMakeLists\.txt$/.test(f)) ? "c/c++" : "c");
    const cmake = files.filter((f) => /(^|\/)CMakeLists\.txt$/.test(f)).map((f) => readTextFile(join(root, f)) ?? "").join("\n");
    if (/\b(enable_testing|add_test|include\(CTest\))\b/i.test(cmake)) tests.add("ctest");
    if (/\b(gtest|GTest|googletest)\b/.test(cmake)) tests.add("googletest");
    if (/\bCatch2\b/.test(cmake)) tests.add("catch2");
  }
  if (has("composer.json")) languages.add("php");
  if (has("Package.swift")) languages.add("swift");
  if (has("mix.exs")) languages.add("elixir");
  if (has("pubspec.yaml")) languages.add("dart");

  // --- Makefile targets ------------------------------------------------------
  if (has("Makefile")) {
    const mk = readTextFile(join(root, "Makefile")) ?? "";
    for (const m of mk.matchAll(/^([a-zA-Z][\w-]*):(?!=)/gm)) {
      if (["build", "test", "lint", "check", "fmt", "typecheck"].includes(m[1])) commands.push({ name: m[1], command: `make ${m[1]}`, source: "Makefile" });
    }
  }

  // --- Repos with no package manifest: take the commands their own CI and build scripts run ------
  if (!commands.length) {
    for (const f of files.filter((x) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(x)).slice(0, 10)) {
      for (const cmd of ciRunLines(readTextFile(join(root, f)) ?? "")) {
        if (/\b(pytest|unittest|ctest|cargo test|go test|make\s+(test|check|lint|build)|(test|check)[\w-]*\.(py|sh)|(build|test)\.sh)\b/.test(cmd) && !/\b(install|apt-get|pip)\b/.test(cmd) && commands.length < 80 && !commands.some((c) => c.command === cmd)) {
          commands.push({ name: /test|check/.test(cmd) ? "test" : "build", command: cmd, source: f });
        }
      }
    }
    // `python3 tests/test_a.py`, `python3 tests/test_b.py`, … read as one command with a placeholder.
    const groups = new Map<string, typeof commands>();
    for (const c of commands) {
      const m = c.command.match(/^(.*?)([\w./-]+\/)([\w-]+)(\.\w+)(.*)$/);
      const key = m ? `${m[1]}\0${m[2]}\0${m[4]}\0${m[5]}` : `\0${c.command}`;
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    commands.length = 0;
    for (const [key, cs] of groups) {
      if (cs.length < 3) commands.push(...cs);
      else {
        const [pre, dir, ext, post] = key.split("\0");
        commands.push({ name: cs[0].name, command: `${pre}${dir}<name>${ext}${post} (${cs.length} files: ${cs.map((c) => c.command.match(/([\w-]+)\.\w+(?=\S*$|\s)/)?.[1]).filter(Boolean).slice(0, 3).join(", ")}…)`, source: cs[0].source });
      }
    }
    for (const f of files.filter((x) => /(^|\/)(build|test|check|lint)\.sh$/.test(x) && x.split("/").length <= 3)) {
      if (!commands.some((c) => c.command.includes(f))) commands.push({ name: basename(f, ".sh"), command: `./${f}`, source: f });
    }
  }

  const topLevelDirs = [...new Set(files.filter((f) => f.includes("/")).map((f) => f.split("/")[0]))].sort();
  const entryPoints = files.filter((f) => ENTRY.test(f) && f.split("/").length <= 4).slice(0, 50);
  const existingContextFiles = files.filter((f) => CONTEXT_FILES.includes(f) || isContextFile(f) || f.startsWith(".cursor/rules/")).slice(0, 100);
  const ci = files.filter((f) => CI.test(f));

  const isRepo = git(["rev-parse", "--is-inside-work-tree"], root).ok;
  const docPaths = files.filter((f) => /\.mdx?$/.test(f) && (/^(docs?|design|adr|rfcs?|architecture)\//i.test(f) || !f.includes("/"))).slice(0, 200);
  const docs = docPaths.map((p) => {
    const r = isRepo ? git(["log", "-1", "--format=%cs", "--", p], root) : { ok: false, stdout: "" };
    return { path: p, lastCommit: r.ok && r.stdout ? r.stdout : null };
  });

  let branch: string | null = null;
  let recentCommits: string[] = [];
  if (isRepo) {
    try {
      branch = defaultBranch(root);
    } catch {
      branch = null;
    }
    const log = git(["log", "-30", "--format=%h %s"], root);
    recentCommits = log.ok && log.stdout ? log.stdout.split("\n") : [];
  }

  const secretSuspects = scanRiskSurfaces(root, { maxFiles: opts.maxFiles })
    .surfaces.filter((s) => s.type === "secret")
    .map((s) => ({ path: s.path, detail: s.detail + (s.lines ? ` (lines ${s.lines.join(", ")})` : "") }));

  return {
    root,
    languages: [...languages].sort(),
    packageManagers: [...pms].sort(),
    monorepo,
    testFrameworks: [...tests].sort(),
    commands,
    topLevelDirs,
    entryPoints,
    existingContextFiles,
    docs,
    ci,
    git: { defaultBranch: branch, recentCommits, isRepo },
    secretSuspects,
    truncated,
  };
}
