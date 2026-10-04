#!/usr/bin/env node
/**
 * agent-flow CLI — the same checks as the Pi tools, for every harness and for CI.
 *
 * Zero runtime dependencies. No network except an optional, cached, opt-out update check in `doctor` (see update.ts). Exit codes:
 *   0 = ok   1 = check failed   2 = usage / environment error
 */

import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const lib = (m) => import(new URL(`../extensions/lib/${m}.js`, import.meta.url).href);

let launchLib, orchestrateLib, updateLib, fsutil, manifestLib, stale, risk, state, classify, worktree, git, scan, guardLib, report, initLib, mergeLib, auditLib, gatesLib, policyLib, sarifLib, bindingLib, stopGateLib, codeownersLib, debtLib, uninstallLib, briefLib, statuslineLib, mcpLib;
try {
  [launchLib, orchestrateLib, updateLib, fsutil, manifestLib, stale, risk, state, classify, worktree, git, scan, guardLib, report, initLib, mergeLib, auditLib, gatesLib, policyLib, sarifLib, bindingLib, stopGateLib, codeownersLib, debtLib, uninstallLib, briefLib, statuslineLib, mcpLib] = await Promise.all(
    ["launch", "orchestrate", "update", "fsutil", "manifest", "stale", "risk", "state", "classify", "worktree", "git", "scan", "guard", "report", "init", "merge", "audit", "gates", "policy", "sarif", "binding", "stopgate", "codeowners", "debt", "uninstall", "brief", "statusline", "mcp"].map(lib),
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

const BOOL_FLAGS = new Set(["auto-merge", "no-auto-merge", "pr", "check", "json", "no-prose", "ctxlint", "fail-on-new", "include-tests", "all", "yes", "fail-on-protected", "fail-on-critical", "fail-on-policy", "fail-on-heuristic", "sarif", "reopen", "force", "delete-branch", "dry-run", "help", "strict", "stop-gate", "vendor", "allow-stale", "offline", "fail-on-no-trigger", "keep-runtime", "keep-hook", "no-brief", "statusline"]);
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

const VALUE_FLAGS = ["manifest", "baseline", "base", "head", "issue", "state", "phase", "round", "reason", "dir", "out", "harness", "exit", "seconds", "model", "argv-file", "anchor", "name", "owner", "timeout", "commands", "limit-wait", "event"];
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
  status                    One screen: is anything protecting this repo, what is waiting on you, is agent-flow current
  doctor                    Check every path your AGENTS.md / CLAUDE.md / .cursorrules / … mention
  init [--yes] [--dry-run]  Write a starter CONTEXT_MANIFEST.json (+ AGENTS.md if missing) from a scan

Audit log (a hash chain: edits, removals and reordering are detectable):
  audit verify [--anchor <hash>]  Check .agent-flow/audit.jsonl; exit 1 if the chain is broken or the anchor is missing
  audit head                Print the current head hash — record it in a commit or CI to anchor the log
  audit summary             Guard blocks per role and rule, escalations, rounds per issue, role runs and cost

Checks (CI-safe, read-only):
  doctor                    Context files vs the filesystem; with a manifest, also staleness
      --manifest <path>     Manifest path (default CONTEXT_MANIFEST.json)
      --no-prose            Skip checking \`backticked/paths\` inside context files
      --ctxlint             Also run a locally installed ctxlint (never downloads)
      --allow-stale         Report stale context but exit 0 for it (CI on every push); broken paths still fail
      --offline             Skip asking GitHub (via a logged-in gh) whether Code Owner review is enforced
  config get <key>          One manifest value (e.g. pipeline.models.fast) as the pipeline reads it: the default branch's copy for pipeline, gates and policy
  gates [list|run|stop]     Run the manifest's gates (tests, lint, build); records exit codes, logs and hashes
                            run [--name a,b] [--issue <n>] [--json]; exit 1 if a required gate fails, 2 if one couldn't run
  debt                      Ledger of deferred shortcuts: every \`lean:\` comment (a ceiling and when to upgrade), [no-trigger] where it names none
      --fail-on-no-trigger  Exit 1 while any shortcut names no condition for revisiting it
  audit-risk                Diff risk surfaces against .risk-baseline.json
      --baseline <path>  --include-tests  --fail-on-new
  classify                  Mechanical risk level of a diff (vs the merge-base, so later commits on the base don't count)
      --base <rev> --head <rev> --issue <n>  --fail-on-protected  --fail-on-critical
                            --fail-on-policy (manifest policy rules)  --fail-on-heuristic (no risk_boundaries set)
  check-staged              Pre-commit gate: protected paths, secrets, broken context refs
  scan                      Read-only repo reconnaissance (what /bootstrap sees)

Pipeline (the CLI twin of the Pi tools — same rules, any harness):
  state [show] [--issue <n>]  Print pipeline state
  state update --issue <n> --state "Working|Needs Me|Completed" [--phase p] [--round r] [--reason t] [--reopen]
  state dismiss --issue <n> --reason <why>
                            Drop an issue from the list (you handled it by hand, or no longer want it); its files are kept
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
  run "<task>" | run <issue>  Take one task from words to a reviewed, gated, tested change (Implementer → Reviewer → gates → QA) [--pr] [--auto-merge] [--dry-run]
                            without --pr it stops with the work ready locally; --pr pushes and opens the pull request
                            a role that hits a usage limit is run again after the reset, if that is within --limit-wait <hours> (default 6; 0 never waits)
  update [--yes] [--check] [--force]  Bring installed skills, hooks and the vendored runtime up to this version; edited files are kept
                            run it as: npx @drix10/agent-flow@latest update --yes   (--check exits 10 when an update is available, for scheduled CI)
  uninstall [--harness <name>] [--yes] [--keep-runtime] [--keep-hook]
                            Remove what install wrote and nothing else: unedited skills, agents and the vendored runtime, agent-flow's own
                            hook entries (your other hooks stay), the pre-commit gate. Previews unless --yes. AGENTS.md, the manifest and your state are never touched
  codeowners [--yes] [--owner @x]  CODEOWNERS lines covering protected_paths; --yes appends the missing ones
  manifest sync [--yes]     Rebuild context_files from the AGENTS.md/CLAUDE.md files on disk; keeps protected paths, risk boundaries and gates
  sandbox [--ro] [--no-net] [--hide-home] [--allow <dir>] -- <cmd>
                            Run <cmd> under bubblewrap: read-only filesystem except this worktree (Linux/WSL)
  brief [--event SessionStart|SubagentStart]
                            What an agent should know about this repo's guard, in the output shape of the harness running the hook (the SessionStart hook install wires)
  mcp                       A read-only MCP server on stdio (status, state, classify, debt, doctor, audit summary, gates, brief) for any MCP client; changes nothing
  statusline                One short line for Claude Code's statusLine: guard on or OFF, how many issues need you, are ready, are working
  guard                     Claude Code PreToolUse hook: reads the hook JSON on stdin, exit 2 = blocked
  guard --check             Exit 1 unless the Claude Code hook is installed and its target exists

Setup (writes files; run by a human):
  baseline accept --all --yes | baseline accept <key>... --yes
  install --harness <claude|codex|gemini|cursor|copilot|windsurf|opencode|cline|kiro|qoder|swival|factory|commandcode|agents> [--dry-run] [--force] [--stop-gate] [--vendor] [--no-brief] [--statusline]
                            --statusline also sets Claude Code's statusLine to "agent-flow statusline", only if none is set
                            --no-brief leaves out the SessionStart briefing hook (Claude Code, Codex, Cursor)
                            --vendor copies the runtime to .agent-flow-runtime/ for the hook (automatic outside an npm install; no package.json needed)
  hook install [--force]    Install the pre-commit hook (runs check-staged)

Global: --json for machine output; --sarif (doctor, audit-risk) for GitHub code scanning; --help, --version
`;

/** `sarif` (optional) builds the SARIF log for `--sarif`; commands without one reject the flag. */
function out(args, value, human, sarif) {
  if (args.sarif && sarif) console.log(JSON.stringify(sarif(value), null, 2));
  else if (args.json) console.log(JSON.stringify(value, null, 2));
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
  const weight = contextWeight(rt, r.context_files);
  out(args, { healthy: r.healthy, mode: r.mode, context_files: r.context_files, context_weight: weight, report: rep, manifest: r.manifest, legacy_schema: r.legacy_schema }, () => {
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
    section("commands exist", rep.dead_commands, (m) => [`${m.file}${m.line ? `:${m.line}` : ""}`, `${m.command}${m.reason ? ` — ${m.reason}` : ""}${m.suggestion ? `  → did you mean ${c(1, m.suggestion)}?` : ""}`]);
    section("relative links resolve", rep.broken_links, (m) => [`${m.file}:${m.line}`, m.target]);
    section("cited commits exist", rep.unknown_commits, (m) => [`${m.file}:${m.line}`, m.sha]);
    const heavy = weight.filter((w) => w.heavy);
    if (heavy.length) {
      warn(`context files over ${CONTEXT_MAX_LINES} lines: an agent pays for each one on every task`);
      for (const w of heavy) console.log(`    ${w.file}  ${w.lines} lines, about ${w.tokens} tokens  ${dim("→ keep rules here; move detail to docs/ and link it")}`);
    }
    reportCodeowners(rt, r.manifest, args);
    reportGateCoverage(rt, r.manifest);
    reportUpdate(rt, args);
    if (discovered) console.log(dim(`note: ${r.manifest ? "the manifest lists no context files" : "no CONTEXT_MANIFEST.json"}, so only paths were checked — \`agent-flow init\` adds staleness tracking`));
    console.log(r.healthy ? c(32, "\nhealthy") : `\n${c(31, "unhealthy")} — ${doctorNextStep(rep, schema)}`);
  }, () => doctorSarif(rt, rep, r.manifest));
  // CI that runs on every push shouldn't go red because a calendar page turned: --allow-stale reports staleness
  // and fails only on what is actually broken (missing paths, schema, placeholders…).
  return none || r.healthy || (args["allow-stale"] && r.only_stale) ? 0 : 1;
}

/** A context file an agent reads on every task costs tokens on every task: past this size, say so (never fails the run). */
const CONTEXT_MAX_LINES = 150;
const CONTEXT_MAX_BYTES = 9_000;
function contextWeight(rt, files) {
  const rows = [];
  for (const f of files) {
    // The manifest is read by tools, not by agents; only the prose files are loaded into a session.
    if (!/\.md$/i.test(f)|| escapesBaseDir(rt, join(rt, f))) continue;
    let text;
    try {
      text = readFileSync(join(rt, f), "utf-8");
    } catch {
      continue;
    }
    const lines = text.split("\n").length;
    const bytes = Buffer.byteLength(text);
    rows.push({ file: f, lines, tokens: Math.round(bytes / 4), heavy: lines > CONTEXT_MAX_LINES || bytes > CONTEXT_MAX_BYTES });
  }
  return rows;
}

/** Advisory: a test file in a directory whose gate lists its tests one by one, but which no gate lists. */
function reportGateCoverage(rt, manifestPath) {
  const loaded = manifestLib.loadManifest(rt, typeof manifestPath === "string" ? manifestPath : undefined);
  const gates = loaded.ok ? gatesLib.gatesOf(loaded.value.manifest) : [];
  if (!gates.length) return;
  const ls = git.git(["ls-files", "-z"], rt);
  if (!ls.ok) return;
  const missing = gatesLib.unlistedTests(ls.stdout.split("\0").filter(Boolean), gates);
  if (!missing.length) return ok("every test file in a gate's list is run by a gate");
  warn(`${missing.length} test file${missing.length === 1 ? " is" : "s are"} next to tests a gate lists by name, but no gate runs ${missing.length === 1 ? "it" : "them"}:`);
  for (const f of missing.slice(0, 15)) console.log(`    ${f}`);
  if (missing.length > 15) console.log(dim(`    … ${missing.length - 15} more`));
  console.log(dim("  Add each to a gate in CONTEXT_MANIFEST.json (or delete it). CI that keeps its own list drifts the same way: `agent-flow gates run` in CI keeps one list."));
}

/**
 * What CODEOWNERS should cover: the protected paths, and once there are any, the files that define them. A pull request
 * that edits CONTEXT_MANIFEST.json can unprotect a path, drop a gate or turn on auto-merge; one that edits
 * .risk-baseline.json accepts its own risks. Both take effect on merge, so they need the same owner review.
 */
function ownedPaths(rt, loaded) {
  const prot = loaded.ok ? (loaded.value.manifest.protected_paths ?? []).filter((x) => typeof x === "string") : [];
  if (!prot.length) return [];
  const rules = [manifestLib.MANIFEST_FILE, ...(existsSync(join(rt, ".risk-baseline.json")) ? [".risk-baseline.json"] : [])];
  return [...prot, ...rules.filter((f) => !prot.includes(f))];
}

/**
 * Advisory only, never fails doctor. The guard and the pre-commit hook already keep local agents off protected
 * paths; CODEOWNERS plus host review only matters for a pull request pushed from elsewhere. So: one quiet note
 * with the fix, and GitHub's real setting when a logged-in `gh` can tell us for free.
 */
function reportCodeowners(rt, manifestPath, args = {}) {
  const loaded = manifestLib.loadManifest(rt, typeof manifestPath === "string" ? manifestPath : undefined);
  const prot = ownedPaths(rt, loaded);
  if (!prot.length) return;
  const missing = codeownersLib.uncoveredProtected(rt, prot);
  if (missing === null || missing.length) {
    const what = missing === null ? "no CODEOWNERS file" : `CODEOWNERS misses ${missing.join(", ")}`;
    console.log(dim(`note: ${what}. Local agents are already blocked from protected paths; CODEOWNERS also asks for your review when a pull request touches them. \`agent-flow codeowners --yes\` writes the lines.`));
    return;
  }
  ok("protected paths have CODEOWNERS entries");
  if (args.offline || process.env.AGENT_FLOW_OFFLINE === "1" || process.env.CI) return;
  const remote = git.git(["remote", "get-url", "origin"], rt);
  const slug = remote.ok ? codeownersLib.githubSlug(remote.stdout) : null;
  if (!slug) return;
  const branch = (loaded.ok && loaded.value.manifest.default_branch) || git.defaultBranch(rt);
  const host = codeownersLib.hostCodeOwnerReview(slug, branch);
  if (!host) return; // no gh, not logged in, offline: say nothing rather than nag
  if (host.state === "enforced") ok(`GitHub requires Code Owner review on ${branch} (${host.via})`);
  else if (host.state === "unknown") console.log(dim(`note: ${branch} is protected on GitHub; seeing whether it requires Code Owner review needs admin rights.`));
  else console.log(dim(`note: GitHub doesn't require Code Owner review on ${branch}, so a pull request can still merge changes to protected paths. Working solo, that's fine. With a team: Settings → Branches (or Rules) → "Require review from Code Owners"; owners then need bypass to merge their own PRs.`));
}

/** `codeowners [--yes]`: the CODEOWNERS lines that cover protected_paths; --yes appends the missing ones. */
function cmdCodeowners(args) {
  const rt = root();
  const loaded = manifestLib.loadManifest(rt, args.manifest);
  const prot = ownedPaths(rt, loaded);
  if (!prot.length) throw new UserError("no protected_paths in the manifest — nothing for CODEOWNERS to cover");
  const missing = codeownersLib.uncoveredProtected(rt, prot) ?? prot;
  if (args.owner === true) throw new UserError("--owner needs a value, e.g. --owner @you or --owner @org/team");
  const remote = git.git(["remote", "get-url", "origin"], rt);
  const owner = args.owner ?(String(args.owner).startsWith("@") ? String(args.owner) : `@${args.owner}`) : (remote.ok && codeownersLib.githubOwner(remote.stdout)) || null;
  if (!owner) throw new UserError("couldn't tell the owner from the origin remote — pass --owner @you (or @org/team)");
  // A bare @org is not a valid CODEOWNERS owner (only users and @org/team): ask rather than write a rule that owns nothing.
  if (!args.owner && !owner.includes("/") && !args.offline && process.env.AGENT_FLOW_OFFLINE !== "1" && codeownersLib.ownerKind(owner.slice(1)) === "Organization") {
    throw new UserError(`${owner} is an organization, and CODEOWNERS needs a person or a team. Run again with --owner ${owner}/<team> (or --owner @your-login)`);
  }
  const lines = missing.map((g) => `${codeownersLib.codeownersPattern(g)}  ${owner}`);
  const existing = codeownersLib.codeownersFile(rt);
  const path = join(rt, existing ?? ".github/CODEOWNERS");
  const write = !!args.yes && !args["dry-run"] && lines.length > 0;
  if (write) {
    const cur = existsSync(path) ? readFileSync(path, "utf-8") : "";
    const eol = cur.includes("\r\n") ? "\r\n" : "\n";
    const head = cur ? `${cur.endsWith("\n") ? "" : eol}${eol}` : "";
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${cur}${head}# agent-flow: protected_paths from CONTEXT_MANIFEST.json, and the files that hold the rules${eol}${lines.join(eol)}${eol}`);
  }
  out(args, { file: toPosixPath(relative(rt, path)), owner, lines, written: write }, () => {
    if (!lines.length) return ok("CODEOWNERS already covers every protected path");
    for (const l of lines) console.log(`  ${l}`);
    if (write) ok(`${existing ? "appended to" : "wrote"} ${toPosixPath(relative(rt, path))}`);
    else console.log(dim(`nothing written — re-run with --yes to ${existing ? "append these to" : "create"} ${toPosixPath(relative(rt, path))}`));
  });
  return 0;
}

/** One dim line, only for humans at a terminal: never in --json/--sarif output, CI, or when opted out. */
function reportUpdate(rt, args) {
  const check = updateLib.updateCheckAllowed() && !args.offline && !args.json && !!process.stdout.isTTY;
  const n = updateLib.updateNotice(rt, VERSION, { check });
  if (n) console.log(dim(`note: ${n.message}`));
}

function doctorSarif(rt, rep, manifestPath) {
  const lineOf = proseLines(rt);
  const f = [];
  const manifestFile = typeof manifestPath === "string" ? manifestPath : "CONTEXT_MANIFEST.json";
  for (const p of rep.schema_problems) f.push({ ruleId: "agent-flow/manifest-schema", level: "error", message: p, path: manifestFile });
  for (const p of rep.missing_context_files) f.push({ ruleId: "agent-flow/missing-context-file", level: "error", message: `context file missing: ${p}`, path: manifestFile });
  for (const m of rep.missing_paths) f.push({ ruleId: "agent-flow/broken-reference", level: "error", message: `references ${m.path}, which does not exist${m.suggestion ? ` (did you mean ${m.suggestion}?)` : ""}`, path: m.file, line: m.source === "prose" ? lineOf(m.file, m.path) : undefined });
  for (const m of rep.invalid_timestamps) f.push({ ruleId: "agent-flow/invalid-timestamp", level: "error", message: `${m.path}: ${JSON.stringify(m.value)} is not a valid ISO timestamp`, path: m.file });
  for (const p of rep.stale_files) f.push({ ruleId: "agent-flow/stale-context", level: "warning", message: `${p} has not been verified within the staleness threshold`, path: p });
  for (const m of rep.unfilled_placeholders) f.push({ ruleId: "agent-flow/unfilled-placeholder", level: "warning", message: m.text, path: m.file, line: m.line });
  for (const m of rep.dead_commands ?? []) f.push({ ruleId: "agent-flow/dead-command", level: "warning", message: `${m.command}${m.reason ? ` — ${m.reason}` : ""}${m.suggestion ? ` (did you mean ${m.suggestion}?)` : ""}`, path: m.file, line: m.line });
  for (const m of rep.broken_links ?? []) f.push({ ruleId: "agent-flow/broken-link", level: "error", message: `link target does not exist: ${m.target}`, path: m.file, line: m.line });
  for (const m of rep.unknown_commits ?? []) f.push({ ruleId: "agent-flow/unknown-commit", level: "warning", message: `no such commit: ${m.sha}`, path: m.file, line: m.line });
  return sarifLib.toSarif(VERSION, sarifLib.DOCTOR_RULES, f);
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
  }, (v) => {
    const list = v.baselineExists ? v.newSurfacesList : v.surfaces;
    return sarifLib.toSarif(VERSION, sarifLib.RISK_RULES, list.map((x) => ({
      ruleId: v.baselineExists ? "agent-flow/new-risk-surface" : "agent-flow/risk-surface",
      level: x.type === "secret" ? "error" : "warning",
      message: `${x.type}: ${x.detail}`,
      path: x.path,
      line: x.lines?.[0],
    })));
  });
  if (failNoBaseline) return 1;
  if (args["fail-on-new"] && r.newSurfaces > 0) return 1;
  return 0;
}

