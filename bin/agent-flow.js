#!/usr/bin/env node
/**
 * agent-flow CLI — the same checks as the Pi tools, for every harness and for CI.
 *
 * Zero runtime dependencies. Never touches the network. Exit codes:
 *   0 = ok   1 = check failed   2 = usage / environment error
 */

import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const lib = (m) => import(new URL(`../extensions/lib/${m}.js`, import.meta.url).href);

let fsutil, manifestLib, stale, risk, state, classify, worktree, git, scan, guardLib, report, initLib, mergeLib;
try {
  [fsutil, manifestLib, stale, risk, state, classify, worktree, git, scan, guardLib, report, initLib, mergeLib] = await Promise.all(
    ["fsutil", "manifest", "stale", "risk", "state", "classify", "worktree", "git", "scan", "guard", "report", "init", "merge"].map(lib),
  );
} catch (e) {
  console.error(`agent-flow: compiled library missing (${e.message}). Run \`npm run build\` in the agent-flow package.`);
  process.exit(2);
}

const VERSION = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8")).version;
const { NO_COLOR, FORCE_COLOR } = process.env;
// NO_COLOR beats FORCE_COLOR beats the TTY check (https://no-color.org, force-color.org).
const color = NO_COLOR ? false : FORCE_COLOR !== undefined && FORCE_COLOR !== "" ? !["0", "false"].includes(FORCE_COLOR) : !!process.stdout.isTTY;
const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const ok = (s) => console.log(`${c(32, "✓")} ${s}`);
const bad = (s) => console.log(`${c(31, "✗")} ${s}`);
const warn = (s) => console.log(`${c(33, "!")} ${s}`);
const dim = (s) => c(2, s);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      // Split on the FIRST "=" only: `--reason=a=b` means "a=b".
      // split("=", 2) truncated the value at the second "=".
      const eq = a.indexOf("=");
      if (eq === -1) {
        const k = a.slice(2);
        if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) args[k] = argv[++i];
        else args[k] = true;
      } else {
        args[a.slice(2, eq)] = a.slice(eq + 1);
      }
    } else args._.push(a);
  }
  return args;
}

const BOOL_FLAGS = new Set(["check", "json", "no-prose", "ctxlint", "fail-on-new", "include-tests", "all", "yes", "fail-on-protected", "fail-on-critical", "reopen", "force", "delete-branch", "dry-run", "help", "strict"]);
function fixBools(args) {
  // `--json doctor` would otherwise swallow the next word as the flag's value.
  for (const k of Object.keys(args)) {
    if (BOOL_FLAGS.has(k) && typeof args[k] === "string") {
      args._.push(args[k]);
      args[k] = true;
    }
  }
  return args;
}

const VALUE_FLAGS = ["manifest", "baseline", "base", "head", "issue", "state", "phase", "round", "reason", "dir", "out", "harness", "exit", "seconds", "model", "argv-file"];
const KNOWN_FLAGS = new Set([...BOOL_FLAGS, ...VALUE_FLAGS, "version"]);

/** Closest candidate within edit distance 2, or null. */
function didYouMean(word, candidates) {
  let best = null;
  let bestD = 3;
  for (const c of candidates) {
    const d = stale.editDistance(String(word).toLowerCase(), c.toLowerCase(), 2);
    if (d < bestD) [best, bestD] = [c, d];
  }
  return best;
}

function unknown(what, word, candidates, hint) {
  const guess = didYouMean(word, candidates);
  console.error(`agent-flow: unknown ${what} "${word}"${guess ? ` — did you mean "${guess}"?` : ""}`);
  console.error(dim(`  ${hint}`));
  return 2;
}

const HELP = `agent-flow ${VERSION} — context drift detection + guarded agent pipeline

Usage: agent-flow <command> [options]

Start here (no setup needed):
  doctor                    Check every path your AGENTS.md / CLAUDE.md / .cursorrules / … mention
  init [--yes] [--dry-run]  Write a starter CONTEXT_MANIFEST.json (+ AGENTS.md if missing) from a scan

Checks (CI-safe, read-only):
  doctor                    Context files vs the filesystem; with a manifest, also staleness
      --manifest <path>     Manifest path (default CONTEXT_MANIFEST.json)
      --no-prose            Skip checking \`backticked/paths\` inside context files
      --ctxlint             Also run a locally installed ctxlint (never downloads)
  audit-risk                Diff risk surfaces against .risk-baseline.json
      --baseline <path>  --include-tests  --fail-on-new
  classify                  Mechanical risk level of a diff (vs the merge-base, so later commits on the base don't count)
      --base <rev> --head <rev> --issue <n>  --fail-on-protected  --fail-on-critical
  check-staged              Pre-commit gate: protected paths, secrets, broken context refs
  scan                      Read-only repo reconnaissance (what /bootstrap sees)

Pipeline (the CLI twin of the Pi tools — same rules, any harness):
  state [show] [--issue <n>]  Print pipeline state
  state update --issue <n> --state "Working|Needs Me|Completed" [--phase p] [--round r] [--reason t] [--reopen]
                            Exit 3 when the round cap escalated the issue to Needs Me
  worktree create <n> [--base <branch>] | remove <n> [--force] [--delete-branch] | list
  schema <implementer|reviewer|qa|manifest> [--strict]
                            Print a JSON schema (role report, or CONTEXT_MANIFEST.json); --strict = the
                            OpenAI strict-mode variant for \`codex exec --output-schema\`
  schema --dir <dir>        Write the role-report schemas into <dir>: <role>.schema.json + <role>.strict.schema.json
  template [name]           List the context-file templates, or print one (e.g. AGENTS.md)
  report <implementer|reviewer|qa> <file> [--out <file>]
                            Extract + validate a role's report (claude/gemini/codex/raw output); exit 1 if invalid
      --harness <h> [--model m --exit n --seconds s --argv-file f --issue n --round r]
                            Also append a role_run line (argv, exit, duration, cost/tokens) to .agent-flow/audit.jsonl
  repair --yes              Refresh manifest timestamps after the prose was re-verified (Gardener)
  guard                     Claude Code PreToolUse hook: reads the hook JSON on stdin, exit 2 = blocked
  guard --check             Exit 1 unless the Claude Code hook is installed and its target exists

Setup (writes files; run by a human):
  baseline accept --all --yes | baseline accept <key>... --yes
  install --harness <claude|codex|gemini|cursor|copilot|windsurf|agents> [--dry-run] [--force]
  hook install [--force]    Install the pre-commit hook (runs check-staged)

Global: --json for machine output, --help, --version
`;

function out(args, value, human) {
  if (args.json) console.log(JSON.stringify(value, null, 2));
  else human(value);
}

function root() {
  return fsutil.findRepoRoot(process.cwd());
}

/** An expected, user-fixable condition: printed as one line, no stack, no git noise. */
class UserError extends Error {}

