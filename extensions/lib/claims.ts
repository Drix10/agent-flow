/**
 * Doc claims beyond paths: the commands an AGENTS.md tells an agent to run, its relative links and the commits it
 * cites. Checked with no dependency and no network, and conservative on purpose: a claim that can't be resolved
 * statically (a workspace flag, a `cd`, a variable, a shallow clone) is skipped, never guessed. A false alarm trains
 * people to ignore `doctor`.
 */

import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { existsExact, toPosix } from "./fsutil.js";
import { git } from "./git.js";

export interface ClaimIssue {
  kind: "command" | "link" | "commit";
  line: number;
  /** The command, link target or SHA as written. */
  text: string;
  reason: string;
  suggestion?: string;
}

const IGNORE_MARKER = "agent-flow:ignore-refs";

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/** The one candidate clearly closest to `name` (typo, or one contains the other), else undefined. */
export function didYouMean(name: string, candidates: string[]): string | undefined {
  const scored = candidates
    .map((c) => ({ c, d: editDistance(name, c), sub: c.includes(name) || name.includes(c) }))
    .filter((x) => x.d <= 2 || x.sub)
    .sort((a, b) => a.d - b.d);
  if (!scored.length) {
    // Same namespace, one candidate: `test:unit` when only `test:ci` exists.
    const ns = name.includes(":") ? name.split(":")[0] : null;
    const family = ns ? candidates.filter((c) => c === ns || c.startsWith(`${ns}:`)) : [];
    return family.length === 1 ? family[0] : undefined;
  }
  if (scored.length > 1 && scored[0].d === scored[1].d && !(scored[0].sub && !scored[1].sub)) return undefined;
  return scored[0].c;
}

/** Nearest file called one of `names`, from `fromDir` up to the repo root. */
function findUp(root: string, fromDir: string, names: string[]): string | null {
  let dir = fromDir === "." ? "" : fromDir;
  for (;;) {
    for (const n of names) {
      const rel = dir ? `${dir}/${n}` : n;
      if (existsExact(root, rel)) return rel;
    }
    if (!dir) return null;
    const up = posix.dirname(dir);
    dir = up === "." ? "" : up;
  }
}

function readSafe(root: string, rel: string): string | null {
  try {
    return readFileSync(join(root, rel), "utf-8");
  } catch {
    return null;
  }
}

function packageScripts(root: string, fromDir: string): string[] | null {
  const pkg = findUp(root, fromDir, ["package.json"]);
  if (!pkg) return null;
  try {
    const j = JSON.parse(readSafe(root, pkg) ?? "");
    return j && typeof j.scripts === "object" && j.scripts ? Object.keys(j.scripts) : [];
  } catch {
    return null;
  }
}