/**
 * `mcp`: a read-only Model Context Protocol server on stdio. Every tool runs this same CLI's `--json` command in the repo
 * the server was started in. Only protocol messages ever go to stdout; diagnostics would go to stderr.
 */
async function cmdMcp() {
  const rt = fsutil.findRepoRoot(process.cwd());
  const run = (a) => {
    const r = spawnSync(process.execPath, [SELF_BIN, ...a], { cwd: rt, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1", AGENT_FLOW_OFFLINE: "1" }, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr || (r.error ? String(r.error.message) : "") };
  };
  await mcpLib.serve(process.stdin, process.stdout, { root: rt, version: VERSION, run });
  return 0;
}

/**
 * `statusline`: the badge for Claude Code's statusLine. Claude pipes a JSON description of the session on stdin; its
 * workspace names the repo. Quick and silent: a failure prints nothing rather than an error in someone's status bar.
 */
async function cmdStatusline(args) {
  try {
    let dir = process.cwd();
    if (!process.stdin.isTTY) {
      const raw = await readHookInput(500);
      try {
        const ev = JSON.parse((raw ?? "").replace(/^\uFEFF/, "") || "{}");
        dir = ev.workspace?.project_dir || ev.workspace?.current_dir || ev.cwd || dir;
      } catch {
        /* no usable input: use the working directory */
      }
    }
    const text = statuslineLib.buildStatusline(fsutil.findRepoRoot(dir), { color: color || (!NO_COLOR && !process.stdout.isTTY) });
    if (text) process.stdout.write(args.json ? JSON.stringify({ statusline: text }) : text);
  } catch {
    /* see above */
  }
  return 0;
}

/**
 * `brief`: print what an agent should know about this repo's guard, shaped for the harness that runs the hook. Wired as a
 * SessionStart (and, on Claude Code, SubagentStart) hook by `install`. It never reads stdin, never blocks and never fails:
 * a briefing that errors must not stop a session from starting, so every problem prints nothing and exits 0.
 */
function cmdBrief(args) {
  try {
    const rt = fsutil.findRepoRoot(process.cwd());
    const event = args.event === "SubagentStart" ? "SubagentStart" : "SessionStart";
    const text = briefLib.formatForHost(briefLib.hostOf(), event, briefLib.buildBrief(rt, { role: guardLib.parseRole(process.env.AGENT_FLOW_ROLE).role }));
    if (text) process.stdout.write(process.stdout.isTTY && !text.startsWith("{") ? `${text}\n` : text);
  } catch {
    /* see above */
  }
  return 0;
}

/** `debt`: the `lean:` shortcuts in the code, one row each, so a deferral can't quietly become permanent. */
function cmdDebt(args) {
  const rt = root();
  const r = debtLib.scanDebt(rt);
  const noTrigger = r.rows.filter((x) => x.no_trigger);
  out(args, { markers: r.rows.length, no_trigger: noTrigger.length, truncated: r.truncated, rows: r.rows }, () => {
    if (!r.rows.length) return ok("no lean: debt. Clean ledger.");
    let file = "";
    for (const x of r.rows) {
      if (x.file !== file) {
        file = x.file;
        console.log(c(1, file));
      }
      console.log(`  :${x.line}  ${x.ceiling}${x.upgrade ? `  ${dim("→")} ${x.upgrade}` : ""}${x.no_trigger ? c(33, "  [no-trigger]") : ""}`);
    }
    console.log(`\n${r.rows.length} marker${r.rows.length === 1 ? "" : "s"}, ${noTrigger.length} with no trigger.${r.truncated ? " (file list truncated)" : ""}`);
    if (noTrigger.length) console.log(dim("  A shortcut that names no condition for revisiting it is the one that rots: add `; when <trigger>` to its comment."));
  });
  return args["fail-on-no-trigger"] && noTrigger.length ? 1 : 0;
}

function cmdAuditLog(args) {
  const rt = root();
  const sub_ = args._[1];
  if (sub_ === "verify" || sub_ === "head") {
    const v = auditLib.verifyAudit(rt, { anchor: typeof args.anchor === "string" ? args.anchor : undefined });
    if (sub_ === "head") {
      out(args, { head: v.head, lines: v.lines }, () => console.log(v.head ?? "(no chained entries yet)"));
      return v.head ? 0 : 1;
    }
    out(args, v, () => {
      if (v.lines === 0) return warn("no audit log yet (.agent-flow/audit.jsonl)");
      const parts = [`${v.chained} chained`, ...(v.legacy ? [`${v.legacy} from before chaining`] : []), ...(v.unchained ? [`${v.unchained} unchained`] : [])];
      if (v.broken) bad(`audit log broken at line ${v.broken.line}: ${v.broken.reason}`);
      else ok(`audit log intact (${parts.join(", ")})`);
      if (v.unchained) warn(`${v.unchained} line(s) were written without a chain link (the lock was unavailable); they can't be verified`);
      if (v.anchor) (v.anchor.found ? ok : bad)(v.anchor.found ? `anchor ${v.anchor.hash.slice(0, 12)}… found at line ${v.anchor.line}` : `anchor ${v.anchor.hash.slice(0, 12)}… not in an intact chain: history was rewritten, truncated, or the hash is wrong`);
      if (v.head) console.log(dim(`head ${v.head}`));
    });
    return v.ok ? 0 : 1;
  }
  if (sub_ === "summary") {
    const s = auditLib.summarizeAudit(rt);
    out(args, s, () => {
      if (!s.entries) return warn("no audit log yet (.agent-flow/audit.jsonl)");
      console.log(`${s.entries} entries, ${s.from} → ${s.to}`);
      const list = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
      console.log(`guard blocks: ${s.guard_blocks.total} (by role: ${list(s.guard_blocks.by_role)}; by rule: ${list(s.guard_blocks.by_rule)})`);
      console.log(`role runs: ${s.role_runs.total} (${s.role_runs.ok} ok, ${s.role_runs.failed} failed, $${s.role_runs.cost_usd}${s.role_runs.cost_unreported ? `; cost not reported for ${s.role_runs.cost_unreported}` : ""})`);
      for (const i of s.issues) console.log(`  issue #${i.issue}: ${i.state}, round ${i.round}`);
      for (const e of s.escalations.slice(-10)) console.log(`  needs me: issue #${e.issue} — ${e.reason.slice(0, 120)}`);
      if (s.guard_blocks.total) console.log(dim("  A rule that blocks the same thing again and again belongs in protected_paths or a lint rule, not a prompt."));
    });
    return 0;
  }
  return sub("audit", sub_, ["verify", "head", "summary"], "audit verify [--anchor <hash>] | audit head | audit summary");
}

function cmdGates(args) {
  const rt = root();
  const trusted = manifestLib.trustedManifest(rt);
  const gates = gatesLib.gatesOf(trusted.manifest);
  if (args._[1] === "stop") return gatesStop(rt, trusted.manifest);
  if (trusted.ignoredEdits.includes("gates") && !args.json) {
    warn(`the working copy's gates differ from the default branch's, and the default branch's count. Merge the change, or set ${manifestLib.TRUST_WORKING_MANIFEST_ENV}=1 to try yours locally.`);
  }
  const act = args._[1] ?? "list";
  if (act === "list") {
    out(args, { gates }, () => {
      if (!gates.length) return warn("no gates in CONTEXT_MANIFEST.json (add a `gates` array; see docs/ADOPTION.md)");
      for (const g of gates) console.log(`  ${g.name}${g.required === false ? dim(" (advisory)") : ""}${Array.isArray(g.os) && g.os.length ? dim(` (${g.os.join("/")} only)`) : ""}  ${gatesLib.describeCommand(g.command)}`);
    });
    return 0;
  }
  if (act !== "run") return sub("gates", act, ["list", "run", "stop"], "gates list | gates run [--name a,b] [--issue <n>] [--json] | gates stop (Claude Code Stop hook)");
  if (!gates.length) throw new UserError("no gates defined in CONTEXT_MANIFEST.json, so there is nothing to run");
  let cwd = rt;
  if (args.issue !== undefined) {
    const n = issueNumber(args.issue, "gates run --issue <n>");
    cwd = fsutil.resolveInside(rt, worktree.worktreeRel(n));
    if (!existsSync(cwd)) throw new UserError(`no worktree for issue #${n} (${worktree.worktreeRel(n)}) — create it with \`agent-flow worktree create ${n}\``);
  }
  if (args.name !== undefined && typeof args.name !== "string") throw new UserError("--name needs a comma-separated list of gate names");
  const only = typeof args.name === "string" ? args.name.split(",").map((x) => x.trim()).filter(Boolean) : undefined;
  let r;
  try {
    r = gatesLib.runGates(rt, gates, { only, cwd, issue: args.issue !== undefined ? Number(args.issue) : undefined });
  } catch (e) {
    if (/^no such gate/.test(e.message)) throw new UserError(e.message);
    throw e;
  }
  out(args, r, () => {
    for (const g of r.results) {
      if (g.skipped) {
        warn(`${g.name}: skipped, ${g.skipped} ${dim("(not a pass: CI on that platform judges it)")}`);
        continue;
      }
      const line = `${g.name}: ${g.timed_out ? "timed out" : g.error ? g.error : `exit ${g.exit_code}${g.ok ? "" : ` (expected ${g.expected_exit})`}`} ${dim(`${g.duration_ms}ms ${g.log}`)}`;
      if (g.ok) ok(line);
      else (g.required ? bad : warn)(g.required ? line : `${line} (advisory)`);
    }
    if (r.environment_error) console.log(dim("  A gate could not run at all: fix the environment (missing tool, bad cwd) before spending a review round."));
  });
  return r.ok ? 0 : r.environment_error ? 2 : 1;
}

/**
 * What a harness pipes to a hook, or null when it never ends. A wrapper can swallow the piped JSON (a PowerShell
 * `if {}` around the command did), and `readFileSync(0)` then waits for an EOF that never comes: the hook hangs until
 * the harness's own watchdog kills it, and a killed hook lets the tool call through. So the wait is bounded.
 * AGENT_FLOW_HOOK_STDIN_MS overrides the bound (tests, slow machines).
 */
function readHookInput(defaultMs = 10_000) {
  const ms = Number(process.env.AGENT_FLOW_HOOK_STDIN_MS) > 0 ? Number(process.env.AGENT_FLOW_HOOK_STDIN_MS) : defaultMs;
  return new Promise((resolveInput) => {
    let text = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.pause();
      resolveInput(value);
    };
    const timer = setTimeout(() => finish(null), ms);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", () => finish(text));
    process.stdin.on("error", () => finish(null));
  });
}

/**
 * Claude Code Stop hook: exit 2 + reason on stderr keeps the session working, exit 0 lets it stop. Never traps a
 * session: bounded per turn (see stopgate.ts), and an error in the hook itself lets the stop through.
 */
async function gatesStop(rt, man) {
  let ev = {};
  try {
    const raw = await readHookInput(5_000);
    ev = JSON.parse((raw ?? "").replace(/^\uFEFF/, "") || "{}"); // Cursor on Windows prefixes stdin with a BOM
  } catch {
    /* no hook input: treat as a fresh stop */
  }
  // A pipeline role has its own gates (the orchestrator runs them); this is for interactive sessions.
  if (process.env.AGENT_FLOW_ROLE) return 0;
  try {
    const cwd = typeof ev.cwd === "string" && ev.cwd ? fsutil.findRepoRoot(ev.cwd) : rt;
    const d = stopGateLib.evaluateStop(cwd, gatesLib.gatesOf(man), stopGateLib.maxStopBlocks(man), ev.stop_hook_active === true);
    // Exit 2 shows the reason to the model; on a pass-through only `systemMessage` reaches anyone (the user).
    if (d.block) console.error(d.message);
    else if (d.message) console.log(JSON.stringify({ systemMessage: d.message }));
    return d.block ? 2 : 0;
  } catch (e) {
    console.error(`[agent-flow stop gate] not run: ${e.message}`);
    return 0;
  }
}

function cmdConfig(args) {
  if (args._[1] !== "get" || typeof args._[2] !== "string") return sub("config", args._[1], ["get"], "config get <dotted.key>   e.g. config get pipeline.harness_by_role.reviewer");
  let v = manifestLib.trustedManifest(root()).manifest;
  if (!v) {
    console.error("agent-flow: no readable CONTEXT_MANIFEST.json here");
    return 1;
  }
  for (const k of args._[2].split(".")) v = v && typeof v === "object" && Object.hasOwn(v, k) ? v[k] : undefined;
  if (v !== undefined) console.log(typeof v === "string" ? v : JSON.stringify(v));
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
    r = classify.classifyDiff(cwd, rt, manifestLib.trustedManifest(rt).manifest, args.base, args.head);
  } catch (e) {
    if (/cannot determine a default branch/.test(e.message)) throw new UserError("can't tell which branch to diff against — pass --base <branch>");
    throw e;
  }
  out(args, r, () => {
    const col = r.risk_level === "critical" ? 31 : r.risk_level === "medium" ? 33 : 32;
    console.log(`risk: ${c(col, r.risk_level)}  reviewer: ${r.reviewer_tier}  human approval: ${r.human_approval_required ? "required" : "no"}  ${dim(`${r.files.length} files vs ${r.base}`)}`);
    for (const reason of r.reasons) console.log(`  - ${reason}`);
    if (r.protected_violations.length) bad(`protected paths touched: ${r.protected_violations.join(", ")}`);
    if (r.review_required.length) warn(`review-only paths changed (a person reviews the pull request): ${r.review_required.join(", ")}`);
    for (const v of r.review_violations) bad(`review-only path ${v.file}: ${v.why}`);
    for (const v of r.policy_violations) bad(`policy (${v.rule}): ${v.message}`);
    if (r.used_heuristics) warn("no risk_boundaries in the manifest: the level above is a path-name guess");
  });
  if (args["fail-on-protected"] && r.protected_violations.length) return 1;
  if (args["fail-on-critical"] && r.risk_level === "critical") return 1;
  if (args["fail-on-policy"] && r.policy_violations.length) return 1;
  if (args["fail-on-heuristic"] && r.used_heuristics) return 1;
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
  const secretIgnore = manifestLib.secretIgnorePaths(manifestLib.trustedManifest(rt).manifest);
  const blobs = git.stagedBlobs(rt, files.filter((f) => !manifestLib.matchAny(secretIgnore, f)));
  for (const [f, blob] of blobs) {
    if (!blob || blob.subarray(0, 8000).includes(0)) continue; // deleted, huge or binary
    for (const s of risk.findSecrets(blob.toString("utf-8"))) problems.push(`possible ${s.kind} in ${f} line(s) ${s.lines.join(", ")} (value not shown; if it is a fake, put \`${risk.ALLOW_SECRET_MARKER}\` on or above the line, or list the file in secret_scan.ignore_paths)`);
  }
  const trustedMan = manifestLib.trustedManifest(rt);
  const policy = policyLib.policyOf(trustedMan.manifest);
  if (trustedMan.ignoredEdits.includes("policy")) console.error(dim(`  note: policy edits in the working copy are ignored until merged to the default branch (${manifestLib.TRUST_WORKING_MANIFEST_ENV}=1 to try them).`));
  if (policy) {
    const stats = new Map();
    const num = git.git(["-c", "core.quotepath=off", "diff", "--cached", "--numstat", "-z", "--no-renames"], rt);
    for (const rec of (num.ok ? num.stdout : "").split("\0").filter(Boolean)) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(rec);
      if (m) stats.set(m[3], m[1] === "-" ? null : { added: Number(m[1]), removed: Number(m[2]) });
    }
    const added = (f) => {
      const d = git.git(["-c", "core.quotepath=off", "diff", "--cached", "-U0", "--no-color", "--no-renames", "--", f], rt);
      return d.ok ? d.stdout.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)) : [];
    };
    for (const v of policyLib.evaluatePolicy(policy, files, stats, added)) problems.push(`policy (${v.rule}): ${v.message}`);
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
  const action = args._[1] ?? "show";
  if (action === "show") {
    const s = state.readState(rt);
    if (args.issue !== undefined) {
      // A bare `--issue` parses as `true`; Number(true) is 1, which silently
      // showed issue #1. Validate like every other issue-taking command.
      const n = issueNumber(args.issue, "state show --issue <n>");
      const one = s.sessions.find((x) => x.issue === n) ?? null;
      const limit = manifestLib.maxReviewRounds(manifestLib.trustedManifest(rt).manifest);
      const view = { issue: n, state: one?.state ?? null, phase: one?.phase ?? null, round: one?.round ?? 0, max_review_rounds: limit, reason: one?.reason ?? null };
      out(args, view, () => console.log(one ? `issue #${n}: ${one.state}${one.phase ? ` / ${one.phase}` : ""} (round ${one.round ?? 0} of ${limit})${one.reason ? ` — ${one.reason}` : ""}` : `issue #${n}: no state yet (round limit ${limit})`));
      return 0;
    }
    out(args, s, () => process.stdout.write(state.renderMarkdown(s)));
    return 0;
  }
  if (action === "update") {
    const p = {
      issue: issueNumber(args.issue, "state update --issue <n> --state <s>"),
      state: args.state,
      phase: typeof args.phase === "string" ? args.phase : undefined,
      round: args.round === undefined ? undefined : roundNumber(args.round),
      reason: typeof args.reason === "string" ? args.reason : undefined,
      reopen: !!args.reopen,
    };
    const trustedMan = manifestLib.trustedManifest(rt).manifest;
    const session = state.readState(rt).sessions.find((s) => s.issue === p.issue);
    const esc = bindingLib.bindingEscalation(rt, p, session, gatesLib.gatesOf(trustedMan));
    if (esc) {
      const e = state.updateState(rt, esc.params, manifestLib.maxReviewRounds(trustedMan), manifestLib.maxCostUsd(trustedMan));
      out(args, { ...e, binding: esc.binding }, () => {
        warn(`issue #${e.updated} can't be Completed: ${esc.binding.problems.join("; ")}`);
        warn(`recorded as Needs Me (unreviewed_commits)`);
      });
      return 3;
    }
    const r = state.updateState(rt, p, manifestLib.maxReviewRounds(trustedMan), manifestLib.maxCostUsd(trustedMan));
    out(args, r, () => (r.escalated ? warn : ok)(`issue #${r.updated}: ${r.from ?? "(new)"} → ${r.state} (round ${r.round})${r.reason ? ` — ${r.reason}` : ""}`));
    // Distinct exit code so a script can't miss the escalation by only checking for failure.
    return r.escalated ? 3 : 0;
  }
  if (action === "dismiss") {
    const issue = issueNumber(args.issue, "state dismiss --issue <n> --reason <why>");
    const reason = typeof args.reason === "string" ? args.reason : "";
    if (!reason.trim()) throw new UserError('say why it is being dropped: state dismiss --issue <n> --reason "<why>"');
    // A run that is still working on it would go on writing: refuse while one is alive.
    const artifacts = join(rt, ".agent-flow", "artifacts", `issue-${issue}`);
    if (existsSync(artifacts)) {
      const held = orchestrateLib.acquireRunLock(artifacts);
      if ("heldBy" in held) throw new UserError(`#${issue} is being worked on right now${held.heldBy ? ` (process ${held.heldBy})` : ""}. Stop that run first (Ctrl-C), then dismiss it.`);
      held.release();
    }
    const r = state.dismissSession(rt, issue, reason);
    out(args, { issue, ...r }, () => {
      if (!r.dismissed) return warn(`#${issue} is not in the list, so there is nothing to drop`);
      ok(`#${issue} dropped from the list (it was ${r.from}). Its files stay in ${relative(rt, artifacts) || artifacts}; remove its worktree with: agent-flow worktree remove ${issue}`);
    });
    return r.dismissed ? 0 : 1;
  }
  return sub("state", args._[1], ["show", "update", "dismiss"], "state [show] | state update --issue <n> --state <s> … | state dismiss --issue <n> --reason <why>");
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
    head: intOr(args.issue) ? bindingLib.branchTip(root(), intOr(args.issue)) : undefined,
    verdict: r.ok && typeof r.report?.status === "string" ? r.report.status : undefined,
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