function requireRepo(cwd = process.cwd()) {
  if (!git.git(["rev-parse", "--git-dir"], cwd).ok) throw new UserError("not a git repository — run this inside a git checkout (or `git init` first)");
}

function requireCommits(cwd) {
  requireRepo(cwd);
  if (!git.git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], cwd).ok) throw new UserError("no commits yet — make a first commit, then re-run");
}

function issueNumber(raw, usageLine) {
  const n = Number(raw);
  if (raw === undefined || raw === true || !Number.isInteger(n) || n < 1) {
    throw new UserError(raw === undefined || raw === true ? `needs an issue number — usage: agent-flow ${usageLine}` : `"${raw}" is not an issue number — usage: agent-flow ${usageLine}`);
  }
  return n;
}

/** The checkout we're standing in (a linked worktree has its own index and files). */
function checkoutTop() {
  const r = git.git(["rev-parse", "--show-toplevel"], process.cwd());
  return r.ok && r.stdout ? resolve(r.stdout) : root();
}

// ---------------------------------------------------------------------------

const CONTEXT_FILE_NAMES = "AGENTS.md, CLAUDE.md, GEMINI.md, .cursorrules, .cursor/rules/*.mdc, .github/copilot-instructions.md, .windsurfrules";

/** "Show the user the file, not the absolute path twice": strip the path from a loader error. */
function manifestError(rt, error, path) {
  const rel = relative(rt, path) || path;
  const msg = error.split(path).join("").replace(/^invalid JSON in :?\s*/, "").replace(/^cannot read :?\s*/, "cannot read: ").trim();
  if (error.startsWith("invalid JSON")) return `${rel} is not valid JSON (${msg}) — fix it, or delete it and run \`agent-flow init\``;
  return `${rel}: ${msg}`;
}

function cmdDoctor(args) {
  const rt = root();
  const r = stale.detectStale(rt, { manifestPath: args.manifest, prose: !args["no-prose"], ctxlint: !!args.ctxlint, discover: args.manifest === undefined });
  if (!r.ok) {
    out(args, { healthy: false, error: r.error, path: r.path }, () => {
      if (r.error === "manifest_not_found") bad(`manifest not found: ${relative(rt, r.path) || r.path}`);
      else bad(manifestError(rt, r.error, r.path));
    });
    return 2;
  }
  const rep = r.report;
  const none = r.mode === "discovered" && r.context_files.length === 0 && !r.manifest;
  out(args, { healthy: r.healthy, mode: r.mode, context_files: r.context_files, report: rep, manifest: r.manifest, legacy_schema: r.legacy_schema }, () => {
    // A fresh repo isn't broken: nothing to drift yet, so this is a note and exit 0 (CI stays green).
    if (none) {
      warn(`no agent context files found (${CONTEXT_FILE_NAMES})`);
      console.log(dim("  Start one: `agent-flow init` writes a starter AGENTS.md + manifest, or ask your agent to use the bootstrap skill."));
      return;
    }
    const section = (label, items, fmt) => {
      if (items.length === 0) ok(label);
      else {
        bad(`${label} — ${items.length}`);
        const lines = items.slice(0, 25).map(fmt);
        const w = Math.min(40, Math.max(...lines.map((l) => (Array.isArray(l) ? l[0].length : 0))));
        for (const l of lines) console.log(`    ${Array.isArray(l) ? `${l[0].padEnd(w)}  ${l[1]}` : l}`);
        if (items.length > 25) console.log(dim(`    … ${items.length - 25} more (use --json)`));
      }
    };
    const discovered = r.mode === "discovered";
    // Placeholder and timestamp problems have their own sections below; don't list them twice.
    const schema = rep.schema_problems.filter((p) => !/unfilled template placeholder|not a valid ISO timestamp/.test(p));
    if (r.manifest) section("manifest schema", schema, (p) => p);
    if (discovered && !r.context_files.length) warn(`no agent context files found (${CONTEXT_FILE_NAMES})`);
    else if (discovered) ok(`context files found: ${r.context_files.length > 4 ? `${r.context_files.slice(0, 4).join(", ")}, … ${r.context_files.length - 4} more` : r.context_files.join(", ")}`);
    else section("context files exist", rep.missing_context_files, (p) => p);
    const lineOf = proseLines(rt);
    section("referenced paths exist", rep.missing_paths, (m) => [
      `${m.file}${m.source === "prose" && lineOf(m.file, m.path) ? `:${lineOf(m.file, m.path)}` : ""}`,
      `${m.path}${discovered ? "" : dim(` (${m.source})`)}${m.suggestion ? `  → did you mean ${c(1, m.suggestion)}?` : ""}`,
    ]);
    if (!discovered) {
      section("timestamps valid", rep.invalid_timestamps, (m) => [`${m.file}: ${m.path}`, `→ ${JSON.stringify(m.value)}`]);
      section("verified within threshold", rep.stale_files, (p) => `${p} [STALE]`);
    }
    section("no unfilled placeholders", rep.unfilled_placeholders, (m) => [`${m.file}:${m.line}`, m.text]);
    if (rep.ctxlint !== "not_requested") (rep.ctxlint === "ran" ? ok : warn)(`ctxlint: ${rep.ctxlint}`);
    if (rep.ctxlint === "ran") section("no dead commands", rep.dead_commands, (m) => `${m.file}: ${m.command}`);
    if (discovered) console.log(dim(`note: ${r.manifest ? "the manifest lists no context files" : "no CONTEXT_MANIFEST.json"}, so only paths were checked — \`agent-flow init\` adds staleness tracking`));
    console.log(r.healthy ? c(32, "\nhealthy") : `\n${c(31, "unhealthy")} — ${doctorNextStep(rep, schema)}`);
  });
  return none || r.healthy ? 0 : 1;
}

/** Line of a prose reference, so the user can jump to it. Each context file is parsed once. */
function proseLines(rt) {
  const cache = new Map();
  return (file, path) => {
    if (!cache.has(file)) cache.set(file, stale.extractProseRefs(fsutil.readTextFile(join(rt, file)) ?? ""));
    return cache.get(file).find((r) => r.path === path)?.line;
  };
}

/** One next step, for whichever problem the user should fix first. */
function doctorNextStep(rep, schema) {
  if (rep.unfilled_placeholders.length && !rep.missing_paths.length) {
    return "fill in the {{PLACEHOLDERS}} above (for a manifest, `agent-flow init` generates a filled one), then re-run `agent-flow doctor`";
  }
  if (rep.missing_paths.length || rep.missing_context_files.length) {
    return "fix the references above (or ask your agent to use the gardener skill's /repair-docs procedure), then re-run `agent-flow doctor`";
  }
  if (schema.length) return "fix CONTEXT_MANIFEST.json (`agent-flow schema manifest` prints the schema)";
  return "re-read the stale files against the code, then `agent-flow repair --yes` to refresh their timestamps";
}

const KIND_ORDER = ["secret", "payment", "auth", "exec", "data-mutation", "external-api", "dependency"];