/** Targets a Makefile declares, or null when it can't be judged (pattern rules, includes, computed names). */
export function makeTargets(text: string): Set<string> | null {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (/^(-?include|sinclude)\b/.test(line)) return null;
    if (/^[\t ]/.test(line) || /^\s*#/.test(line)) continue;
    const m = /^([^:=#]+?)\s*:(?![=:])/.exec(line) ?? /^([^:=#]+?)\s*::(?!=)/.exec(line);
    if (!m) continue;
    const isPhony = /^\.PHONY$/.test(m[1].trim());
    const rest = isPhony ? line.slice(line.indexOf(":") + 1).split("#")[0] : m[1];
    for (const t of rest.trim().split(/\s+/)) {
      if (!t) continue;
      if (/[%$*?\[]/.test(t)) return null;
      if (isPhony || !t.startsWith(".")) out.add(t);
    }
  }
  return out;
}

/** Recipes a justfile declares (plus aliases), or null when it imports other files. */
export function justRecipes(text: string): Set<string> | null {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (/^(import|mod)\b/.test(line)) return null;
    const al = /^alias\s+([\w-]+)\s*:=/.exec(line);
    if (al) {
      out.add(al[1]);
      continue;
    }
    if (/^[\s#\[]/.test(line) || /^(set|export|alias)\b/.test(line)) continue;
    const m = /^@?([A-Za-z_][\w-]*)\b[^:\n]*:(?!=)/.exec(line);
    if (m) out.add(m[1]);
  }
  return out;
}

const NAME = /^[\w:.\-@/]+$/;
const SKIP_FLAGS = /^(-w|--workspaces?|--workspace=.*|--prefix|--prefix=.*|-C|--cwd|--cwd=.*|--filter|-F|--dir|-r|--recursive|-f|--file|--justfile|--directory|--working-directory|-d)$/;

interface Ctx {
  root: string;
  fromDir: string;
  scripts: string[] | null | undefined;
  make: Set<string> | null | undefined;
  just: Set<string> | null | undefined;
}

function checkSegment(tokens: string[], ctx: Ctx): { reason: string; suggestion?: string } | null {
  while (tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1);
  const bin = tokens[0];
  if (!bin) return null;
  if (tokens.some((t) => SKIP_FLAGS.test(t) || /^-C./.test(t) || /^-f./.test(t))) return null;

  if (bin === "npm" || bin === "pnpm" || bin === "yarn" || bin === "bun") {
    let script: string | undefined;
    if (tokens[1] === "run" || tokens[1] === "run-script") script = tokens.slice(2).find((t) => !t.startsWith("-"));
    else if (bin === "npm" && (tokens[1] === "test" || tokens[1] === "t" || tokens[1] === "tst")) script = "test";
    else return null;
    if (!script || !NAME.test(script) || script.includes("/") || (bin === "npm" && script === "env")) return null;
    ctx.scripts ??= packageScripts(ctx.root, ctx.fromDir);
    if (!ctx.scripts || ctx.scripts.includes(script)) return null;
    const suggestion = didYouMean(script, ctx.scripts);
    // `yarn run tsc` / `bun run x.ts` also run binaries and files, so only claim what can't be one of those.
    if ((bin === "yarn" || bin === "bun") && !script.includes(":") && !suggestion) return null;
    return { reason: "no such script in package.json", suggestion };
  }

  if (bin === "make" || bin === "gmake") {
    const valueFlags = new Set(["-j", "-l", "-I", "-o", "-W", "-O", "--jobs", "--load-average", "--include-dir", "--old-file", "--what-if"]);
    const targets: string[] = [];
    for (let k = 1; k < tokens.length; k++) {
      const t = tokens[k];
      if (valueFlags.has(t)) k++; // `-j 4`: the 4 isn't a target
      else if (!t.startsWith("-") && !t.includes("=") && !/^\d+$/.test(t)) targets.push(t);
    }
    if (!targets.length || targets.some((t) => /[$<>{}.*\/]/.test(t))) return null;
    if (ctx.make === undefined) {
      const f = findUp(ctx.root, ctx.fromDir, ["Makefile", "makefile", "GNUmakefile"]);
      ctx.make = f ? makeTargets(readSafe(ctx.root, f) ?? "") : null;
    }
    if (!ctx.make) return null;
    const bad = targets.find((t) => !ctx.make!.has(t));
    return bad ? { reason: `no such make target: ${bad}`, suggestion: didYouMean(bad, [...ctx.make]) } : null;
  }

  if (bin === "just") {
    const recipe = tokens[1];
    if (!recipe || recipe.startsWith("-") || !/^[A-Za-z_][\w-]*$/.test(recipe)) return null;
    if (ctx.just === undefined) {
      const f = findUp(ctx.root, ctx.fromDir, ["justfile", "Justfile", ".justfile"]);
      ctx.just = f ? justRecipes(readSafe(ctx.root, f) ?? "") : null;
    }
    if (!ctx.just || ctx.just.has(recipe)) return null;
    return { reason: `no such just recipe: ${recipe}`, suggestion: didYouMean(recipe, [...ctx.just]) };
  }
  return null;
}

let shallowCache: Map<string, boolean> | undefined;
function commitResolvable(root: string, sha: string): boolean | null {
  shallowCache ??= new Map();
  if (!shallowCache.has(root)) {
    const inside = git(["rev-parse", "--is-inside-work-tree"], root, 10_000);
    const shallow = git(["rev-parse", "--is-shallow-repository"], root, 10_000);
    shallowCache.set(root, !(inside.ok && inside.stdout === "true") || shallow.stdout === "true");
  }
  if (shallowCache.get(root)) return null; // can't tell: not a repo, or history is truncated
  return git(["cat-file", "-e", `${sha}^{commit}`], root, 10_000).ok;
}

/** Check one context file's commands, relative links and cited commits. */
export function checkClaims(root: string, cfPath: string, content: string): ClaimIssue[] {
  const issues: ClaimIssue[] = [];
  const cfDir = toPosix(dirname(cfPath)).replace(/^\.$/, "");
  // A context file inside a fixture or example is sample content for some other project, not this repo's commands.
  const sample = /(^|\/)(tests?|__tests__|fixtures?|__fixtures__|testdata|examples?)\//.test(cfPath);
  const ctx: Ctx = { root, fromDir: cfDir, scripts: undefined, make: undefined, just: undefined };
  let inFence = false;
  let cdSeen = false;

  const commandsIn = (text: string, line: number) => {
    const segs = text.replace(/^\s*(\$|>)\s+/, "").split(/&&|\|\||;|\|/);
    for (const raw of segs) {
      const tokens = raw.trim().split(/\s+/).filter(Boolean);
      if (!tokens.length) continue;
      if (tokens[0] === "cd" || tokens[0] === "pushd") {
        cdSeen = true;
        continue;
      }
      if (cdSeen || sample) continue; // the working directory changed; where the command runs is unknown
      if (tokens.some((t) => /[<>{}]|\$|\.\.\./.test(t) || t.includes("`"))) continue;
      const bad = checkSegment(tokens, ctx);
      if (bad) issues.push({ kind: "command", line, text: tokens.join(" "), ...bad });
    }
  };

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      cdSeen = false;
      continue;
    }
    if (line.includes(IGNORE_MARKER)) continue;
    if (inFence) {
      commandsIn(line, i + 1);
      continue;
    }
    cdSeen = false;
    for (const m of line.matchAll(/`([^`]+)`/g)) commandsIn(m[1], i + 1);

    const prose = line.replace(/`[^`]*`/g, (s) => " ".repeat(s.length));
    for (const m of prose.matchAll(/(?<![\w\]])!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      let t = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("#") || t.startsWith("//") || /[{}<>$*]/.test(t)) continue;
      t = t.replace(/[#?].*$/, "");
      try {
        t = decodeURIComponent(t);
      } catch {
        /* leave as written */
      }
      if (!t || !/[/.]/.test(t)) continue; // `[1](2)`, `arr[0](y)`: not a link to a file
      const target = t.startsWith("/") ? t.slice(1) : posix.normalize(cfDir ? `${cfDir}/${t}` : t);
      if (target.startsWith("../") || target === "..") continue; // outside the repo: not this check's business
      if (!existsExact(root, target)) issues.push({ kind: "link", line: i + 1, text: m[1], reason: "link target does not exist" });
    }

    // Only a hex string presented as a commit is a claim; a bare hash may be anything.
    for (const m of prose.matchAll(/\b(?:commit|sha|revision)s?\s+([0-9a-f]{7,40})\b/gi)) {
      const sha = m[1];
      if (!(/[0-9]/.test(sha) && /[a-f]/i.test(sha))) continue;
      if (commitResolvable(root, sha) === false) issues.push({ kind: "commit", line: i + 1, text: sha, reason: "no such commit in this repository" });
    }
  }
  return issues;
}