/** `manifest sync`: rebuild context_files from the context files on disk; every human-owned key is kept. */
function cmdManifest(args) {
  if (args._[1] !== "sync") return sub("manifest", args._[1], ["sync"], "manifest sync [--dry-run] [--yes]");
  const rt = root();
  const path = manifestLib.manifestPathFor(rt, args.manifest);
  if (!existsSync(path)) throw new UserError("no CONTEXT_MANIFEST.json — `agent-flow init` creates one");
  const raw = readFileSync(path, "utf-8");
  let existing;
  try {
    existing = JSON.parse(raw.replace(/^﻿/, ""));
  } catch (e) {
    throw new UserError(`CONTEXT_MANIFEST.json isn't valid JSON (${e.message}); fix it first`);
  }
  const plan = initLib.syncManifest(rt, existing, { version: VERSION });
  const next = `${JSON.stringify(plan.manifest, null, mergeLib.detectJsonIndent(raw))}\n`;
  const changed = JSON.stringify({ ...existing, last_full_scan: 0, generated_by: 0 }) !== JSON.stringify({ ...plan.manifest, last_full_scan: 0, generated_by: 0 });
  const write = changed && !!args.yes && !args["dry-run"];
  if (write) {
    writeFileSync(path, raw.startsWith("﻿") ? `﻿${next}` : next);
    state.appendAudit(rt, { event: "manifest_sync", via: "cli", added_files: plan.added_files, removed_files: plan.removed_files, added_refs: plan.added_refs, removed_refs: plan.removed_refs });
  }
  const { manifest: _m, ...summary } = plan;
  out(args, { ...summary, changed, written: write }, () => {
    for (const f of plan.added_files) ok(`context file added: ${f}`);
    for (const f of plan.removed_files) warn(`context file gone: ${f}`);
    console.log(`${plan.added_refs} reference(s) added, ${plan.removed_refs} removed; protected paths, risk boundaries and gates untouched`);
    for (const m of plan.missing_references) warn(`${m.file} names \`${m.path}\`, which doesn't exist (not recorded)`);
    if (!changed) ok("manifest already matches the context files");
    else if (write) ok(`wrote ${relative(rt, path) || "CONTEXT_MANIFEST.json"}`);
    else console.log(dim("nothing written — re-run with --yes to write it"));
  });
  return 0;
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

async function cmdGuard(args) {
  if (args.check) return guardCheck(args);
  // A guard that broke must not become a way past it: refuse whenever a role, a manifest (on disk or
  // committed) or AGENT_FLOW_GUARD_STRICT=1 says protection is wanted. Only an unconfigured session is left alone.
  const fail = (role, msg, cwd = process.cwd()) => {
    console.error(`[agent-flow guard] ${msg}`);
    return role || manifestLib.guardFailsClosed(fsutil.findRepoRoot(cwd)) ? 2 : 0;
  };
  const env = guardLib.parseRole(process.env.AGENT_FLOW_ROLE);
  let ev;
  try {
    const raw = await readHookInput();
    // Nothing arrived and the pipe never closed: not an allow. Refuse wherever protection is wanted (same rule as a guard error).
    if (raw === null) return fail(env.role, "no hook input arrived on stdin (a wrapper may be swallowing it), so this call can't be checked");
    ev = JSON.parse(raw.replace(/^\uFEFF/, "") || "{}"); // Cursor on Windows prefixes stdin with a BOM
  } catch (e) {
    return fail(env.role, `unreadable hook input: ${e.message}`);
  }
  // Cursor's beforeShellExecution / beforeReadFile carry no tool_name: a `command` is a shell call, a bare `file_path` a read.
  if (!ev.tool_name && typeof ev.command === "string") ev = { ...ev, tool_name: "Bash", tool_input: { command: ev.command } };
  else if (!ev.tool_name && typeof ev.file_path === "string") ev = { ...ev, tool_name: "Read", tool_input: { file_path: ev.file_path } };
  if (!ev.cwd && Array.isArray(ev.workspace_roots) && typeof ev.workspace_roots[0] === "string") ev.cwd = ev.workspace_roots[0];
  // A subagent launched as one of our roles (e.g. the orchestrator's `reviewer`) runs under that role.
  if (typeof ev.tool_input === "string") ev.tool_input = { command: ev.tool_input };
  const role = guardLib.ROLES.includes(ev.agent_type) ? ev.agent_type : env.role;
  try {
    const baseCwd = typeof ev.cwd === "string" && ev.cwd ? ev.cwd : process.cwd();
    const rt = fsutil.findRepoRoot(baseCwd);
    // `workdir` / `dir_path` move a shell call to another directory: judge it from there.
    const cwd = ev.tool_input && typeof ev.tool_input === "object" && guardLib.isShellTool(String(ev.tool_name ?? "").toLowerCase(), String(ev.tool_name ?? "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-\s]+/g, "_").toLowerCase()) ? guardLib.workdirOf(ev.tool_input, baseCwd) : baseCwd;
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
      allowSecretRead: process.env.AGENT_FLOW_ALLOW_SECRET_READ === "1",
    });
    if (!decision) return 0;
    try {
      state.appendAudit(rt, { event: "guard_block", harness: "claude", role, tool: ev.tool_name, rule: decision.rule, reason: decision.reason });
    } catch {
      /* the block matters more than the log line */
    }
    console.error(decision.reason);
    // Exit 2 + stderr blocks on Claude Code, Gemini, Cursor and (per its docs) Codex. Also say it as JSON on
    // stdout, which Codex documents as a second deny channel; the other harnesses ignore stdout on exit 2.
    // AGENT_FLOW_GUARD_JSON_ONLY=1 (experiment): deny via JSON and exit 0, for a harness that ignores exit 2.
    console.log(JSON.stringify({ decision: "block", reason: decision.reason, permission: "deny", user_message: decision.reason, agent_message: decision.reason, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason } }));
    return process.env.AGENT_FLOW_GUARD_JSON_ONLY === "1" ? 0 : 2;
  } catch (e) {
    return fail(role, `guard error: ${e.message}`, typeof ev.cwd === "string" && ev.cwd ? ev.cwd : process.cwd());
  }
}