/** Surfaces as aligned rows: kind, file[:line], detail. Secret rows carry kind + line, never the value. */
function surfaceRows(list, { group, keys }) {
  const rows = [];
  const sorted = [...list].sort((a, b) => KIND_ORDER.indexOf(a.type) - KIND_ORDER.indexOf(b.type) || a.path.localeCompare(b.path));
  if (group) {
    // One row per (kind, manifest) for dependencies — 80 packages shouldn't be 80 lines.
    const deps = new Map();
    for (const s of sorted) {
      const dep = s.detail.match(/^Dependency: (.+)$/)?.[1];
      if (!dep) {
        rows.push(s);
        continue;
      }
      const k = `${s.type}\0${s.path}`;
      if (!deps.has(k)) rows.push(deps.set(k, { type: s.type, path: s.path, names: [] }).get(k));
      deps.get(k).names.push(dep);
    }
  } else rows.push(...sorted);
  const where = (s) => `${s.path}${s.lines ? `:${s.lines.join(",")}` : ""}`;
  const what = (s) => {
    if (s.names) return s.names.length > 8 ? `${s.names.slice(0, 8).join(", ")} +${s.names.length - 8} more` : s.names.join(", ");
    if (s.type === "secret") return s.detail.replace(/^Possible /, "").replace(/ \(value redacted\)$/, "");
    return s.detail.endsWith(" pattern") ? "" : s.detail.replace(/^Dependency: /, "");
  };
  const w = Math.min(48, Math.max(0, ...rows.map((s) => where(s).length)));
  return rows.map((s) => `    ${s.type.padEnd(13)} ${where(s).padEnd(w)}  ${what(s)}${keys && s.key ? `  ${dim(s.key)}` : ""}`.trimEnd());
}

function cmdAudit(args) {
  const rt = root();
  const baseline = fsutil.resolveInside(rt, args.baseline ?? risk.BASELINE_FILE);
  const r = risk.auditRisk(rt, baseline, { includeTests: !!args["include-tests"] });
  const surfaces = r.surfaces;
  const failNoBaseline = !!args["fail-on-new"] && !r.baselineExists;
  out(args, r, () => {
    const files = new Set(surfaces.map((s) => s.path)).size;
    console.log(`${r.totalSurfaces} risk surface${r.totalSurfaces === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"} ${dim(`(${r.scannedFiles} scanned)`)}${r.truncated ? c(33, " (truncated)") : ""}`);
    if (!r.baselineExists) {
      const rows = surfaceRows(surfaces, { group: true, keys: false });
      for (const l of rows.slice(0, 40)) console.log(l);
      if (rows.length > 40) console.log(dim(`    … ${rows.length - 40} more (use --json)`));
      if (failNoBaseline) bad("--fail-on-new has no baseline to compare against, so it would check nothing");
      else warn("no baseline yet");
      console.log(dim("  Review the list above, then `agent-flow baseline accept --all --yes` and commit .risk-baseline.json."));
    } else if (r.newSurfaces === 0) ok("no new risk surfaces since baseline");
    else {
      bad(`${r.newSurfaces} new risk surface(s):`);
      for (const l of surfaceRows(r.newSurfacesList, { group: false, keys: true }).slice(0, 50)) console.log(l);
      console.log(dim("  Accept after review: `agent-flow baseline accept <key>... --yes`"));
    }
    if (r.resolvedSurfaces) console.log(dim(`${r.resolvedSurfaces} baseline surface(s) no longer present`));
  });
  if (failNoBaseline) return 1;
  if (args["fail-on-new"] && r.newSurfaces > 0) return 1;
  return 0;
}

function cmdBaseline(args) {
  if (args._[1] !== "accept") return sub("baseline", args._[1], ["accept"], "baseline accept --all --yes | baseline accept <key>... --yes");
  if (!args.yes) return usage("baseline accept writes .risk-baseline.json — re-run with --yes after reviewing `agent-flow audit-risk`");
  const keys = args.all ? undefined : args._.slice(2);
  if (keys && keys.length === 0) return usage("pass --all or one or more surface keys");
  const rt = root();
  const r = risk.updateBaseline(rt, fsutil.resolveInside(rt, args.baseline ?? risk.BASELINE_FILE), keys);
  state.appendAudit(rt, { event: "risk_baseline_update", via: "cli", count: r.count });
  out(args, r, () => ok(`baseline: ${r.count} surfaces accepted (${r.stillUnaccepted} still unaccepted)`));
  return 0;
}

function cmdClassify(args) {
  const rt = root();
  let cwd = process.cwd();
  if (args.issue !== undefined) {
    const n = issueNumber(args.issue, "classify --issue <n>");
    cwd = fsutil.resolveInside(rt, worktree.worktreeRel(n));
    if (!existsSync(cwd)) throw new UserError(`no worktree for issue #${n} (${worktree.worktreeRel(n)}) — create it with \`agent-flow worktree create ${n}\``);
  }
  requireCommits(cwd);
  for (const flag of ["base", "head"]) {
    if (args[flag] === undefined) continue;
    if (typeof args[flag] !== "string") throw new UserError(`--${flag} needs a branch or commit`);
    git.validateRevision(args[flag]);
    if (!git.git(["rev-parse", "--verify", "--quiet", `${args[flag]}^{commit}`], cwd).ok) {
      throw new UserError(`--${flag} "${args[flag]}": no such branch, tag or commit here (\`git branch -a\` lists them)`);
    }
  }
  let r;
  try {
    r = classify.classifyDiff(cwd, rt, manifestLib.tryLoadManifest(rt), args.base, args.head);
  } catch (e) {
    if (/cannot determine a default branch/.test(e.message)) throw new UserError("can't tell which branch to diff against — pass --base <branch>");
    throw e;
  }
  out(args, r, () => {
    const col = r.risk_level === "critical" ? 31 : r.risk_level === "medium" ? 33 : 32;
    console.log(`risk: ${c(col, r.risk_level)}  reviewer: ${r.reviewer_tier}  human approval: ${r.human_approval_required ? "required" : "no"}  ${dim(`${r.files.length} files vs ${r.base}`)}`);
    for (const reason of r.reasons) console.log(`  - ${reason}`);
    if (r.protected_violations.length) bad(`protected paths touched: ${r.protected_violations.join(", ")}`);
  });
  if (args["fail-on-protected"] && r.protected_violations.length) return 1;
  if (args["fail-on-critical"] && r.risk_level === "critical") return 1;
  return 0;
}