// --- install --------------------------------------------------------------

const RULE_NOTE = "has no hook agent-flow can use to block a call, so enforcement here is the pre-commit hook (`agent-flow hook install`) and CI; the rules file only asks.";

const TARGETS = {
  claude: { skills: ".claude/skills", agents: [[".claude/agents/reviewer.md", ".claude/agents/reviewer.md"]], note: "" },
  codex: {
    skills: ".agents/skills",
    agents: [[".codex/agents/reviewer.toml", ".codex/agents/reviewer.toml"]],
    hook: "codex",
    note: "The pipeline launches the Reviewer with `codex exec --sandbox read-only` (Codex's OS-level sandbox); .codex/agents/reviewer.toml is for delegating a review from an interactive Codex session.",
  },
  gemini: {
    skills: ".gemini/skills",
    agents: [[".gemini/agents/reviewer.md", ".gemini/agents/reviewer.md"]],
    hook: "gemini",
    note: 'Trust the workspace (/trust) and set `"context": {"fileName": ["AGENTS.md", "GEMINI.md"]}` in .gemini/settings.json so Gemini loads AGENTS.md. The pipeline runs the Reviewer as `gemini --approval-mode plan` (read-only); .gemini/agents/reviewer.md is for `@reviewer` in interactive sessions.',
  },
  cursor: { skills: ".cursor/skills", agents: [], hook: "cursor", note: "Cursor reads AGENTS.md natively." },
  copilot: { skills: ".github/skills", agents: [], note: "VS Code / Copilot also reads .claude/skills and .agents/skills." },
  windsurf: { skills: ".agents/skills", agents: [], note: "Windsurf (Cascade) reads AGENTS.md natively, including per-directory AGENTS.md in monorepos. No skill-folder or read-only-subagent mechanism is documented for it, so enforcement here is the pre-commit hook." },
  opencode: {
    skills: ".agents/skills",
    agents: [],
    plugin: true,
    note: "Wrote .opencode/plugins/agent-flow-guard.js: a tool.execute.before plugin that runs agent-flow's guard before every tool call and denies the call on a block. Restart opencode to load it. Live verification pending: run the probe in docs/HARNESS-MATRIX.md.",
  },
  // Hosts whose skills folder or rules file follows a documented convention. Not run live here: instruction-tier, so none of them is listed as enforcing in docs/HARNESS-MATRIX.md.
  swival: { skills: ".swival/skills", agents: [], note: "Swival also reads AGENTS.md from the project root. It has no hook agent-flow can use to block a call, so enforcement here is the pre-commit hook and CI." },
  factory: { skills: ".factory/skills", agents: [], note: "Factory Droid reads AGENTS.md from the working directory up to the git root. It has no hook agent-flow can use to block a call, so enforcement here is the pre-commit hook and CI." },
  commandcode: { skills: ".commandcode/skills", agents: [], note: "Command Code reads AGENTS.md as project memory. It has no hook agent-flow can use to block a call, so enforcement here is the pre-commit hook and CI." },
  cline: { skills: ".agents/skills", agents: [["templates/rules/agent-flow.md", ".clinerules/agent-flow.md"]], note: `Wrote .clinerules/agent-flow.md. Cline ${RULE_NOTE}` },
  kiro: { skills: ".agents/skills", agents: [["templates/rules/agent-flow.kiro.md", ".kiro/steering/agent-flow.md"]], note: `Wrote .kiro/steering/agent-flow.md (always included). Kiro ${RULE_NOTE}` },
  qoder: { skills: ".agents/skills", agents: [["templates/rules/agent-flow.md", ".qoder/rules/agent-flow.md"]], note: `Wrote .qoder/rules/agent-flow.md; Qoder also loads AGENTS.md on its own. Qoder ${RULE_NOTE}` },
  agents: { skills: ".agents/skills", agents: [], note: ".agents/skills is the cross-client convention — also the right target for Aider, Zed, Warp, Amp, opencode, goose, JetBrains Junie, RooCode, and anything else that reads AGENTS.md but has no harness-specific integration below." },
};

/**
 * Which harnesses are installed in `rt`. Several share one skills folder (.agents/skills), so the folder alone can't say
 * which: a harness counts when the install record names it, or its own wiring (a hook file, the OpenCode plugin, a rules
 * file) is in place. `update` and `uninstall` both ask this, so neither treats a harness nobody installed as installed
 * (which would write its rules file on update and report it on uninstall).
 */
function installedHarnesses(rt) {
  const everything = Object.keys(TARGETS);
  const wired = (rel) => {
    try {
      return readFileSync(join(rt, rel), "utf-8").includes("agent-flow");
    } catch {
      return false;
    }
  };
  const ownWiring = (h) => (h === "claude" ? wired(".claude/settings.json") : TARGETS[h].hook ? wired(HOOK_FILES[TARGETS[h].hook].path) : TARGETS[h].plugin ? wired(".opencode/plugins/agent-flow-guard.js") : TARGETS[h].agents.some(([, to]) => wired(to)));
  const present = (h) => existsSync(join(rt, TARGETS[h].skills, "bootstrap")) || !!updateLib.readRecord(rt, TARGETS[h].skills);
  const installed = everything.filter((h) => present(h) && (updateLib.readRecord(rt, TARGETS[h].skills)?.harness === h || ownWiring(h)));
  const byDir = (dir) => everything.filter((h) => TARGETS[h].skills === dir && present(h));
  // An install from before the record existed: the folder is there, but nothing names whose it is.
  for (const dir of new Set(everything.map((h) => TARGETS[h].skills))) {
    const owners = byDir(dir);
    // The generic `agents` target is the one that owns a shared folder when nothing says otherwise.
    if (owners.length && !owners.some((h) => installed.includes(h))) installed.push(owners.includes("agents") ? "agents" : owners[0]);
  }
  return installed;
}

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

// ---------------------------------------------------------------------------
// run: one task from words to a reviewed, tested change (the Orchestrator skill as code)
// ---------------------------------------------------------------------------

const SELF_BIN = fileURLToPath(import.meta.url);

/** Calls an agent-flow subcommand from the repo root, the way the orchestrator needs to (no role, no network lookups). */
/** Set by `run` while it works: a child that died of Ctrl-C ends the run at once, instead of reading as a failure. */
let interruptHook = null;

function afCaller(rt) {
  return (a) => {
    const env = { ...process.env, NO_COLOR: "1", AGENT_FLOW_OFFLINE: "1" };
    delete env.AGENT_FLOW_ROLE;
    const r = spawnSync(process.execPath, [SELF_BIN, ...a], { cwd: rt, encoding: "utf-8", env, maxBuffer: 64 * 1024 * 1024 });
    const sig = launchLib.interruptSignal(r);
    if (sig && interruptHook) interruptHook(sig);
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

function shCaller() {
  return (cmd, a, cwd) => {
    const r = spawnSync(launchLib.resolveExecutable(cmd), a, { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
    const sig = launchLib.interruptSignal(r);
    if (sig && interruptHook) interruptHook(sig);
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error.message) : "") };
  };
}

const safeJson = (text) => {
  try {
    return JSON.parse(text || "{}") ?? {};
  } catch {
    return {};
  }
};

const fmtElapsed = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

/** Everything `run` needs to know before it launches anything, as a list of plain-language problems (with the fix). */
function runPreflight(rt, af, harness, { pr = false } = {}) {
  const problems = [];
  const loaded = manifestLib.loadManifest(rt, undefined);
  if (!loaded.ok) {
    if (loaded.error === "manifest_not_found") problems.push("this repo isn't set up yet — run `npx @drix10/agent-flow install --harness claude`, then ask Claude to use the bootstrap skill");
    else problems.push(`CONTEXT_MANIFEST.json can't be read (${loaded.error}); run \`npx @drix10/agent-flow doctor\` before starting work`);
  } else if (loaded.value.problems.length) {
    const found = loaded.value.problems;
    problems.push(`CONTEXT_MANIFEST.json has ${found.length} problem${found.length === 1 ? "" : "s"}: ${found.slice(0, 2).join("; ")}${found.length > 2 ? "; …" : ""}. Fix it (\`npx @drix10/agent-flow doctor\` lists them all) before starting work`);
  }
  if (harness !== "claude") problems.push(`\`run\` drives Claude Code for now (you asked for ${harness}); Codex and Gemini still work through the invoking-agents skill`);
  else {
    // An npm .cmd shim must go through cmd.exe. Node prints a deprecation warning when arguments are passed alongside
    // `shell: true`, so in that case the whole command is one quoted string (as the role launcher does).
    const claudeExe = launchLib.resolveExecutable("claude");
    const probe = process.platform === "win32" && /\.(cmd|bat)$/i.test(claudeExe)
      ? spawnSync(`${launchLib.quoteForCmd(claudeExe)} --version`, { encoding: "utf-8", timeout: 20000, shell: true })
      : spawnSync(claudeExe, ["--version"], { encoding: "utf-8", timeout: 20000 });
    if (probe.error || probe.status !== 0) problems.push("the `claude` command isn't available on PATH — install Claude Code and log in (`claude` once), then retry");
    if (af(["guard", "--check"]).status !== 0) problems.push("the guard hook isn't wired — run `npx @drix10/agent-flow install --harness claude` (it's what confines the Implementer to its worktree)");
  }
  if (!git.git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], rt).ok) problems.push("this repo has no commits yet — make a first commit");
  if (pr) {
    const remote = git.git(["remote", "get-url", "origin"], rt);
    if (!remote.ok) problems.push("there is no `origin` remote to push the pull request branch to");
    const auth = spawnSync(launchLib.resolveExecutable("gh"), ["auth", "status"], { cwd: rt, encoding: "utf-8", timeout: 20000 });
    if (auth.error || auth.status !== 0) problems.push("GitHub CLI isn't authenticated; run `gh auth login` before using --pr");
  }
  return problems;
}

/** The test commands QA is told to run: what the repo's own gates run on this machine, or "none". */
function qaCommands(rt, override) {
  if (typeof override === "string" && override.trim()) return override.trim();
  const loaded = manifestLib.loadManifest(rt, undefined);
  const gates = loaded.ok ? gatesLib.gatesOf(loaded.value.manifest) : [];
  const here = gates.filter((g) => !(Array.isArray(g.os) && g.os.length && !g.os.includes(process.platform)));
  return here.length ? here.map((g) => gatesLib.describeCommand(g.command)).join("; ") : "none";
}