function cmdCheckStaged(args) {
  // Inside .worktrees/issue-N the hook must check THAT worktree's index and files,
  // not the main checkout's.
  requireRepo();
  const rt = checkoutTop();
  const files = git.stagedFiles(rt);
  const man = manifestLib.tryLoadManifest(rt);
  const problems = [];

  // Protected paths come from the committed AND the staged manifest, not just the
  // working tree: otherwise emptying protected_paths on disk (without staging it)
  // or deleting the manifest would quietly switch the check off for this commit.
  const protectedPaths = new Set(manifestLib.protectedPathsOf(man));
  for (const rev of ["HEAD", ""]) {
    const r = git.git(["show", `${rev}:CONTEXT_MANIFEST.json`], rt);
    if (!r.ok) continue;
    try {
      for (const p of manifestLib.protectedPathsOf(JSON.parse(r.stdout))) protectedPaths.add(p);
    } catch {
      /* malformed manifest is reported by the context checks below */
    }
  }
  if (process.env.AGENT_FLOW_ALLOW_PROTECTED !== "1") {
    for (const f of files) {
      const hit = manifestLib.matchAny([...protectedPaths], f);
      if (hit) problems.push(`protected path staged: ${f} (${hit}) — set AGENT_FLOW_ALLOW_PROTECTED=1 if a human intends this`);
    }
  }
  for (const f of files) {
    if (risk.isEnvFile(f) && git.git(["cat-file", "-e", `:${f}`], rt).ok) {
      problems.push(`environment file staged: ${f} — keep secrets out of git (commit a .env.example instead)`);
    }
  }
  const secretIgnore = manifestLib.secretIgnorePaths(man);
  const blobs = git.stagedBlobs(rt, files.filter((f) => !manifestLib.matchAny(secretIgnore, f)));
  for (const [f, blob] of blobs) {
    if (!blob || blob.subarray(0, 8000).includes(0)) continue; // deleted, huge or binary
    for (const s of risk.findSecrets(blob.toString("utf-8"))) problems.push(`possible ${s.kind} in ${f} line(s) ${s.lines.join(", ")} (value not shown; if it is a fake, put \`${risk.ALLOW_SECRET_MARKER}\` on or above the line, or list the file in secret_scan.ignore_paths)`);
  }
  // Context drift: fail only on drift THIS commit introduces (it deletes/renames a
  // referenced path, or edits a context file that is broken). Pre-existing drift is
  // a warning — blocking every unrelated commit on it teaches people --no-verify.
  const warnings = [];
  if (man) {
    const deleted = new Set(
      git.nameList(["diff", "--cached", "--name-only", "--no-renames", "--diff-filter=D"], rt),
    );
    const staged = new Set(files);
    const introduced = (ctxFile, path) =>
      staged.has(ctxFile) || staged.has("CONTEXT_MANIFEST.json") || [...deleted].some((d) => d === path || d.startsWith(`${path.replace(/\/+$/, "")}/`));
    const d = stale.detectStale(rt, { prose: true });
    if (d.ok) {
      for (const p of d.report.schema_problems) (staged.has("CONTEXT_MANIFEST.json") ? problems : warnings).push(`manifest: ${p}`);
      for (const p of d.report.missing_context_files) (deleted.has(p) || staged.has("CONTEXT_MANIFEST.json") ? problems : warnings).push(`context file missing: ${p}`);
      for (const m of d.report.missing_paths) (introduced(m.file, m.path) ? problems : warnings).push(`broken reference in ${m.file}: ${m.path}`);
    } else (staged.has("CONTEXT_MANIFEST.json") ? problems : warnings).push(`manifest: ${d.error}`);
  }
  out(args, { ok: problems.length === 0, files: files.length, problems, warnings }, () => {
    for (const w of warnings) warn(`pre-existing: ${w}`);
    if (warnings.length) console.log(dim("  (not blocking — this commit didn't cause them; run `agent-flow doctor`)"));
    if (!problems.length) return ok(`agent-flow: ${files.length} staged file(s) pass`);
    bad("agent-flow pre-commit check failed:");
    for (const p of problems) console.log(`    ${p}`);
    console.log(dim("  Fix the problems above. (Humans can bypass with --no-verify; agents are blocked from doing so.)"));
  });
  return problems.length ? 1 : 0;
}

/** A bare `--round` parses as `true` and `Number(true)` is 1 — reject it instead of recording round 1. */
function roundNumber(raw) {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 0) throw new UserError(`--round needs a non-negative integer, got ${raw === true ? "nothing" : `"${raw}"`}`);
  return n;
}

function cmdState(args) {
  const rt = root();
  const sub = args._[1] ?? "show";
  if (sub === "show") {
    const s = state.readState(rt);
    if (args.issue !== undefined) {
      // A bare `--issue` parses as `true`; Number(true) is 1, which silently
      // showed issue #1. Validate like every other issue-taking command.
      const n = issueNumber(args.issue, "state show --issue <n>");
      const one = s.sessions.find((x) => x.issue === n) ?? null;
      const limit = manifestLib.maxReviewRounds(manifestLib.tryLoadManifest(rt));
      const view = { issue: n, state: one?.state ?? null, phase: one?.phase ?? null, round: one?.round ?? 0, max_review_rounds: limit, reason: one?.reason ?? null };
      out(args, view, () => console.log(one ? `issue #${n}: ${one.state}${one.phase ? ` / ${one.phase}` : ""} (round ${one.round ?? 0} of ${limit})${one.reason ? ` — ${one.reason}` : ""}` : `issue #${n}: no state yet (round limit ${limit})`));
      return 0;
    }
    out(args, s, () => process.stdout.write(state.renderMarkdown(s)));
    return 0;
  }
  if (sub === "update") {
    const p = {
      issue: issueNumber(args.issue, "state update --issue <n> --state <s>"),
      state: args.state,
      phase: typeof args.phase === "string" ? args.phase : undefined,
      round: args.round === undefined ? undefined : roundNumber(args.round),
      reason: typeof args.reason === "string" ? args.reason : undefined,
      reopen: !!args.reopen,
    };
    const r = state.updateState(rt, p, manifestLib.maxReviewRounds(manifestLib.tryLoadManifest(rt)));
    out(args, r, () => (r.escalated ? warn : ok)(`issue #${r.updated}: ${r.from ?? "(new)"} → ${r.state} (round ${r.round})${r.reason ? ` — ${r.reason}` : ""}`));
    // Distinct exit code so a script can't miss the escalation by only checking for failure.
    return r.escalated ? 3 : 0;
  }
  return sub("state", args._[1], ["show", "update"], "state [show] | state update --issue <n> --state <s> …");
}

function cmdWorktree(args) {
  const rt = root();
  const s = args._[1];
  requireRepo(rt);
  if (s === "list") {
    const l = worktree.listWorktrees(rt);
    out(args, l, () => (l.length ? l.forEach((w) => console.log(`#${w.issue}  ${w.branch}  ${w.path}`)) : console.log("no agent worktrees")));
    return 0;
  }
  if (s === "create") {
    const n = issueNumber(args._[2], "worktree create <issue-number> [--base <branch>]");
    requireCommits(rt);
    const r = worktree.createWorktree(rt, n, typeof args.base === "string" ? args.base : undefined);
    out(args, r, () => ("error" in r ? bad(`${r.error}: ${r.path}`) : ok(r.message)));
    return "error" in r ? 1 : 0;
  }
  if (s === "remove") {
    const n = issueNumber(args._[2], "worktree remove <issue-number> [--force] [--delete-branch]");
    const r = worktree.removeWorktree(rt, n, { force: !!args.force, deleteBranch: !!args["delete-branch"] });
    out(args, r, () => ("error" in r ? bad(`${r.error}: ${r.path}${r.hint ? ` — ${r.hint}` : ""}`) : ok(`removed ${r.removed}; branch ${r.branch_note}`)));
    return "error" in r ? 1 : 0;
  }
  return sub("worktree", s, ["create", "remove", "list"], "worktree create <n> | remove <n> | list");
}