async function askLine(question) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function cmdRun(args) {
  if (process.env.AGENT_FLOW_ROLE) throw new UserError("a pipeline role can't start another pipeline run");
  const rt = root();
  const af = afCaller(rt);
  const sh = shCaller();
  const text = args._.slice(1).join(" ").trim();
  if (!text) {
    return usage('run "<what to do, and how to tell it is done>" | run <issue-number>   [--pr] [--auto-merge] [--dry-run] [--timeout <seconds>] [--commands "<tests>"] [--limit-wait <hours>]');
  }
  const harness = typeof args.harness === "string" ? args.harness : "claude";
  const wantPr = !!args.pr;
  if (args["auto-merge"] && !wantPr) throw new UserError("`--auto-merge` needs `--pr`; without it, the reviewed work stays local");
  const problems = runPreflight(rt, af, harness, { pr: wantPr });

  // Which task is this? A number is a tracked issue (resume it, or fetch it from GitHub); anything else is the task itself.
  const numeric = /^#?(\d+)$/.exec(text);
  let issue, title, body, fromGitHub = false;
  if (numeric) {
    issue = Number(numeric[1]);
    const s = safeJson(af(["state", "show", "--issue", String(issue), "--json"]).stdout);
    const art = join(rt, ".agent-flow", "artifacts", `issue-${issue}`);
    if (s.state) {
      title = existsSync(join(art, "title.txt")) ? readFileSync(join(art, "title.txt"), "utf-8").trim() : `issue #${issue}`;
      body = "";
    } else {
      const g = sh("gh", ["issue", "view", String(issue), "--json", "number,title,body"], rt);
      if (g.status !== 0) throw new UserError(`issue #${issue} isn't tracked here and GitHub didn't return it (${(g.stderr || g.stdout).trim().split("\n")[0] || "gh failed"}). Describe the task instead: agent-flow run "what to do"`);
      const j = JSON.parse(g.stdout);
      title = j.title;
      body = j.body ?? "";
      fromGitHub = true;
    }
  } else {
    const all = safeJson(af(["state", "show", "--json"]).stdout);
    // A number is taken if it has a session, saved artifacts or a worktree: an earlier attempt may have stopped before registering.
    const onDisk = (dir, prefix) => (existsSync(dir) ? readdirSync(dir).map((n) => Number(n.startsWith(prefix) ? n.slice(prefix.length) : NaN)).filter(Number.isInteger) : []);
    issue = orchestrateLib.nextInlineIssue([
      ...(all.sessions ?? []).map((x) => x.issue),
      ...onDisk(join(rt, ".agent-flow", "artifacts"), "issue-"),
      ...onDisk(join(rt, ".worktrees"), "issue-"),
    ]);
    title = text.split(/\r?\n/)[0].slice(0, 100);
    body = text;
  }

  if (body && !orchestrateLib.hasCriteria(body)) {
    const interactive = !args.json && !!process.stdin.isTTY && !!process.stdout.isTTY;
    if (!interactive) throw new UserError("the task doesn't say how to tell it is done. Add what should be true afterwards (\"…, so that <observable result>\"), or a short checklist");
    const more = await askLine("How will we know it is done? (one line, e.g. 'the tests for X pass and Y prints Z'): ");
    if (!more) throw new UserError("no acceptance criteria — nothing was started");
    body = `${body}\n\nAcceptance criteria: ${more}`;
  }

  const timeoutSec = args.timeout === undefined ? 3600 : Number(args.timeout);
  if (args.timeout !== undefined && (typeof args.timeout !== "string" || !Number.isSafeInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 86_400)) {
    throw new UserError("`--timeout` must be a whole number from 1 to 86400 seconds");
  }
  const limitWait = args["limit-wait"] === undefined ? 6 : Number(args["limit-wait"]);
  if (args["limit-wait"] !== undefined && (typeof args["limit-wait"] !== "string" || !Number.isFinite(limitWait) || limitWait < 0 || limitWait > 168)) {
    throw new UserError("`--limit-wait` must be a number of hours from 0 to 168 (0: don't wait for a usage limit to reset)");
  }
  const commands = qaCommands(rt, args.commands);
  if (args["dry-run"]) {
    out(args, { issue, title, harness, pr: wantPr, timeout_s: timeoutSec, qa_commands: commands, ready: problems.length === 0, setup_issues: problems }, () => {
      console.log(`Would run issue #${issue} (${title}) with ${harness}:`);
      console.log("  1. a worktree on agent/issue-" + issue + ", then Implementer → risk check → Reviewer → gates → QA, up to the manifest's round cap");
      console.log(`  2. QA would run: ${commands}`);
      console.log(`  3. ${wantPr ? "push the branch and open a pull request" : "stop with the work ready locally (add --pr to push and open a pull request)"}`);
      if (problems.length) {
        console.log("  Setup needed before a real run:");
        for (const p of problems) console.log(`    - ${p}`);
      }
      console.log(dim("nothing was started (dry run)"));
    });
    return 0;
  }

  if (problems.length) {
    if (args.json) console.log(JSON.stringify({ status: "error", issue, reason: "setup needed before a run", setup_issues: problems }, null, 2));
    else for (const p of problems) bad(p);
    return 2;
  }

  const t0 = Date.now();
  const emit = args.json ? console.error : console.log;
  const log = (e) => {
    const stamp = dim(`[${fmtElapsed(Date.now() - t0)}]`);
    if (e.kind === "step") emit(`${stamp} ${c(1, e.text)}`);
    else if (e.kind === "warn") emit(`${stamp} ${c(33, "!")} ${e.text}`);
    else emit(`${stamp} ${dim(e.text)}`);
  };
  // Ctrl-C or a terminated terminal must not leave an agent working unattended or the issue locked. State is saved, so it resumes.
  const interrupted = (signal) => {
    const stopped = launchLib.killActiveChildren();
    orchestrateLib.releaseHeldLocks();
    console.error(`
${signal}: stopped ${stopped} running role${stopped === 1 ? "" : "s"}. Progress is saved; continue with: agent-flow run ${issue}`);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  interruptHook = interrupted;
  process.once("SIGINT", () => interrupted("SIGINT"));
  process.once("SIGTERM", () => interrupted("SIGTERM"));
  const result = await orchestrateLib.runIssue({ root: rt, issue, title, body, fromGitHub, af, sh, spawner: launchLib.realSpawner, log, pr: wantPr, timeoutSec, commands, autoMerge: !!args["auto-merge"] && !args["no-auto-merge"], limitWaitSec: Math.round(limitWait * 3600) });

  out(args, result, (r) => {
    console.log("");
    const cost = r.cost_usd ? dim(`  ($${r.cost_usd.toFixed(2)}${r.unreported_runs ? ", some runs didn't report cost" : ""})`) : "";
    if (r.status === "pr") ok(`Pull request ready: ${r.pr}${cost}`);
    else if (r.status === "ready") {
      ok(`Done and checked, not pushed. Branch ${r.branch}${cost}`);
      console.log(dim(`  risk:     ${r.risk ?? "unknown"}`));
      if (r.risk === "critical") warn(`This touches a critical area. Read the diff yourself before publishing: \`run ${r.issue} --pr\` opens a draft pull request that waits for your review`);
      else if (r.human_review) warn(`This changes CI or test configuration (review-only paths). Read the diff before publishing: \`run ${r.issue} --pr\` opens a draft pull request that waits for your review`);
      console.log(dim(`  look:     git -C ${relative(rt, r.worktree) || r.worktree} log --oneline -5 && git -C ${relative(rt, r.worktree) || r.worktree} diff --stat`));
      console.log(dim(`  publish:  agent-flow run ${r.issue} --pr`));
    } else if (r.status === "completed") ok(`Already finished: ${r.reason ?? ""}`);
    else if (r.status === "needs_me") {
      warn(`This needs you — ${r.reason}${cost}`);
      console.log(dim(`  details:  ${relative(rt, r.artifacts) || r.artifacts}/`));
      const sendBack = `agent-flow state update --issue ${r.issue} --state Working --phase implement --round ${Math.max(1, r.round || 1)}`;
      if (r.category === "protected_path") {
        // A protected path is a person's to change; the Implementer is told to stop, with or without the guard override.
        console.log(dim("  then:     change it yourself: agents may not edit protected paths"));
      } else if (r.category === "review_required" || r.category === "critical_change_needs_human") {
        // The work is done and pushed; what is left is a person reading the diff.
        console.log(dim(`  then:     read the diff and merge the pull request${r.pr ? `: ${r.pr}` : ""}`));
      } else {
        const raise = r.category === "max_rounds_exceeded" ? "raise pipeline.max_review_rounds in CONTEXT_MANIFEST.json, then " : r.category === "budget_exceeded" ? "raise pipeline.max_cost_usd in CONTEXT_MANIFEST.json, then " : r.category === "SPEC_ERROR" ? `fix the criteria in ${relative(rt, r.artifacts)}/issue.md, then ` : "";
        console.log(dim(`  then:     ${raise}to go on: ${sendBack}; agent-flow run ${r.issue}`));
      }
      console.log(dim(`  or drop:  agent-flow state dismiss --issue ${r.issue} --reason "<why>"`));
    } else bad(`Stopped before starting work: ${r.reason}`);
  });
  return result.status === "needs_me" ? 3 : result.status === "error" ? 1 : 0;
}

// ---------------------------------------------------------------------------
// status: everything you need to know about this repo's protection and pending work, on one screen
// ---------------------------------------------------------------------------

function cmdStatus(args) {
  const rt = root();
  const rows = [];
  const add = (section, level, text, hint) => rows.push({ section, level, text, ...(hint ? { hint } : {}) });

  // Protection: is anything actually stopping an agent?
  const guardOk = spawnSync(process.execPath, [SELF_BIN, "guard", "--check"], { cwd: rt, encoding: "utf-8" }).status === 0;
  const claudeSettings = existsSync(join(rt, ".claude", "settings.json"));
  const otherHooks = [".codex/hooks.json", ".gemini/settings.json", ".cursor/hooks.json", ".opencode/plugins/agent-flow-guard.js"].filter((p) => existsSync(join(rt, p)));
  if (guardOk) add("Protection", "ok", "Claude Code guard hook is active");
  else if (claudeSettings) add("Protection", "bad", "Claude settings exist, but the Agent Flow guard hook is missing or invalid", "npx @drix10/agent-flow install --harness claude");
  else if (otherHooks.length) add("Protection", "warn", `guard configuration found for ${otherHooks.map((p) => p.split("/")[0].replace(".", "")).join(", ")} (not verified active)`, "check the harness hook configuration and ensure the Agent Flow runtime is installed");
  else add("Protection", "bad", "no guard hook: agents are not being stopped from touching protected files or secrets", "npx @drix10/agent-flow install --harness claude");
  const hooksDirRel = git.git(["rev-parse", "--git-path", "hooks"], rt);
  const preCommit = hooksDirRel.ok ? join(resolve(rt, hooksDirRel.stdout.trim()), "pre-commit") : null;
  if (preCommit && existsSync(preCommit) && readFileSync(preCommit, "utf-8").includes(HOOK_MARKER)) add("Protection", "ok", "pre-commit gate is installed");
  else add("Protection", "warn", "no pre-commit gate in this clone (git doesn't copy hooks)", "npx @drix10/agent-flow hook install");

  const loaded = manifestLib.loadManifest(rt, undefined);
  let gates = [];
  if (!loaded.ok) {
    add("Protection", "bad", "no CONTEXT_MANIFEST.json: nothing says what to protect", "npx @drix10/agent-flow install --harness claude, then ask Claude to use the bootstrap skill");
  } else {
    const man = loaded.value.manifest;
    const prot = (man.protected_paths ?? []).length;
    const crit = (man.risk_boundaries ?? []).filter((b) => b.risk_level === "critical").length;
    if (prot) add("Protection", "ok", `${prot} protected path${prot === 1 ? "" : "s"}, ${crit} critical area${crit === 1 ? "" : "s"}`);
    else add("Protection", "warn", "no protected paths set: only secrets and git internals are guarded", "ask Claude to use the bootstrap skill and answer the risk questions");
    const reviewOnly = manifestLib.reviewPathsOf(man).length;
    if (reviewOnly) add("Protection", "ok", `${reviewOnly} review-only path${reviewOnly === 1 ? "" : "s"}: agents may add lines (a new CI test), a person reviews the pull request`);
    if (crit && !man.pipeline?.models?.high_reasoning) {
      add("Protection", "warn", `${crit} critical area${crit === 1 ? "" : "s"}, but no stronger model is set for reviewing them, so a critical change is reviewed by the same model as any other`, 'add "models": { "high_reasoning": "<model>" } under "pipeline" in CONTEXT_MANIFEST.json');
    }
    gates = gatesLib.gatesOf(man);
    if (man.pipeline?.auto_merge_low_risk === true) add("Protection", "warn", "auto-merge is allowed: `run --pr --auto-merge` queues low-risk pull requests that pass QA (pipeline.auto_merge_low_risk)", "set it to false in CONTEXT_MANIFEST.json until you trust the pipeline here");
  }

  // Context: do the notes still match the code?
  const d = stale.detectStale(rt, { prose: true, discover: true });
  if (!d.ok) add("Context", "bad", `the manifest can't be read (${d.error})`, "npx @drix10/agent-flow doctor");
  else if (d.healthy) add("Context", "ok", "context files match the code");
  else if (d.only_stale) add("Context", "warn", `${d.report.stale_files.length} context file${d.report.stale_files.length === 1 ? "" : "s"} not re-checked recently`, "npx @drix10/agent-flow doctor");
  else {
    const r = d.report;
    const why = r.schema_problems.length ? `CONTEXT_MANIFEST.json has a problem: ${r.schema_problems[0]}`
      : r.missing_paths.length ? `${r.missing_paths.length} path${r.missing_paths.length === 1 ? "" : "s"} named in the context files no longer exist (e.g. ${r.missing_paths[0].path})`
      : r.missing_context_files.length ? `context file missing: ${r.missing_context_files[0]}`
      : r.unfilled_placeholders.length ? "a context file still has {{placeholders}}"
      : "context files disagree with the code";
    add("Context", "bad", why, "npx @drix10/agent-flow doctor");
  }

  // Checks: which gates can run on this machine?
  if (gates.length) {
    const here = gates.filter((g) => !(Array.isArray(g.os) && g.os.length && !g.os.includes(process.platform)));
    const skipped = gates.length - here.length;
    const osName = (o) => ({ linux: "Linux", darwin: "macOS", win32: "Windows" })[o] ?? o;
    const needs = [...new Set(gates.filter((g) => !here.includes(g)).flatMap((g) => g.os ?? []))].map(osName).join("/");
    const runs = `${here.length} check${here.length === 1 ? "" : "s"} run${here.length === 1 ? "s" : ""} here`;
    add("Checks", skipped ? "warn" : "ok", skipped ? `${runs}; ${skipped} need${skipped === 1 ? "s" : ""} ${needs} and ${skipped === 1 ? "is" : "are"} skipped (CI runs them)` : runs, skipped ? `use a ${needs} clone for the full set` : undefined);
  } else add("Checks", "warn", "no checks (gates) defined: the pipeline can't prove a change works", "ask Claude to use the bootstrap skill");

  // Work: what is waiting on you?
  const sessions = state.readState(rt).sessions ?? [];
  const waiting = sessions.filter((s) => s.state === "Needs Me");
  const working = sessions.filter((s) => s.state === "Working");
  if (waiting.length) for (const s of waiting) {
    // Finished work waiting for a person to read the diff isn't a decision to send back: merge it, then close the issue.
    const review = /^(review_required|critical_change_needs_human):/.test(String(s.reason ?? ""));
    add("Work", "warn", `#${s.issue} needs you: ${String(s.reason ?? "").slice(0, 160)}`, review
      ? `read the pull request and merge it, then: agent-flow state update --issue ${s.issue} --state Completed --reason "merged"`
      : `decide, then: agent-flow state update --issue ${s.issue} --state Working --phase implement --round ${Math.max(1, Number(s.round) || 1)}; agent-flow run ${s.issue}`);
  }
  else add("Work", "ok", "nothing is waiting on you");
  for (const s of working) {
    // The publish checkpoint is recorded once review, gates and QA have passed: finished, waiting for a person to publish.
    if (s.phase === "publish") add("Work", "info", `#${s.issue} is ready: reviewed, checked, not pushed`, `agent-flow run ${s.issue} --pr  to open the pull request`);
    else add("Work", "info", `#${s.issue} in progress (round ${s.round ?? 1}, ${s.phase ?? "?"})`, `agent-flow run ${s.issue}  to resume`);
  }

  // Deferred shortcuts (`lean:` comments): quiet unless there are some.
  try {
    const debt = debtLib.scanDebt(rt, { maxFiles: 20_000, budgetMs: 1_500 });
    if (debt.rows.length) {
      const noTrigger = debt.rows.filter((x) => x.no_trigger).length;
      add("Work", noTrigger ? "warn" : "info", `${debt.rows.length} deferred shortcut${debt.rows.length === 1 ? "" : "s"} (lean: comments)${noTrigger ? `, ${noTrigger} with no trigger to revisit them` : ""}`, "agent-flow debt");
    }
  } catch {
    /* a scan that fails must not take the status screen with it */
  }

  // Updates
  const n = updateLib.updateNotice(rt, VERSION, { check: updateLib.updateCheckAllowed() && !args.offline && !args.json && !!process.stdout.isTTY });
  add("Updates", n ? "warn" : "ok", n ? n.message : `agent-flow ${VERSION} is current`);

  const bad_ = rows.some((r) => r.level === "bad");
  out(args, { version: VERSION, repo: basename(rt), ok: !bad_, rows }, () => {
    console.log(c(1, `agent-flow ${VERSION} · ${basename(rt)}`));
    let section = "";
    for (const r of rows) {
      if (r.section !== section) {
        section = r.section;
        console.log(`\n${c(1, section)}`);
      }
      const mark = r.level === "ok" ? c(32, "✓") : r.level === "bad" ? c(31, "✗") : r.level === "warn" ? c(33, "!") : dim("·");
      console.log(`  ${mark} ${r.text}`);
      if (r.hint && r.level !== "ok") console.log(dim(`      → ${r.hint}`));
    }
    console.log("");
  });
  return bad_ ? 1 : 0;
}

/** What install wrote, as hashes, so `update` can tell an older agent-flow file from one you edited. */
function recordInstall(rt, harness, t, plan, opts = {}) {
  const prev = updateLib.readRecord(rt, t.skills);
  // Several harnesses can share one skills folder, hence one record: what another of them wrote stays listed.
  const files = { ...(prev?.files ?? {}) };
  // A file is recorded only if it is exactly what this agent-flow writes. One the user edited (install refused to
  // overwrite it, update kept it) keeps its old record or none, so a later update still sees it as edited.
  for (const [src, dst, label] of plan) {
    const have = updateLib.hashTree(dst);
    if (have && have === updateLib.hashTree(src)) files[label] = have;
    else if (prev?.files[label]) files[label] = prev.files[label];
  }
  for (const [label, hash] of Object.entries(opts.extra ?? {})) if (hash) files[label] = hash;
  const plugin = ".opencode/plugins/agent-flow-guard.js";
  if (t.plugin && !files[plugin] && prev?.files[plugin]) files[plugin] = prev.files[plugin];
  if (opts.vendorWritten) files[VENDOR_DIR] = updateLib.hashTree(join(rt, VENDOR_DIR));
  else if (prev?.files[VENDOR_DIR]) files[VENDOR_DIR] = prev.files[VENDOR_DIR];
  updateLib.writeRecord(rt, t.skills, { version: VERSION, harness, files });
}

/**
 * `update [--yes] [--check] [--force]`: bring what `install` wrote up to this agent-flow's version. A file nobody has
 * edited since install is replaced; one you edited is kept (and listed) unless --force. Run it with the newer CLI:
 * `npx @drix10/agent-flow@latest update --yes`.
 */
function cmdUpdate(args) {
  const rt = root();
  const vendorDir = join(rt, VENDOR_DIR);
  const vendored = existsSync(vendorDir);
  const selfIsVendored = vendored && resolve(pkgRoot) === resolve(vendorDir);
  if (selfIsVendored) {
    // The vendored copy has no newer version inside it and doesn't ship the skills: the new CLI has to do the update.
    const latest = updateLib.updateCheckAllowed() && !args.offline ? updateLib.latestVersion() : null;
    const available = !!latest && updateLib.isNewer(latest, VERSION);
    out(args, { version: VERSION, self_is_vendored: true, latest, update_available: available }, () => {
      console.log(`This is the vendored copy (${VERSION}); it can't update itself.${available ? ` ${latest} is available.` : ""}`);
      console.log(dim(`  To update: npx ${PACKAGE}@latest update --yes`));
    });
    return args.check && available ? 10 : 0;
  }
  const installed = installedHarnesses(rt);
  if (!installed.length && !vendored) throw new UserError("nothing to update: run `agent-flow install --harness <name>` first");
  const items = [];
  const add = (harness, label, src, dst, recorded, extra = {}) => {
    const incoming = updateLib.hashTree(src);
    const state = updateLib.fileState(updateLib.hashTree(dst), incoming, recorded);
    items.push({ harness, label, src, dst, state, ...extra });
  };
  for (const h of installed) {
    const t = TARGETS[h];
    const rec = updateLib.readRecord(rt, t.skills);
    for (const name of readdirSync(join(pkgRoot, "skills")).sort()) {
      const src = join(pkgRoot, "skills", name);
      if (statSync(src).isDirectory()) add(h, `${t.skills}/${name}`, src, join(rt, t.skills, name), rec?.files[`${t.skills}/${name}`]);
    }
    for (const [from, to] of t.agents) add(h, to, join(pkgRoot, from), join(rt, to), rec?.files[to]);
    if (t.plugin) {
      const label = ".opencode/plugins/agent-flow-guard.js";
      const binRel = existsSync(vendorDir) ? join(VENDOR_DIR, "bin", "agent-flow.js") : relative(rt, join(pkgRoot, "bin", "agent-flow.js"));
      const body = readFileSync(join(pkgRoot, "templates/opencode/agent-flow-guard.js"), "utf-8").replace("__AGENT_FLOW_BIN__", () => binRel.replace(/\\/g, "/"));
      const dst = join(rt, label);
      const incoming = updateLib.hashContent(body);
      const onDisk = updateLib.hashTree(dst);
      items.push({ harness: h, label, dst, body, state: updateLib.fileState(onDisk, incoming, rec?.files[label]) });
    }
  }
  // The vendored runtime: replaced as one unit, and never downgraded by an older CLI.
  let runtime = null;
  if (vendored && !selfIsVendored) {
    const have = updateLib.vendoredVersion(rt);
    const rec = installed.map((h) => updateLib.readRecord(rt, TARGETS[h].skills)).find(Boolean);
    const onDisk = updateLib.hashTree(vendorDir);
    const recorded = rec?.files[VENDOR_DIR];
    const downgrade = have && updateLib.isNewer(have, VERSION);
    const same = have === VERSION;
    runtime = { have, edited: recorded !== undefined ? onDisk !== recorded : !same, downgrade, same };
  }
  const pending = items.filter((i) => i.state === "upgrade" || i.state === "new");
  const kept = items.filter((i) => i.state === "edited");
  const runtimeDue = runtime && !runtime.same && !runtime.downgrade;
  // Hook wiring (a new matcher, a moved runtime) can be out of date on its own: ask the installers what they would change.
  const hookDue = [];
  const hookNotes = new Set();
  for (const h of installed) {
    const t = TARGETS[h];
    const probe = (fn) => {
      const lines = [];
      const orig = console.log;
      console.log = (...a) => lines.push(a.join(" "));
      try {
        fn({ ...args, "dry-run": true, "keep-custom": !args.force });
      } finally {
        console.log = orig;
      }
      for (const l of lines) if (/customized/.test(l)) hookNotes.add(l);
      return lines.some((l) => /would write/.test(l));
    };
    if (t.hook && probe((a) => installGuardHook(rt, a, t.hook))) hookDue.push(h);
    if (h === "claude" && probe((a) => installClaudeHook(rt, a))) hookDue.push(h);
  }
  const available = pending.length > 0 || !!runtimeDue || hookDue.length > 0 || (args.force && kept.length > 0);
  const result = { version: VERSION, vendored_version: updateLib.vendoredVersion(rt), runtime: runtime && { from: runtime.have, to: VERSION, action: runtime.downgrade ? "refused_downgrade" : runtime.same ? "up_to_date" : runtime.edited && !args.force ? "edited_kept" : "upgrade" }, upgrade: pending.map((i) => i.label), edited_kept: args.force ? [] : kept.map((i) => i.label), self_is_vendored: selfIsVendored };
  if (args.check) {
    out(args, { ...result, update_available: available }, () => (available ? warn(`an update is available (${VERSION}): run \`npx ${PACKAGE}@latest update --yes\``) : ok("up to date")));
    return available ? 10 : 0;
  }
  out(args, { ...result, applied: !!args.yes && !args["dry-run"] }, () => {
    if (selfIsVendored) {
      warn(`you ran the vendored copy (${VERSION}), which can't update itself. Use the new version: npx ${PACKAGE}@latest update --yes`);
    }
    if (runtime?.downgrade) warn(`vendored runtime is ${runtime.have}, newer than this CLI (${VERSION}): not downgrading`);
    else if (runtime && !runtime.same) (runtime.edited && !args.force ? warn : console.log)(`${runtime.edited && !args.force ? "" : "  "}${VENDOR_DIR}/  ${runtime.have ?? "?"} -> ${VERSION}${runtime.edited && !args.force ? " (modified since install: kept; --force to replace)" : ""}`);
    else if (runtime) console.log(dim(`= ${VENDOR_DIR}/ (up to date, ${VERSION})`));
    for (const n of hookNotes) console.log(n);
    for (const h of hookDue) console.log(`  ${TARGETS[h].hook ? TARGETS[h].hook : ".claude/settings.json"} (guard hook)  upgrade`);
    for (const i of items) {
      if (i.state === "up_to_date") console.log(dim(`= ${i.label} (up to date)`));
      else if (i.state === "edited" && !args.force) warn(`${i.label} was edited since install: kept (--force to replace)`);
      else console.log(`  ${i.label}  ${i.state === "new" ? "new" : "upgrade"}`);
    }
    if (!available) return ok(hookNotes.size ? "everything else is up to date" : "everything is up to date");
    if (!args.yes) console.log(dim("nothing changed: re-run with --yes to apply (--dry-run to preview)"));
  });
  if (!args.yes || args["dry-run"] || !available) return 0;
  // Apply.
  if (runtimeDue && (!runtime.edited || args.force)) runtimeBinRel(rt, { ...args, vendor: true }, "update");
  for (const i of items) {
    if (i.state === "edited" && !args.force) continue;
    if (i.state === "up_to_date") continue;
    mkdirSync(dirname(i.dst), { recursive: true });
    if (i.body !== undefined) writeFileSync(i.dst, i.body);
    else cpSync(i.src, i.dst, { recursive: true, force: true });
  }
  for (const h of installed) {
    const t = TARGETS[h];
    if (t.hook) installGuardHook(rt, { ...args, "keep-custom": !args.force }, t.hook);
    if (h === "claude") installClaudeHook(rt, { ...args, "keep-custom": !args.force });
    const plan = [];
    for (const name of readdirSync(join(pkgRoot, "skills")).sort()) {
      if (statSync(join(pkgRoot, "skills", name)).isDirectory()) plan.push([join(pkgRoot, "skills", name), join(rt, t.skills, name), `${t.skills}/${name}`]);
    }
    for (const [from, to] of t.agents) plan.push([join(pkgRoot, from), join(rt, to), to]);
    const extra = t.plugin ? { ".opencode/plugins/agent-flow-guard.js": (() => { const it = items.find((x) => x.body !== undefined); return it && (it.state !== "edited" || args.force) ? updateLib.hashTree(it.dst) : null; })() } : {};
    recordInstall(rt, h, t, plan, { extra, vendorWritten: !!(runtimeDue && (!runtime.edited || args.force)) });
  }
  ok(`updated to ${VERSION}${kept.length && !args.force ? `; ${kept.length} edited file(s) kept` : ""}`);
  console.log(dim("review with git diff, then commit"));
  return 0;
}

/**
 * `uninstall [--harness <name>] [--yes] [--keep-runtime] [--keep-hook]`: take out what `install` wrote and nothing else.
 * A skill, agent or plugin file is removed only if it is still exactly what install (or this version) writes; one
 * you edited is kept and listed. In the hook files install merged into, only agent-flow's own entries go; everything
 * else in them stays. Previews unless given --yes. Context you wrote or approved (AGENTS.md, the manifest, CODEOWNERS,
 * the risk baseline, the pipeline's state) is never touched: those are yours.
 */
function cmdUninstall(args) {
  const rt = root();
  const everything = Object.keys(TARGETS);
  if (typeof args.harness === "string" && !Object.hasOwn(TARGETS, args.harness)) return unknown("harness", args.harness, everything, `usage: agent-flow uninstall [--harness <${everything.join("|")}>]`);
  const vendorDir = join(rt, VENDOR_DIR);
  const installed = installedHarnesses(rt);
  if (!installed.length && !existsSync(vendorDir)) throw new UserError("nothing to uninstall: `agent-flow install` has not been run here");
  const chosen = typeof args.harness === "string" ? installed.filter((h) => h === args.harness) : installed;
  if (!chosen.length) throw new UserError(`${args.harness} is not installed here (installed: ${installed.join(", ") || "none"})`);
  const remaining = installed.filter((h) => !chosen.includes(h));
  const fullUninstall = remaining.length === 0;
  const stillUsed = new Map(remaining.map((h) => [TARGETS[h].skills, h]));
  const items = [];
  const add = (item) => items.push(item);
  const doneDirs = new Set();
  const doneHooks = new Set();
  const records = new Map();

  for (const h of chosen) {
    const t = TARGETS[h];
    const rec = updateLib.readRecord(rt, t.skills);
    if (!records.has(t.skills)) records.set(t.skills, rec);
    const check = (label, src, dst) => {
      const onDisk = updateLib.hashTree(dst);
      if (onDisk === null) return;
      const mine = onDisk === rec?.files[label] || (src !== null && onDisk === updateLib.hashTree(src));
      add({ harness: h, label, action: mine ? "remove" : "keep_edited", path: dst, note: mine ? undefined : "edited since install" });
    };
    // Several harnesses can share one skills folder (.agents/skills): it goes only when none of them still needs it.
    // What is this harness's alone (its agent definitions, its rules file, its plugin) goes either way.
    if (!doneDirs.has(t.skills)) {
      doneDirs.add(t.skills);
      if (stillUsed.has(t.skills)) {
        add({ harness: h, label: `${t.skills}/`, action: "keep_shared", note: `still used by ${stillUsed.get(t.skills)}` });
      } else {
        for (const name of readdirSync(join(pkgRoot, "skills")).sort()) {
          const src = join(pkgRoot, "skills", name);
          if (statSync(src).isDirectory()) check(`${t.skills}/${name}`, src, join(rt, t.skills, name));
        }
      }
    }
    for (const [from, to] of t.agents) check(to, join(pkgRoot, from), join(rt, to));
    if (t.plugin) {
      const label = ".opencode/plugins/agent-flow-guard.js";
      const binRel = existsSync(vendorDir) ? join(VENDOR_DIR, "bin", "agent-flow.js") : relative(rt, join(pkgRoot, "bin", "agent-flow.js"));
      const body = readFileSync(join(pkgRoot, "templates/opencode/agent-flow-guard.js"), "utf-8").replace("__AGENT_FLOW_BIN__", () => binRel.replace(/\\/g, "/"));
      const dst = join(rt, label);
      const onDisk = updateLib.hashTree(dst);
      if (onDisk !== null) {
        const mine = onDisk === rec?.files[label] || onDisk === updateLib.hashContent(body);
        add({ harness: h, label, action: mine ? "remove" : "keep_edited", path: dst, note: mine ? undefined : "edited since install" });
      }
    }
  }

  // The hook files install merged into: only our entries leave.
  for (const h of chosen) {
    const t = TARGETS[h];
    const files = [];
    if (h === "claude") files.push({ rel: ".claude/settings.json", flat: false });
    if (t.hook) files.push({ rel: HOOK_FILES[t.hook].path, flat: !HOOK_FILES[t.hook].wrap });
    for (const { rel, flat } of files) {
      if (doneHooks.has(rel) || !existsSync(join(rt, rel))) continue;
      doneHooks.add(rel);
      const path = join(rt, rel);
      const raw = readFileSync(path, "utf-8");
      let settings;
      try {
        settings = JSON.parse(raw.replace(/^\uFEFF/, ""));
      } catch {
        add({ harness: h, label: rel, action: "keep_unreadable", note: "not valid JSON, so left exactly as it is: remove agent-flow's hook entries by hand" });
        continue;
      }
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) continue;
      const r = uninstallLib.stripOurHooks(settings, flat);
      if (!r.removed) continue;
      add({ harness: h, label: rel, action: r.empty ? "delete_file" : "strip_hooks", path, removed: r.removed, config: r.config, raw, note: r.empty ? "nothing else was in it" : "your other settings and hooks stay" });
    }
  }

  // Beyond the harnesses: the pre-commit gate and the vendored runtime go with the last harness.
  if (fullUninstall) {
    const hooksDir = git.git(["rev-parse", "--git-path", "hooks"], rt);
    const hookPath = hooksDir.ok ? join(resolve(rt, hooksDir.stdout.trim()), "pre-commit") : null;
    if (hookPath && !args["keep-hook"] && existsSync(hookPath)) {
      if (readFileSync(hookPath, "utf-8").includes(HOOK_MARKER)) add({ harness: "-", label: relative(rt, hookPath).replace(/\\/g, "/"), action: "remove", path: hookPath, note: "agent-flow's pre-commit gate (a backup of an earlier hook, pre-commit.bak-*, is kept)" });
      else add({ harness: "-", label: relative(rt, hookPath).replace(/\\/g, "/"), action: "keep_edited", note: "not agent-flow's hook" });
    }
    if (existsSync(vendorDir) && !args["keep-runtime"]) {
      const recorded = [...records.values()].map((r) => r?.files[VENDOR_DIR]).find(Boolean);
      const onDisk = updateLib.hashTree(vendorDir);
      if (recorded && onDisk === recorded) add({ harness: "-", label: `${VENDOR_DIR}/`, action: "remove", path: vendorDir, note: "the vendored runtime, unmodified since install" });
      else add({ harness: "-", label: `${VENDOR_DIR}/`, action: "keep_edited", note: recorded ? "modified since install" : "no install record to compare it with: delete it yourself once nothing needs it" });
    }
  } else if (existsSync(vendorDir)) {
    add({ harness: "-", label: `${VENDOR_DIR}/`, action: "keep_shared", note: `still used by ${remaining.join(", ")}` });
  }

  const apply = !!args.yes && !args["dry-run"];
  const leftAlone = ["AGENTS.md", "CLAUDE.md (its @AGENTS.md import)", "CONTEXT_MANIFEST.json", "DOCS_INDEX.md", "CODEOWNERS", ".risk-baseline.json", ".agent-state.json and AGENT_STATE.md", ".agent-flow/ (audit log, artifacts)", ".git/info/exclude entries"];
  if (apply) {
    const dirsTouched = new Set();
    for (const it of items) {
      if (it.action === "remove") {
        rmSync(it.path, { recursive: true, force: true });
        dirsTouched.add(dirname(it.path));
      } else if (it.action === "delete_file") {
        rmSync(it.path, { force: true });
        dirsTouched.add(dirname(it.path));
      } else if (it.action === "strip_hooks") {
        const text = `${JSON.stringify(it.config, null, mergeLib.detectJsonIndent(it.raw))}\n`;
        writeFileSync(it.path, it.raw.startsWith("\uFEFF") ? `\uFEFF${text}` : text);
      }
    }
    // The runtime's hash lives in a record; if the one that held it is leaving, hand it to a harness that stays, so a later
    // full uninstall can still tell an untouched runtime from a patched one.
    const vendorHash = [...records.values()].map((r) => r?.files[VENDOR_DIR]).find(Boolean);
    if (vendorHash && existsSync(vendorDir) && !items.some((i) => i.label === `${VENDOR_DIR}/` && i.action === "remove")) {
      for (const h of remaining) {
        const other = updateLib.readRecord(rt, TARGETS[h].skills);
        if (other && !other.files[VENDOR_DIR]) updateLib.writeRecord(rt, TARGETS[h].skills, { ...other, files: { ...other.files, [VENDOR_DIR]: vendorHash } });
      }
    }
    // The install record lists what was written; drop what is gone, and the record itself once nothing is left.
    for (const [skills, rec] of records) {
      if (!rec) continue;
      const kept = Object.fromEntries(Object.entries(rec.files).filter(([label]) => {
        // The runtime is shared: a harness that leaves stops listing it, one that stays keeps listing it.
        if (label === VENDOR_DIR) return stillUsed.has(skills) && !items.some((i) => i.label === `${VENDOR_DIR}/` && i.action === "remove");
        return !items.some((i) => i.label === label && i.action === "remove");
      }));
      const path = updateLib.recordPath(rt, skills);
      // A folder another harness still uses keeps its record, now naming that harness (it holds one name, the last installed).
      const owner = stillUsed.get(skills);
      if (Object.keys(kept).length) updateLib.writeRecord(rt, skills, { ...rec, ...(owner ? { harness: owner } : {}), files: kept });
      else {
        rmSync(path, { force: true });
        dirsTouched.add(dirname(path));
      }
    }
    // Empty folders install created go too, innermost first; a folder with anything of yours in it stays.
    for (const start of dirsTouched) {
      for (let d = start; d !== rt && !escapesBaseDir(rt, d); d = dirname(d)) {
        try {
          if (readdirSync(d).length) break;
          rmSync(d, { recursive: true }); // empty (checked above); a non-recursive rmSync can't remove a directory
        } catch {
          break;
        }
      }
    }
    state.appendAudit(rt, { event: "uninstall", via: "cli", harnesses: chosen, removed: items.filter((i) => i.action === "remove" || i.action === "delete_file").map((i) => i.label), stripped: items.filter((i) => i.action === "strip_hooks").map((i) => i.label), kept: items.filter((i) => i.action.startsWith("keep")).map((i) => i.label) });
  }

  out(args, { applied: apply, harnesses: chosen, items: items.map(({ config, raw, path, ...rest }) => rest), left_alone: leftAlone }, () => {
    const verb = { remove: "remove", delete_file: "delete", strip_hooks: "strip ", keep_edited: "keep  ", keep_shared: "keep  ", keep_unreadable: "keep  " };
    for (const it of items) {
      const tag = it.action.startsWith("keep") ? warn : (s) => console.log(`  ${s}`);
      const extra = it.action === "strip_hooks" ? `${it.removed} agent-flow hook entr${it.removed === 1 ? "y" : "ies"}; ${it.note}` : it.note ?? "";
      tag(`${verb[it.action]}  ${it.label}${extra ? ` ${dim(`(${extra})`)}` : ""}`);
    }
    if (!items.length) console.log(dim("  nothing of agent-flow's was found to remove"));
    console.log(dim(`left alone (yours): ${leftAlone.join(", ")}`));
    if (!apply) console.log(dim("nothing changed: re-run with --yes to apply"));
    else ok(`uninstalled ${chosen.join(", ")}`);
  });
  return 0;
}

/** Does `d` lie outside `base`? (for walking up from a removed file without leaving the repository) */
function escapesBaseDir(base, d) {
  return fsutil.escapesBase(relative(base, d));
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
  const pluginRecord = {};
  if (t.plugin) {
    const dst = join(rt, ".opencode/plugins/agent-flow-guard.js");
    const pluginLabel = ".opencode/plugins/agent-flow-guard.js";
    const binRel = runtimeBinRel(rt, args, pluginLabel);
    const body = binRel && readFileSync(join(pkgRoot, "templates/opencode/agent-flow-guard.js"), "utf-8").replace("__AGENT_FLOW_BIN__", () => binRel.replace(/\\/g, "/"));
    if (!body) conflicts.push(pluginLabel);
    else if (existsSync(dst) && readFileSync(dst, "utf-8") === body) {
      console.log(dim("= .opencode/plugins/agent-flow-guard.js (up to date)"));
      pluginRecord[pluginLabel] = updateLib.hashTree(dst);
    } else if (existsSync(dst) && !args.force) {
      conflicts.push(pluginLabel);
      bad(".opencode/plugins/agent-flow-guard.js exists and differs — not overwritten (use --force)");
    } else {
      if (!args["dry-run"]) {
        mkdirSync(dirname(dst), { recursive: true });
        writeFileSync(dst, body);
        pluginRecord[pluginLabel] = updateLib.hashTree(dst);
      }
      wrote++;
      ok(`${args["dry-run"] ? "would write" : "wrote"} .opencode/plugins/agent-flow-guard.js`);
    }
  }
  if (t.hook) installGuardHook(rt, args, t.hook); // best effort: skills alone are still a valid install
  if (args.harness === "claude") {
    if (!installClaudeHook(rt, args)) conflicts.push(".claude/settings.json");
    importAgentsMd(rt, args);
  }
  if (!args["dry-run"]) recordInstall(rt, args.harness, t, plan, { vendorWritten: vendoredThisRun, extra: pluginRecord });
  ignoreLocalState(rt, args);
  if (t.note) console.log(`\n${t.note}`);
  const who = args.harness === "claude" ? "Claude" : "your agent";
  const steps = [
    "npx @drix10/agent-flow doctor   (checks what your context files claim today)",
    `ask ${who}: "use the bootstrap skill to set up this repo"`,
    "npx @drix10/agent-flow hook install   (pre-commit gate)",
    `commit what install wrote${vendoredThisRun ? ` (including ${VENDOR_DIR}/, so the hook runs for everyone who clones)` : ""}`,
  ];
  console.log(`\nNext:\n${steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`);
  return conflicts.length ? 1 : 0;
}