function cmdScan(args) {
  const r = scan.scanRepo(root());
  out(args, r, () => console.log(JSON.stringify(r, null, 2)));
  return 0;
}

function cmdTemplate(args) {
  const dir = join(pkgRoot, "templates");
  const names = readdirSync(dir).filter((f) => f.endsWith(".template")).map((f) => f.replace(/\.template$/, ""));
  const want = args._[1];
  if (!want) {
    out(args, { templates: names, dir }, () => {
      console.log("Templates (print one with `agent-flow template <name>`):");
      for (const n of names) console.log(`  ${n}`);
    });
    return 0;
  }
  const name = names.find((n) => n.toLowerCase() === String(want).toLowerCase().replace(/\.template$/, ""));
  if (!name) return unknown("template", want, names, `usage: agent-flow template <${names.join("|")}>`);
  process.stdout.write(readFileSync(join(dir, `${name}.template`), "utf-8"));
  return 0;
}

function cmdSchema(args) {
  // `--strict` is a boolean; `schema --strict reviewer` would otherwise read "reviewer" as its value.
  if (typeof args.strict === "string") {
    args._.push(args.strict);
    args.strict = true;
  }
  if (typeof args.dir === "string") {
    // Both variants, always: the canonical one for Claude/validation, the strict one for `codex exec --output-schema`.
    mkdirSync(args.dir, { recursive: true });
    const written = Object.entries(report.REPORT_ROLES).flatMap(([role, file]) => {
      const name = file === "implementer-report" ? "implementer" : file;
      const canonical = report.reportSchema(role);
      return [
        [join(args.dir, `${name}.schema.json`), canonical],
        [join(args.dir, `${name}.strict.schema.json`), report.strictSchema(canonical)],
      ].map(([p, s]) => {
        writeFileSync(p, `${JSON.stringify(s)}\n`);
        return p;
      });
    });
    out(args, { written }, () => written.forEach((p) => ok(`wrote ${p}`)));
    return 0;
  }
  const role = args._[1];
  if (role === "manifest") {
    console.log(readFileSync(join(pkgRoot, "schemas", "context-manifest.schema.json"), "utf-8").trim());
    return 0;
  }
  if (!Object.hasOwn(report.REPORT_ROLES, role)) return usage(`schema <${Object.keys(report.REPORT_ROLES).join("|")}|manifest> [--strict]`);
  // Compact on one line so it can be passed straight to `claude -p --json-schema "$(…)"`.
  const schema = report.reportSchema(role);
  console.log(JSON.stringify(args.strict ? report.strictSchema(schema) : schema));
  return 0;
}

function cmdReport(args) {
  const [, role, file] = args._;
  if (!Object.hasOwn(report.REPORT_ROLES, role) || !file) return usage(`report <${Object.keys(report.REPORT_ROLES).join("|")}> <file> [--out <file>]`);
  // Windows PowerShell 5.1's `>` writes UTF-16LE; decode it rather than failing on "no JSON found".
  const buf = readFileSync(file);
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.subarray(2).toString("utf16le") : buf.toString("utf-8");
  const r = report.checkReport(role, text);
  if (r.ok && typeof args.out === "string") writeFileSync(args.out, `${JSON.stringify(r.report, null, 2)}\n`);
  if (typeof args.harness === "string") auditRoleRun(role, file, args, r);
  if (args.json || (r.ok && typeof args.out !== "string")) {
    console.log(JSON.stringify(args.json ? r : r.report, null, 2));
  } else if (r.ok) ok(`${role} report valid (${r.source}) → ${args.out}`);
  else {
    bad(`${role} report invalid (${r.source}):`);
    for (const p of r.problems) console.log(`    ${p}`);
  }
  const h = r.harness;
  if (!args.json && h && (h.cost_usd !== undefined || h.num_turns !== undefined)) {
    console.log(dim(`    ${h.harness}: ${h.num_turns ?? "?"} turns, $${h.cost_usd ?? "?"}${h.session_id ? `, session ${h.session_id}` : ""}`));
  }
  return r.ok ? 0 : 1;
}

/** One `.agent-flow/audit.jsonl` line per role launch: what ran, how long, what it cost, whether it counted. */
function auditRoleRun(role, file, args, r) {
  const intOr = (v) => (v === undefined || v === true || !Number.isFinite(Number(v)) ? undefined : Number(v));
  let argv;
  if (typeof args["argv-file"] === "string") {
    try {
      argv = readFileSync(args["argv-file"], "utf-8").trim().slice(0, 4000);
    } catch {
      /* the log line matters more than the argv */
    }
  }
  const h = r.harness ?? {};
  state.appendAudit(root(), {
    event: "role_run",
    role,
    issue: intOr(args.issue),
    round: intOr(args.round),
    harness: args.harness,
    model: typeof args.model === "string" ? args.model : null,
    argv,
    exit_code: intOr(args.exit),
    duration_s: intOr(args.seconds),
    raw: file,
    ok: r.ok,
    problems: r.problems.slice(0, 20),
    cost_usd: h.cost_usd,
    num_turns: h.num_turns,
    usage: h.usage,
    session_id: h.session_id,
  });
}

function cmdRepair(args) {
  if (!args.yes) {
    return usage("repair --yes — refreshes every manifest timestamp. Only run it after re-reading the code each flagged claim describes (the gardener skill's /repair-docs procedure).");
  }
  const rt = root();
  if (!existsSync(manifestLib.manifestPathFor(rt, args.manifest))) throw new UserError("no CONTEXT_MANIFEST.json to repair — `agent-flow init` creates one");
  const r = stale.repairStale(rt, { manifestPath: args.manifest });
  state.appendAudit(rt, { event: "stale_repair", via: "cli", refreshed: r.refreshed });
  out(args, r, () => {
    ok(`refreshed ${r.refreshed} reference(s) in ${r.repaired}`);
    for (const m of r.still_missing) warn(`still missing: ${m.file}: ${m.path}`);
  });
  return r.still_missing.length ? 1 : 0;
}

/**
 * Claude Code PreToolUse hook. Same policy as Pi's tool_call hook. Contract:
 * JSON on stdin (tool_name, tool_input, cwd, agent_type for subagents);
 * exit 2 + reason on stderr blocks the call, exit 0 allows it.
 */