/** `.agent-flow/` is this checkout's own state (audit log, gate logs, backups): never shared through git. */
function ignoreLocalState(rt, args) {
  if (!git.git(["rev-parse", "--is-inside-work-tree"], rt).ok) return;
  if (git.git(["check-ignore", "-q", ".agent-flow/audit.jsonl"], rt).ok || args["dry-run"]) return;
  // .git/info/exclude, not .gitignore: the user's committed files stay untouched (same as worktree create).
  if (git.ensureLocalExcludes(rt, ["/.agent-flow/"]).length) ok("excluded .agent-flow/ (local state) from git via .git/info/exclude");
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

// Every tool the guard has a rule for: writes, the shell, read tools (env files, deny_read) and MCP tools (remote pushes).
const STOP_HOOK_TIMEOUT_S = 900;
const HOOK_MATCHER = "Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell|Read|NotebookRead|Grep|Glob|Task|Agent|mcp__.*";

const VENDOR_DIR = ".agent-flow-runtime";
const PACKAGE = "@drix10/agent-flow";
let vendoredThisRun = false;

/**
 * Where a guard hook should point. A project's own node_modules copy when there is one; otherwise
 * (a Python or Go repo, or a run from npx's throwaway cache) a vendored runtime at
 * `.agent-flow-runtime/`: about 1 MB of plain files, no package.json, no npm. Returns the bin path
 * relative to the repo root, or null if the vendor copy could not be written.
 */
function runtimeBinRel(rt, args, label) {
  const own = relative(rt, join(pkgRoot, "bin", "agent-flow.js"));
  if (!args.vendor && !fsutil.escapesBase(own)) return own;
  const dest = join(rt, VENDOR_DIR);
  const vendored = join(VENDOR_DIR, "bin", "agent-flow.js");
  if (resolve(pkgRoot) === resolve(dest)) return vendored;
  const files = [["package.json"], ["bin", "agent-flow.js"], ["schemas"], ["templates"]];
  const libDir = join(pkgRoot, "extensions", "lib");
  if (!existsSync(libDir)) {
    bad(`${label}: no runtime to vendor from ${pkgRoot}.`);
    return null;
  }
  if (!args["dry-run"] && !vendoredThisRun) {
    // Replace, don't overlay: a library dropped in a newer version must not linger in a folder the guard trusts.
    rmSync(dest, { recursive: true, force: true });
    for (const f of files) cpSync(join(pkgRoot, ...f), join(dest, ...f), { recursive: true });
    mkdirSync(join(dest, "extensions", "lib"), { recursive: true });
    for (const n of readdirSync(libDir)) if (n.endsWith(".js")) copyFileSync(join(libDir, n), join(dest, "extensions", "lib", n));
    vendoredThisRun = true; // only a real copy counts: a dry run (or update's probe) must not stop the real one later
    ok(`copied the runtime to ${VENDOR_DIR}/ (commit it; the hook runs from there, no npm needed)`);
  } else if (args["dry-run"]) {
    ok(`would copy the runtime to ${VENDOR_DIR}/ (commit it; the hook runs from there, no npm needed)`);
  }
  return vendored;
}

/**
 * Wire the guard into Claude Code as a PreToolUse hook, merged into any
 * existing .claude/settings.json. The hook must point at a copy of agent-flow
 * that every checkout has — the project's node_modules — or it silently
 * doesn't run (a hook that can't start doesn't block).
 */
function installClaudeHook(rt, args) {
  const label = ".claude/settings.json (PreToolUse guard hook)";
  const binRel = runtimeBinRel(rt, args, label);
  if (!binRel) return false;
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
  // Ours = runs agent-flow's own binary. A user's `agent-flow-guard.sh` shares the words, not the program, and must come through untouched.
  const looseOurs = (h) => OUR_BIN.test(h?.command ?? "") && /\sguard\b/.test(h?.command ?? "");
  // `update` only refreshes a hook in exactly the shape install writes. One someone customized (a wrapper, an extra
  // flag) is theirs: left as it is, with a note, unless --force.
  const canonicalOurs = (h) => /^node\s+"[^"]*agent-flow(-runtime)?\/bin\/agent-flow\.js"\s+guard\s*$/.test(h?.command ?? "");
  const isOurs = args["keep-custom"] ? canonicalOurs : looseOurs;
  if (args["keep-custom"] && !settings.hooks.PreToolUse.some((e) => Array.isArray(e?.hooks) && e.hooks.some(canonicalOurs)) && settings.hooks.PreToolUse.some((e) => Array.isArray(e?.hooks) && e.hooks.some(looseOurs))) {
    warn(`${label}: the guard hook was customized, so update left it alone (--force to replace it)`);
    return true;
  }
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
  if (args["stop-gate"]) {
    if (settings.hooks.Stop !== undefined && !Array.isArray(settings.hooks.Stop)) {
      bad(`${label}: existing "hooks.Stop" has an unexpected shape — not touched. Fix it and re-run.`);
      return false;
    }
    settings.hooks.Stop ??= [];
    const stopCmd = `node "$CLAUDE_PROJECT_DIR/${binRel.split("\\").join("/")}" gates stop`;
    const isStop = (h) => /agent-flow/.test(h?.command ?? "") && /\bgates stop\b/.test(h?.command ?? "");
    // Claude Code kills a hook after its timeout (60 s by default) and then doesn't block: give the gates room.
    const g = settings.hooks.Stop.find((e) => Array.isArray(e?.hooks) && e.hooks.some(isStop));
    if (g) g.hooks = g.hooks.map((h) => (isStop(h) ? { ...h, type: "command", command: stopCmd, timeout: STOP_HOOK_TIMEOUT_S } : h));
    else settings.hooks.Stop.push({ hooks: [{ type: "command", command: stopCmd, timeout: STOP_HOOK_TIMEOUT_S }] });
  }
  if (args.statusline) {
    if (settings.statusLine === undefined) settings.statusLine = { type: "command", command: `node "$CLAUDE_PROJECT_DIR/${binRel.split("\\").join("/")}" statusline` };
    else if (!/agent-flow/.test(settings.statusLine?.command ?? "")) warn(`${label}: a statusLine is already set, so it was left as it is; to show agent-flow's, run \`agent-flow statusline\` from it`);
  }
  // The briefing: SessionStart for the session, SubagentStart because a subagent never sees the parent's context.
  const isBrief = (h) => OUR_BIN.test(h?.command ?? "") && /\sbrief\b/.test(h?.command ?? "");
  for (const ev of ["SessionStart", "SubagentStart"]) {
    if (settings.hooks[ev] !== undefined && !Array.isArray(settings.hooks[ev])) {
      bad(`${label}: existing "hooks.${ev}" has an unexpected shape — not touched. Fix it and re-run.`);
      return false;
    }
    const list = (settings.hooks[ev] ??= []);
    // Drop ours first so a re-run refreshes the entry (or, with --no-brief, removes it) instead of stacking another.
    for (let i = list.length - 1; i >= 0; i--) {
      if (!Array.isArray(list[i]?.hooks) || !list[i].hooks.some(isBrief)) continue;
      const rest = list[i].hooks.filter((h) => !isBrief(h));
      if (rest.length) list[i] = { ...list[i], hooks: rest };
      else list.splice(i, 1);
    }
    if (!args["no-brief"]) list.push({ ...(ev === "SessionStart" ? { matcher: "startup|resume|clear|compact" } : {}), hooks: [{ type: "command", command: `node "$CLAUDE_PROJECT_DIR/${binRel.split("\\").join("/")}" brief --event ${ev}`, timeout: 5 }] });
    if (!list.length) delete settings.hooks[ev];
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

// Harnesses whose hooks speak (nearly) Claude Code's protocol: JSON on stdin, exit 2 blocks.
const HOOK_FILES = {
  gemini: { path: ".gemini/settings.json", event: "BeforeTool", matcher: "", wrap: true, dir: "$GEMINI_PROJECT_DIR/" },
  codex: { path: ".codex/hooks.json", event: "PreToolUse", brief: "SessionStart", matcher: "", wrap: true, dir: "./" },
  cursor: { path: ".cursor/hooks.json", event: ["beforeShellExecution", "beforeReadFile", "preToolUse"], brief: "sessionStart", wrap: false, dir: "./" },
};

/** Wire `agent-flow guard` into Gemini CLI, Codex or Cursor without touching anyone else's hooks. Unverified live: see docs/HARNESS-MATRIX.md. */
function installGuardHook(rt, args, name) {
  const cfg = HOOK_FILES[name];
  const label = `${cfg.path} (guard hook)`;
  const binRel = runtimeBinRel(rt, args, label);
  if (!binRel) return false;
  const command = `node "${cfg.dir}${binRel.split("\\").join("/")}" guard`;
  const path = join(rt, cfg.path);
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
  const events = [].concat(cfg.event);
  if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks))) {
    bad(`${label}: existing "hooks" has an unexpected shape — not touched. Fix it and re-run.`);
    return false;
  }
  if ([...events, ...(cfg.brief ? [cfg.brief] : [])].some((e) => settings.hooks?.[e] !== undefined && !Array.isArray(settings.hooks[e]))) {
    bad(`${label}: an existing hook event has an unexpected shape — not touched. Fix it and re-run.`);
    return false;
  }
  const before = JSON.stringify(settings);
  settings.hooks ??= {};
  if (!cfg.wrap) settings.version ??= 1;
  // Ours = a command that runs agent-flow's guard or brief, wherever the runtime lives (node_modules/@drix10/agent-flow, or the
  // vendored .agent-flow-runtime). Matching only the first path let every re-install add another copy for a vendored runtime.
  const looseOurs = (h) => OUR_BIN.test(h?.command ?? "") && /\s(guard|brief)\b/.test(h?.command ?? "");
  const canonicalOurs = (h) => /^node\s+"[^"]*agent-flow(-runtime)?\/bin\/agent-flow\.js"\s+(guard|brief --event \w+)\s*$/.test(h?.command ?? "");
  const isOurs = args["keep-custom"] ? canonicalOurs : looseOurs;
  // `update` replaces only a hook in exactly the shape install writes; a customised one is the user's, left alone with a note.
  const hooksOf = (e) => (cfg.wrap ? (Array.isArray(e?.hooks) ? e.hooks : []) : [e]);
  // Judged on the guard's own events: the briefing hook beside it must not make a customised guard look untouched.
  const guardCommands = events.flatMap((e) => (Array.isArray(settings.hooks?.[e]) ? settings.hooks[e].flatMap(hooksOf) : []));
  const canonicalGuard = (h) => canonicalOurs(h) && /\sguard\s*$/.test(h?.command ?? "");
  if (args["keep-custom"] && !guardCommands.some(canonicalGuard) && guardCommands.some(looseOurs)) {
    warn(`${label}: the guard hook was customized, so update left it alone (--force to replace it)`);
    return true;
  }
  for (const ev of events) {
    const list = (settings.hooks[ev] ??= []);
    const flat = (e) => (cfg.wrap ? (Array.isArray(e?.hooks) ? e.hooks : []) : [e]);
    for (let i = list.length - 1; i >= 0; i--) {
      const kept = flat(list[i]).filter((h) => !isOurs(h));
      if (kept.length === flat(list[i]).length) continue;
      if (cfg.wrap && kept.length) list[i] = { ...list[i], hooks: kept };
      else list.splice(i, 1);
    }
    list.push(cfg.wrap ? { ...(cfg.matcher ? { matcher: cfg.matcher } : {}), hooks: [{ type: "command", command }] } : { command, failClosed: true });
  }
  if (cfg.brief) {
    // The briefing hook fails open (it only adds context), unlike the guard.
    const bcommand = `node "${cfg.dir}${binRel.split("\\").join("/")}" brief --event SessionStart`;
    const list = (settings.hooks[cfg.brief] ??= []);
    for (let i = list.length - 1; i >= 0; i--) {
      const kept = hooksOf(list[i]).filter((h) => !(looseOurs(h) && /\sbrief\b/.test(h?.command ?? "")));
      if (kept.length === hooksOf(list[i]).length) continue;
      if (cfg.wrap && kept.length) list[i] = { ...list[i], hooks: kept };
      else list.splice(i, 1);
    }
    if (!args["no-brief"]) list.push(cfg.wrap ? { hooks: [{ type: "command", command: bcommand, timeout: 5 }] } : { command: bcommand, timeout: 5 });
    if (!list.length) delete settings.hooks[cfg.brief];
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
/** A hook command that runs agent-flow's own binary (project copy or vendored runtime): what makes a hook ours, not a name that happens to contain `agent-flow`. */
const OUR_BIN = /agent-flow(?:-runtime)?[\\/]bin[\\/]agent-flow\.js/;

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
# The committed runtime (any language, no npm): written by \`agent-flow install\` in repos without node_modules.
for js in "./${VENDOR_DIR}/bin/agent-flow.js" "$main_root/${VENDOR_DIR}/bin/agent-flow.js"; do
  if [ -f "$js" ]; then exec node "$js" check-staged; fi
done
${selfLine}if npx --no-install @drix10/agent-flow --version >/dev/null 2>&1; then exec npx --no-install @drix10/agent-flow check-staged; fi
echo "agent-flow pre-commit: can't find the agent-flow CLI. Run \\\`npx @drix10/agent-flow install --harness <name>\\\` (copies it to ${VENDOR_DIR}/, any language) or npm i -D @drix10/agent-flow, then: agent-flow hook install" >&2
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
    console.log(JSON.stringify({ written: [], plan: plan.files.map((f) => ({ path: f.path, action: f.exists ? "skip_exists" : "write", content: f.content })), references: plan.references, missing_references: plan.missing_references, suggested_protected_paths: plan.suggested_protected_paths, suggested_review_paths: plan.suggested_review_paths }, null, 2));
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
    if (plan.suggested_protected_paths.length) console.log(dim(`  protected_paths is empty. Worth protecting here: ${plan.suggested_protected_paths.join(", ")} — add what applies to CONTEXT_MANIFEST.json (nothing is protected until you do).`));
    if (plan.suggested_review_paths.length) console.log(dim(`  CI workflows: add \`"review_paths": ${JSON.stringify(plan.suggested_review_paths)}\` so agents can add a check there (added lines only) and a person reviews the pull request, instead of every CI change stopping an unattended run. Not protected_paths: that stops them.`));
    if (plan.missing_references.length) warn(`${plan.missing_references.length} referenced path(s) don't exist, so they weren't recorded — \`agent-flow doctor\` lists them`);
    if (written.includes("AGENTS.md") && manifestSkipped) warn("add AGENTS.md to context_files in your existing CONTEXT_MANIFEST.json");
    console.log(dim(`\nnext: ${written.includes("AGENTS.md") ? "replace the [NEEDS VERIFICATION] lines in AGENTS.md, then " : ""}\`agent-flow doctor\` (and add it to CI)`));
  });
  return 0;
}