/** Is the Claude Code guard hook wired up, and does the file it runs exist? */
function guardCheck(args) {
  const rt = root();
  const path = join(rt, ".claude", "settings.json");
  let command = null;
  try {
    const hooks = JSON.parse(readFileSync(path, "utf-8")).hooks?.PreToolUse ?? [];
    command = hooks.flatMap((e) => e.hooks ?? []).map((h) => h.command ?? "").find((c) => /agent-flow/.test(c) && /\bguard\b/.test(c)) ?? null;
  } catch {
    /* no or unreadable settings */
  }
  const script = command?.match(/"\$CLAUDE_PROJECT_DIR\/([^"]+)"/)?.[1];
  const target = script ? join(rt, script) : null;
  const okay = !!command && (!target || existsSync(target));
  out(args, { ok: okay, settings: path, command, target, target_exists: target ? existsSync(target) : null }, () => {
    if (okay) ok(`Claude Code guard hook active (${command})`);
    else if (!command) bad("no agent-flow guard hook in .claude/settings.json — run `npx @drix10/agent-flow install --harness claude`");
    else bad(`guard hook points at ${target}, which doesn't exist — run \`npm install\` (agent-flow must be in this project's devDependencies)`);
  });
  return okay ? 0 : 1;
}

function cmdGuard(args) {
  if (args.check) return guardCheck(args);
  const fail = (role, msg) => {
    console.error(`[agent-flow guard] ${msg}`);
    return role ? 2 : 0; // a confined role fails closed; an ordinary session is not bricked by a guard bug
  };
  const env = guardLib.parseRole(process.env.AGENT_FLOW_ROLE);
  let ev;
  try {
    ev = JSON.parse(readFileSync(0, "utf-8") || "{}");
  } catch (e) {
    return fail(env.role, `unreadable hook input: ${e.message}`);
  }
  // A subagent launched as one of our roles (e.g. the orchestrator's `reviewer`) runs under that role.
  const role = guardLib.ROLES.includes(ev.agent_type) ? ev.agent_type : env.role;
  try {
    const cwd = typeof ev.cwd === "string" && ev.cwd ? ev.cwd : process.cwd();
    const rt = fsutil.findRepoRoot(cwd);
    const loaded = manifestLib.loadManifestForGuard(rt);
    const decision = guardLib.decide({
      role,
      toolName: String(ev.tool_name ?? ""),
      input: ev.tool_input && typeof ev.tool_input === "object" ? ev.tool_input : {},
      cwd,
      root: rt,
      manifest: loaded.manifest,
      manifestError: loaded.error,
      worktree: process.env.AGENT_FLOW_WORKTREE ? resolve(rt, process.env.AGENT_FLOW_WORKTREE) : undefined,
      allowProtected: process.env.AGENT_FLOW_ALLOW_PROTECTED === "1",
    });
    if (!decision) return 0;
    try {
      state.appendAudit(rt, { event: "guard_block", harness: "claude", role, tool: ev.tool_name, rule: decision.rule, reason: decision.reason });
    } catch {
      /* the block matters more than the log line */
    }
    console.error(decision.reason);
    return 2;
  } catch (e) {
    return fail(role, `guard error: ${e.message}`);
  }
}

// --- install --------------------------------------------------------------

const TARGETS = {
  claude: { skills: ".claude/skills", agents: [[".claude/agents/reviewer.md", ".claude/agents/reviewer.md"]], note: "" },
  codex: {
    skills: ".agents/skills",
    agents: [[".codex/agents/reviewer.toml", ".codex/agents/reviewer.toml"]],
    note: "The pipeline launches the Reviewer with `codex exec --sandbox read-only` (Codex's OS-level sandbox); .codex/agents/reviewer.toml is for delegating a review from an interactive Codex session.",
  },
  gemini: {
    skills: ".gemini/skills",
    agents: [[".gemini/agents/reviewer.md", ".gemini/agents/reviewer.md"]],
    note: 'Trust the workspace (/trust) and set `"context": {"fileName": ["AGENTS.md", "GEMINI.md"]}` in .gemini/settings.json so Gemini loads AGENTS.md. The pipeline runs the Reviewer as `gemini --approval-mode plan` (read-only); .gemini/agents/reviewer.md is for `@reviewer` in interactive sessions.',
  },
  cursor: { skills: ".cursor/skills", agents: [], note: "Cursor reads AGENTS.md natively." },
  copilot: { skills: ".github/skills", agents: [], note: "VS Code / Copilot also reads .claude/skills and .agents/skills." },
  windsurf: { skills: ".agents/skills", agents: [], note: "Windsurf (Cascade) reads AGENTS.md natively, including per-directory AGENTS.md in monorepos. No skill-folder or read-only-subagent mechanism is documented for it, so enforcement here is the pre-commit hook." },
  agents: { skills: ".agents/skills", agents: [], note: ".agents/skills is the cross-client convention — also the right target for Aider, Zed, Warp, Amp, opencode, goose, JetBrains Junie, RooCode, and anything else that reads AGENTS.md but has no harness-specific integration below." },
};

function sameTree(a, b) {
  if (!existsSync(b)) return false;
  const sa = statSync(a);
  if (sa.isDirectory()) {
    if (!statSync(b).isDirectory()) return false;
    const la = readdirSync(a).sort();
    const lb = readdirSync(b).sort();
    return la.length === lb.length && la.every((n, i) => n === lb[i] && sameTree(join(a, n), join(b, n)));
  }
  return statSync(b).isFile() && readFileSync(a).equals(readFileSync(b));
}

function cmdInstall(args) {
  const t = Object.hasOwn(TARGETS, args.harness) ? TARGETS[args.harness] : null;
  const harnesses = Object.keys(TARGETS);
  if (!t && typeof args.harness === "string") return unknown("harness", args.harness, harnesses, `usage: agent-flow install --harness <${harnesses.join("|")}>`);
  if (!t) return usage(`install --harness <${harnesses.join("|")}>`);
  const rt = root();
  const plan = [];
  for (const name of readdirSync(join(pkgRoot, "skills")).sort()) {
    const src = join(pkgRoot, "skills", name);
    if (!statSync(src).isDirectory()) continue;
    plan.push([src, join(rt, t.skills, name), `${t.skills}/${name}`]);
  }
  for (const [from, to] of t.agents) plan.push([join(pkgRoot, from), join(rt, to), to]);

  const conflicts = [];
  let wrote = 0;
  for (const [src, dst, label] of plan) {
    if (sameTree(src, dst)) {
      console.log(dim(`= ${label} (up to date)`));
      continue;
    }
    if (existsSync(dst) && !args.force) {
      conflicts.push(label);
      bad(`${label} exists and differs — not overwritten (use --force)`);
      continue;
    }
    if (!args["dry-run"]) {
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst, { recursive: true, force: true });
    }
    wrote++;
    ok(`${args["dry-run"] ? "would write" : "wrote"} ${label}`);
  }
  if (args.harness === "claude") {
    if (!installClaudeHook(rt, args)) conflicts.push(".claude/settings.json");
    importAgentsMd(rt, args);
  }
  if (t.note) console.log(`\n${t.note}`);
  const who = args.harness === "claude" ? "Claude" : "your agent";
  console.log(`\nNext:\n  1. npx @drix10/agent-flow doctor\n  2. ask ${who}: "use the bootstrap skill to set up this repo"\n  3. npx @drix10/agent-flow hook install`);
  return conflicts.length ? 1 : 0;
}

/** Claude Code reads CLAUDE.md, not AGENTS.md; an `@AGENTS.md` line imports it. */
function importAgentsMd(rt, args) {
  const path = join(rt, "CLAUDE.md");
  // A CLAUDE.md that is a symlink to AGENTS.md (a common setup) already is the same file: an import would make it import itself.
  const agents = join(rt, "AGENTS.md");
  if (existsSync(path) && existsSync(agents) && realpathSync(path) === realpathSync(agents)) return console.log(dim("= CLAUDE.md (is AGENTS.md)"));
  const cur = existsSync(path) ? readFileSync(path, "utf-8") : null;
  if (cur !== null && /^[ \t]*@AGENTS\.md[ \t]*$/m.test(cur)) return console.log(dim("= CLAUDE.md (imports @AGENTS.md)"));
  const eol = cur === null ? "\n" : mergeLib.detectEol(cur);
  const next = cur === null ? `@AGENTS.md${eol}` : `${cur}${cur === "" || cur.endsWith("\n") ? "" : eol}${eol}@AGENTS.md${eol}`;
  if (!args["dry-run"]) writeFileSync(path, next);
  ok(`${args["dry-run"] ? "would write" : "wrote"} CLAUDE.md (${cur === null ? "new, imports" : "appended"} @AGENTS.md)`);
}

const HOOK_MATCHER = "Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell|mcp__.*";

/**
 * Wire the guard into Claude Code as a PreToolUse hook, merged into any
 * existing .claude/settings.json. The hook must point at a copy of agent-flow
 * that every checkout has — the project's node_modules — or it silently
 * doesn't run (a hook that can't start doesn't block).
 */
function installClaudeHook(rt, args) {
  const label = ".claude/settings.json (PreToolUse guard hook)";
  const binRel = relative(rt, join(pkgRoot, "bin", "agent-flow.js"));
  if (fsutil.escapesBase(binRel)) {
    bad(`${label}: agent-flow isn't installed in this project, so the hook would point at a temporary copy.`);
    console.log(dim("    Run `npm install -D @drix10/agent-flow`, then `npx @drix10/agent-flow install --harness claude` again."));
    return false;
  }
  const command = `node "$CLAUDE_PROJECT_DIR/${binRel.split("\\").join("/")}" guard`;
  const path = join(rt, ".claude", "settings.json");
  let settings = {};
  let indent = 2;
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf-8");
      settings = JSON.parse(raw.replace(/^\uFEFF/, ""));
      indent = mergeLib.detectJsonIndent(raw);
    } catch (e) {
      bad(`${label}: existing file isn't valid JSON (${e.message}) — not touched. Fix it and re-run.`);
      return false;
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      bad(`${label}: existing file isn't a JSON object — not touched.`);
      return false;
    }
  }
  if ((settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks))) || (settings.hooks?.PreToolUse !== undefined && !Array.isArray(settings.hooks.PreToolUse))) {
    bad(`${label}: existing "hooks" has an unexpected shape — not touched. Fix it and re-run.`);
    return false;
  }
  const before = JSON.stringify(settings);
  settings.hooks ??= {};
  settings.hooks.PreToolUse ??= [];
  const isOurs = (h) => /agent-flow/.test(h?.command ?? "") && /\bguard\b/.test(h?.command ?? "");
  const entry = { matcher: HOOK_MATCHER, hooks: [{ type: "command", command }] };
  // Someone else's hooks may share a matcher group with ours. Their group keeps its matcher and its
  // other hooks; ours moves to a group of its own.
  const group = settings.hooks.PreToolUse.find((e) => Array.isArray(e?.hooks) && e.hooks.some(isOurs));
  if (group && group.hooks.every(isOurs)) {
    group.matcher = HOOK_MATCHER;
    group.hooks = [{ ...group.hooks[0], type: "command", command }];
  } else {
    if (group) group.hooks = group.hooks.filter((h) => !isOurs(h));
    settings.hooks.PreToolUse.push(entry);
  }
  if (JSON.stringify(settings) === before) {
    console.log(dim(`= ${label} (up to date)`));
    return true;
  }
  if (!args["dry-run"]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(settings, null, indent)}\n`);
  }
  ok(`${args["dry-run"] ? "would write" : "wrote"} ${label}`);
  return true;
}

const toPosixPath = (p) => p.replace(/\\/g, "/");
const HOOK_MARKER = "# agent-flow pre-commit";

function cmdHook(args) {
  if (args._[1] !== "install") return sub("hook", args._[1], ["install"], "hook install [--force]");
  const rt = root();
  requireRepo(rt);
  const hooksDir = resolve(rt, git.mustGit(["rev-parse", "--git-path", "hooks"], rt));
  const hook = join(hooksDir, "pre-commit");
  // Non-Node repos (Python, Go…) have no node_modules: also try the CLI that ran
  // `hook install`, unless it lives in npx's throwaway cache.
  const self = toPosixPath(fileURLToPath(import.meta.url));
  const selfLine = /\/_npx\//.test(self) ? "" : `if [ -f "${self}" ]; then exec node "${self}" check-staged; fi\n`;
  const body = `#!/bin/sh
${HOOK_MARKER} — protected paths, secrets, broken context references.
# Installed by \`agent-flow hook install\`. Never downloads anything.
# Works from linked worktrees too: the binary is looked up in the MAIN checkout.
main_root="$(cd "$(git rev-parse --git-common-dir)/.." 2>/dev/null && pwd)"
for bin in "./node_modules/.bin/agent-flow" "$main_root/node_modules/.bin/agent-flow"; do
  if [ -x "$bin" ]; then exec "$bin" check-staged; fi