/**
 * `agent-flow sandbox [--ro] [--no-net] [--hide-home] [--allow <dir>]... -- <cmd...>`
 * Runs a command (typically an agent harness) under bubblewrap: the whole filesystem is
 * read-only except the worktree (and --allow dirs), /tmp is private, and the process can't
 * see other processes. Unlike the guard hook this is an OS boundary, so interpreters and
 * scripts can't write outside it either. Linux/WSL only; needs `bwrap`.
 */
function sandboxArgv(av, cwd, home) {
  const i = av.indexOf("--");
  const opts = i === -1 ? av : av.slice(0, i);
  const cmdv = i === -1 ? [] : av.slice(i + 1);
  const o = { ro: false, net: true, hideHome: false, allow: [] };
  for (let k = 0; k < opts.length; k++) {
    const f = opts[k];
    if (f === "--ro") o.ro = true;
    else if (f === "--no-net") o.net = false;
    else if (f === "--hide-home") o.hideHome = true;
    else if (f === "--allow" && opts[k + 1]) o.allow.push(resolve(cwd, opts[++k]));
    else throw new UserError(`sandbox: unknown option ${f}`);
  }
  if (!cmdv.length) throw new UserError("usage: agent-flow sandbox [--ro] [--no-net] [--hide-home] [--allow <dir>]... -- <command...>");
  const b = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--new-session"];
  if (!o.net) b.push("--unshare-net");
  if (o.hideHome && home) {
    b.push("--tmpfs", home); // credentials, dotfiles and other repos disappear
    if (cwd === home || cwd.startsWith(home + "/")) b.push("--ro-bind", cwd, cwd);
  }
  if (!o.ro) b.push("--bind", cwd, cwd);
  for (const d of o.allow) b.push("--bind", d, d);
  b.push("--chdir", cwd, "--", ...cmdv);
  return b;
}

function cmdSandbox(av) {
  const bw = spawnSync("bwrap", ["--version"], { encoding: "utf8" });
  if (bw.error || bw.status !== 0) throw new UserError("sandbox needs bubblewrap (`bwrap`) — Linux/WSL only: apt install bubblewrap");
  const r = spawnSync("bwrap", sandboxArgv(av, realpathSync(process.cwd()), process.env.HOME), { stdio: "inherit" });
  return r.status ?? 1;
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

if (process.argv[2] === "sandbox") {
  try {
    process.exit(roleRefusal() || cmdSandbox(process.argv.slice(3)));
  } catch (e) {
    console.error(`${c(31, "agent-flow:")} ${String(e.message ?? e).split("\n")[0]}`);
    process.exit(2);
  }
}
const args = fixBools(parseArgs(process.argv.slice(2)));
if (args._[0] === "-h") args.help = true;
if (args._[0] === "-v" || args._[0] === "-V") args.version = true;
const cmd = args._[0];
const table = {
  doctor: cmdDoctor,
  init: cmdInit,
  "audit-risk": cmdAudit,
  audit: cmdAuditLog,
  gates: cmdGates,
  debt: cmdDebt,
  brief: cmdBrief,
  statusline: cmdStatusline,
  mcp: cmdMcp,
  config: cmdConfig,
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
  manifest: cmdManifest,
  update: cmdUpdate,
  uninstall: cmdUninstall,
  run: cmdRun,
  status: cmdStatus,
  codeowners: cmdCodeowners,
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
  const code = roleRefusal() || (await table[cmd](args));
  // Let piped output drain first: process.exit() can cut a large write short when stdout is a pipe.
  await new Promise((done) => process.stdout.write("", done));
  process.exit(code);
} catch (e) {
  const msg = String(e.message ?? e).split("\n")[0];
  const friendly = /not a git repository/i.test(msg) ? "not a git repository — run this inside a git checkout (or `git init` first)" : msg;
  console.error(`${c(31, "agent-flow:")} ${friendly}`);
  process.exit(2);
}