done
${selfLine}if npx --no-install @drix10/agent-flow --version >/dev/null 2>&1; then exec npx --no-install @drix10/agent-flow check-staged; fi
echo "agent-flow pre-commit: can't find the agent-flow CLI. Install it (npm i -D @drix10/agent-flow, or npm i -g @drix10/agent-flow in a non-Node repo) and re-run: agent-flow hook install" >&2
exit 1
`;
  // Only a hook that carries our own header is ours to replace; one that merely mentions agent-flow is the user's.
  const existing = existsSync(hook) ? readFileSync(hook, "utf-8") : null;
  const ours = existing !== null && existing.includes(HOOK_MARKER);
  if (existing !== null && !ours) {
    if (!args.force) {
      bad(`${hook} already exists (not ours). Add \`npx --no-install @drix10/agent-flow check-staged\` to it, or re-run with --force (your hook is kept as pre-commit.bak-<time>).`);
      return 1;
    }
    const keep = `${hook}.bak-${Date.now()}`;
    copyFileSync(hook, keep);
    warn(`replaced your existing pre-commit hook; the original is at ${keep}`);
  }
  const custom = git.git(["config", "--get", "core.hooksPath"], rt);
  if (custom.ok && custom.stdout) warn(`core.hooksPath is set (${custom.stdout}); the hook went there. If a tool such as husky regenerates that directory, add \`npx --no-install @drix10/agent-flow check-staged\` to its pre-commit script instead.`);
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(hook, body, "utf-8");
  try {
    chmodSync(hook, 0o755);
  } catch {
    /* windows */
  }
  ok(`installed ${hook}`);
  return 0;
}

async function cmdInit(args) {
  const rt = root();
  const plan = initLib.planInit(rt, { version: VERSION });
  const todo = plan.files.filter((f) => !f.exists);
  const dry = !!args["dry-run"];
  const interactive = !args.json && !!process.stdin.isTTY && !!process.stdout.isTTY;
  if (args.json && !args.yes) {
    console.log(JSON.stringify({ written: [], plan: plan.files.map((f) => ({ path: f.path, action: f.exists ? "skip_exists" : "write", content: f.content })), references: plan.references, missing_references: plan.missing_references }, null, 2));
    return 0;
  }
  if (!args.json) {
    for (const f of plan.files) if (f.exists) warn(`${f.path} exists — not overwritten`);
    if (plan.existing_rules) console.log(dim(`  ${plan.existing_rules.join(", ")} already holds your rules, so no AGENTS.md was generated beside it. Move the shared rules into AGENTS.md when you're ready (other agents read that file), or ask your agent to use the bootstrap skill to merge them.`));
    if (todo.length && !args.yes) {
      for (const f of todo) console.log(`${dim(`--- ${f.path} (would write) ---`)}\n${f.content.trimEnd()}\n`);
    }
  }
  if (!todo.length) {
    if (!args.json) ok("nothing to write — run `agent-flow doctor`");
    else console.log(JSON.stringify({ written: [] }));
    return 0;
  }
  if (dry) {
    console.log(dim("dry run — nothing written"));
    return 0;
  }
  if (!args.yes) {
    if (!interactive) {
      console.log(dim("nothing written (not a terminal) — re-run with --yes to write these files"));
      return 0;
    }
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Write ${todo.map((f) => f.path).join(" and ")}? [y/N] `);
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log("nothing written");
      return 0;
    }
  }
  const written = [];
  for (const f of todo) {
    try {
      writeFileSync(join(rt, f.path), f.content, { flag: "wx" }); // wx: never clobber a file that appeared meanwhile
      written.push(f.path);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      warn(`${f.path} appeared meanwhile — not overwritten`);
    }
  }
  const manifestSkipped = plan.files.some((f) => f.path === manifestLib.MANIFEST_FILE && f.exists);
  out(args, { written, references: plan.references, missing_references: plan.missing_references }, () => {
    for (const p of written) {
      ok(`wrote ${p}${p === manifestLib.MANIFEST_FILE ? ` — ${plan.references} reference(s) from ${plan.context_files.length} context file(s)` : ""}`);
    }
    if (plan.missing_references.length) warn(`${plan.missing_references.length} referenced path(s) don't exist, so they weren't recorded — \`agent-flow doctor\` lists them`);
    if (written.includes("AGENTS.md") && manifestSkipped) warn("add AGENTS.md to context_files in your existing CONTEXT_MANIFEST.json");
    console.log(dim(`\nnext: ${written.includes("AGENTS.md") ? "replace the [NEEDS VERIFICATION] lines in AGENTS.md, then " : ""}\`agent-flow doctor\` (and add it to CI)`));
  });
  return 0;
}

function usage(msg) {
  console.error(`usage: agent-flow ${msg}`);
  return 2;
}

/** A missing or misspelled subcommand. */
function sub(cmdName, word, choices, usageLine) {
  if (word === undefined) return usage(usageLine);
  return unknown(`${cmdName} subcommand`, word, choices, `usage: agent-flow ${usageLine}`);
}

// Commands that change shared pipeline state, per confined role. Mirrors the shell
// guard's allow-list (guard.ts) so the CLI can't be used to route around it; the two
// tables should be unified once both land.
// One allow list for both paths: the shell guard and the CLI itself use guard.roleMayRunCli,
// so a read-only role can't mutate pipeline state no matter how the command is reached.
function roleRefusal() {
  const raw = process.env.AGENT_FLOW_ROLE;
  const { role } = guardLib.parseRole(raw);
  const reason = guardLib.roleMayRunCli(role, process.argv.slice(2));
  if (!reason) return 0;
  console.error(`agent-flow: ${reason} (AGENT_FLOW_ROLE=${raw}) Report back to the orchestrator instead.`);
  return 2;
}

// ---------------------------------------------------------------------------

const args = fixBools(parseArgs(process.argv.slice(2)));
if (args._[0] === "-h") args.help = true;
if (args._[0] === "-v" || args._[0] === "-V") args.version = true;
const cmd = args._[0];
const table = {
  doctor: cmdDoctor,
  init: cmdInit,
  "audit-risk": cmdAudit,
  baseline: cmdBaseline,
  classify: cmdClassify,
  "check-staged": cmdCheckStaged,
  state: cmdState,
  worktree: cmdWorktree,
  scan: cmdScan,
  install: cmdInstall,
  hook: cmdHook,
  schema: cmdSchema,
  template: cmdTemplate,
  report: cmdReport,
  repair: cmdRepair,
  guard: cmdGuard,
};

if (args.version || cmd === "version") {
  console.log(VERSION);
  process.exit(0);
}
const badFlag = Object.keys(args).find((k) => k !== "_" && !KNOWN_FLAGS.has(k));
if (badFlag !== undefined) process.exit(unknown("flag", `--${badFlag}`, [...KNOWN_FLAGS].map((f) => `--${f}`), "run `agent-flow --help` for options"));
if (!cmd || args.help || cmd === "help") {
  console.log(HELP);
  process.exit(0);
}
if (!Object.hasOwn(table, cmd)) process.exit(unknown("command", cmd, Object.keys(table), "run `agent-flow --help` for the list"));
try {
  // exitCode, not process.exit(): exiting straight after a large write to a pipe can truncate it on macOS and Windows.
  process.exitCode = roleRefusal() || (await table[cmd](args));
} catch (e) {
  const msg = String(e.message ?? e).split("\n")[0];
  const friendly = /not a git repository/i.test(msg) ? "not a git repository — run this inside a git checkout (or `git init` first)" : msg;
  console.error(`${c(31, "agent-flow:")} ${friendly}`);
  process.exitCode = 2;
}
