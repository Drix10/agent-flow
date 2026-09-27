#!/usr/bin/env node
/**
 * agent-flow CLI — the same checks as the Pi tools, for every harness and for CI.
 *
 * Zero runtime dependencies. Never touches the network. Exit codes:
 *   0 = ok   1 = check failed   2 = usage / environment error
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const lib = (m) => import(new URL(`../extensions/lib/${m}.js`, import.meta.url).href);

let fsutil, manifestLib, stale, risk, state, classify, worktree, git, scan;
try {
  [fsutil, manifestLib, stale, risk, state, classify, worktree, git, scan] = await Promise.all(
    ["fsutil", "manifest", "stale", "risk", "state", "classify", "worktree", "git", "scan"].map(lib),
  );
} catch (e) {
  console.error(`agent-flow: compiled library missing (${e.message}). Run \`npm run build\` in the agent-flow package.`);
  process.exit(2);
}

const VERSION = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8")).version;
const color = process.stdout.isTTY && !process.env.NO_COLOR;
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
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) args[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) args[k] = argv[++i];
      else args[k] = true;
    } else args._.push(a);
  }
  return args;
}

const BOOL_FLAGS = new Set(["json", "no-prose", "ctxlint", "fail-on-new", "include-tests", "all", "yes", "fail-on-protected", "fail-on-critical", "reopen", "force", "delete-branch", "dry-run", "help"]);
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

const HELP = `agent-flow ${VERSION} — context drift detection + guarded agent pipeline

Usage: agent-flow <command> [options]

Checks (CI-safe, read-only):
  doctor                    Validate CONTEXT_MANIFEST.json + context prose against the filesystem
      --manifest <path>     Manifest path (default CONTEXT_MANIFEST.json)
      --no-prose            Skip checking \`backticked/paths\` inside context files
      --ctxlint             Also run a locally installed ctxlint (never downloads)
  audit-risk                Diff risk surfaces against .risk-baseline.json
      --baseline <path>  --include-tests  --fail-on-new
  classify                  Mechanical risk level of a diff
      --base <rev> --head <rev> --issue <n>  --fail-on-protected  --fail-on-critical
  check-staged              Pre-commit gate: protected paths, secrets, broken context refs
  scan                      Read-only repo reconnaissance (what /bootstrap sees)

State & worktrees (for harnesses without Pi extensions):
  state [show]              Print pipeline state
  state update --issue <n> --state "Working|Needs Me|Completed" [--phase p] [--round r] [--reason t] [--reopen]
  worktree create <n> [--base <branch>] | remove <n> [--force] [--delete-branch] | list

Setup (writes files; run by a human):
  baseline accept --all --yes | baseline accept <key>... --yes
  install --harness <claude|codex|gemini|cursor|copilot|agents> [--dry-run] [--force]
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

/** The checkout we're standing in (a linked worktree has its own index and files). */
function checkoutTop() {
  const r = git.git(["rev-parse", "--show-toplevel"], process.cwd());
  return r.ok && r.stdout ? resolve(r.stdout) : root();
}

// ---------------------------------------------------------------------------

function cmdDoctor(args) {
  const r = stale.detectStale(root(), { manifestPath: args.manifest, prose: !args["no-prose"], ctxlint: !!args.ctxlint });
  if (!r.ok) {
    out(args, { healthy: false, error: r.error, path: r.path }, () => {
      bad(`${r.error}: ${r.path}`);
      if (r.error === "manifest_not_found") console.log(dim("  Run /bootstrap (Pi) or follow skills/bootstrap/SKILL.md to create one."));
    });
    return 2;
  }
  out(args, { healthy: r.healthy, report: r.report, manifest: r.manifest, legacy_schema: r.legacy_schema }, () => {
    const rep = r.report;
    const section = (label, items, fmt) => {
      if (items.length === 0) ok(label);
      else {
        bad(`${label} — ${items.length}`);
        for (const i of items.slice(0, 25)) console.log(`    ${fmt(i)}`);
        if (items.length > 25) console.log(dim(`    … ${items.length - 25} more (use --json)`));
      }
    };
    section("manifest schema", rep.schema_problems, (p) => p);
    section("context files exist", rep.missing_context_files, (p) => p);
    section("referenced paths exist", rep.missing_paths, (m) => `${m.file}: ${m.path} ${dim(`(${m.source})`)}`);
    section("timestamps valid", rep.invalid_timestamps, (m) => `${m.file}: ${m.path} → ${JSON.stringify(m.value)}`);
    section("verified within threshold", rep.stale_files, (p) => `${p} [STALE]`);
    section("no unfilled placeholders", rep.unfilled_placeholders, (m) => `${m.file}:${m.line} ${m.text}`);
    if (rep.ctxlint !== "not_requested") (rep.ctxlint === "ran" ? ok : warn)(`ctxlint: ${rep.ctxlint}`);
    if (rep.ctxlint === "ran") section("no dead commands", rep.dead_commands, (m) => `${m.file}: ${m.command}`);
    console.log(r.healthy ? c(32, "\nhealthy") : c(31, "\nunhealthy — run /repair-docs (Gardener) after re-verifying the prose"));
  });
  return r.healthy ? 0 : 1;
}

function cmdAudit(args) {
  const rt = root();
  const baseline = fsutil.resolveInside(rt, args.baseline ?? risk.BASELINE_FILE);
  const r = risk.auditRisk(rt, baseline, { includeTests: !!args["include-tests"] });
  out(args, r, () => {
    console.log(`${r.totalSurfaces} surfaces across ${r.scannedFiles} files ${dim(JSON.stringify(r.byType))}${r.truncated ? c(33, " (truncated)") : ""}`);
    if (!r.baselineExists) warn(`no baseline yet — review, then: agent-flow baseline accept --all --yes`);
    else if (r.newSurfaces === 0) ok("no new risk surfaces since baseline");
    else {
      bad(`${r.newSurfaces} new risk surface(s):`);
      for (const s of r.newSurfacesList.slice(0, 50)) console.log(`    ${s.type.padEnd(13)} ${s.path}${s.lines ? `:${s.lines[0]}` : ""}  ${dim(s.detail)}  ${dim(s.key)}`);
    }
    if (r.resolvedSurfaces) console.log(dim(`${r.resolvedSurfaces} baseline surface(s) no longer present`));
  });
  if (args["fail-on-new"] && r.baselineExists && r.newSurfaces > 0) return 1;
  return 0;
}

function cmdBaseline(args) {
  if (args._[1] !== "accept") return usage("baseline accept --all --yes | baseline accept <key>... --yes");
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
  const cwd = args.issue ? fsutil.resolveInside(rt, worktree.worktreeRel(Number(args.issue))) : process.cwd();
  const r = classify.classifyDiff(cwd, rt, manifestLib.tryLoadManifest(rt), args.base, args.head);
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
  const rt = checkoutTop();
  const files = git.stagedFiles(rt);
  const man = manifestLib.tryLoadManifest(rt);
  const problems = [];

  if (process.env.AGENT_FLOW_ALLOW_PROTECTED !== "1") {
    for (const f of files) {
      const hit = manifestLib.matchAny(man?.protected_paths, f);
      if (hit) problems.push(`protected path staged: ${f} (${hit}) — set AGENT_FLOW_ALLOW_PROTECTED=1 if a human intends this`);
    }
  }
  for (const f of files) {
    const r = git.git(["show", `:${f}`], rt);
    if (!r.ok || r.stdout.length > 2_000_000 || r.stdout.slice(0, 8000).includes("\0")) continue; // deleted, huge or binary
    for (const s of risk.findSecrets(r.stdout)) problems.push(`possible ${s.kind} in ${f} line(s) ${s.lines.join(", ")} (value not shown)`);
  }
  // Context drift: fail only on drift THIS commit introduces (it deletes/renames a
  // referenced path, or edits a context file that is broken). Pre-existing drift is
  // a warning — blocking every unrelated commit on it teaches people --no-verify.
  const warnings = [];
  if (man) {
    const deleted = new Set(
      git.git(["diff", "--cached", "--name-only", "--no-renames", "--diff-filter=D"], rt).stdout.split("\n").filter(Boolean),
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

function cmdState(args) {
  const rt = root();
  const sub = args._[1] ?? "show";
  if (sub === "show") {
    const s = state.readState(rt);
    out(args, s, () => process.stdout.write(state.renderMarkdown(s)));
    return 0;
  }
  if (sub === "update") {
    const issue = Number(args.issue);
    const p = {
      issue,
      state: args.state,
      phase: typeof args.phase === "string" ? args.phase : undefined,
      round: args.round !== undefined ? Number(args.round) : undefined,
      reason: typeof args.reason === "string" ? args.reason : undefined,
      reopen: !!args.reopen,
    };
    const r = state.updateState(rt, p, manifestLib.maxReviewRounds(manifestLib.tryLoadManifest(rt)));
    out(args, r, () => (r.escalated ? warn : ok)(`issue #${r.updated}: ${r.from ?? "(new)"} → ${r.state} (round ${r.round})${r.reason ? ` — ${r.reason}` : ""}`));
    return 0;
  }
  return usage("state [show] | state update --issue <n> --state <s> …");
}

function cmdWorktree(args) {
  const rt = root();
  const sub = args._[1];
  if (sub === "list") {
    const l = worktree.listWorktrees(rt);
    out(args, l, () => (l.length ? l.forEach((w) => console.log(`#${w.issue}  ${w.branch}  ${w.path}`)) : console.log("no agent worktrees")));
    return 0;
  }
  const n = Number(args._[2]);
  if (sub === "create") {
    const r = worktree.createWorktree(rt, n, typeof args.base === "string" ? args.base : undefined);
    out(args, r, () => ("error" in r ? bad(`${r.error}: ${r.path}`) : ok(r.message)));
    return "error" in r ? 1 : 0;
  }
  if (sub === "remove") {
    const r = worktree.removeWorktree(rt, n, { force: !!args.force, deleteBranch: !!args["delete-branch"] });
    out(args, r, () => ("error" in r ? bad(`${r.error}: ${r.path}${r.hint ? ` — ${r.hint}` : ""}`) : ok(`removed ${r.removed}; branch ${r.branch_note}`)));
    return "error" in r ? 1 : 0;
  }
  return usage("worktree create <n> | remove <n> | list");
}

function cmdScan(args) {
  const r = scan.scanRepo(root());
  out(args, r, () => console.log(JSON.stringify(r, null, 2)));
  return 0;
}

// --- install --------------------------------------------------------------

const TARGETS = {
  claude: { skills: ".claude/skills", agents: [[".claude/agents/reviewer.md", ".claude/agents/reviewer.md"]], note: "Add `@AGENTS.md` to CLAUDE.md so Claude Code loads the root context." },
  codex: {
    skills: ".agents/skills",
    agents: [[".codex/agents/reviewer.toml", ".codex/agents/reviewer.toml"]],
    note: 'For a verified hard guarantee, launch the reviewer with `codex exec --sandbox read-only` (real flag, checked against `codex exec --help`) rather than relying on .codex/agents/reviewer.toml being auto-discovered — that subagent-definition path is unverified against a live Codex session. See skills/invoking-agents/SKILL.md.',
  },
  gemini: {
    skills: ".gemini/skills",
    agents: [[".gemini/agents/reviewer.md", ".gemini/agents/reviewer.md"]],
    note: 'Run /trust in the workspace. Subagents need `"experimental": {"enableAgents": true}` in .gemini/settings.json; set `"context": {"fileName": ["AGENTS.md", "GEMINI.md"]}` to load AGENTS.md.',
  },
  cursor: { skills: ".cursor/skills", agents: [], note: "Cursor reads AGENTS.md natively." },
  copilot: { skills: ".github/skills", agents: [], note: "VS Code / Copilot also reads .claude/skills and .agents/skills." },
  agents: { skills: ".agents/skills", agents: [], note: ".agents/skills is the cross-client convention." },
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
  const t = TARGETS[args.harness];
  if (!t) return usage(`install --harness <${Object.keys(TARGETS).join("|")}>`);
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
  console.log(`\n${t.note}`);
  console.log(dim("Outside Pi there are no extension tools: skills call `npx agent-flow …` for state, worktrees, classify, doctor and audit."));
  return conflicts.length ? 1 : 0;
}

function cmdHook(args) {
  if (args._[1] !== "install") return usage("hook install [--force]");
  const rt = root();
  const hooksDir = resolve(rt, git.mustGit(["rev-parse", "--git-path", "hooks"], rt));
  const hook = join(hooksDir, "pre-commit");
  const body = `#!/bin/sh
# agent-flow pre-commit — protected paths, secrets, broken context references.
# Installed by \`agent-flow hook install\`. Never downloads anything.
# Works from linked worktrees too: the binary is looked up in the MAIN checkout.
main_root="$(cd "$(git rev-parse --git-common-dir)/.." 2>/dev/null && pwd)"
for bin in "./node_modules/.bin/agent-flow" "$main_root/node_modules/.bin/agent-flow"; do
  if [ -x "$bin" ]; then exec "$bin" check-staged; fi
done
exec npx --no-install agent-flow check-staged
`;
  if (existsSync(hook) && !readFileSync(hook, "utf-8").includes("agent-flow") && !args.force) {
    bad(`${hook} already exists (not ours). Add \`npx --no-install agent-flow check-staged\` to it, or re-run with --force.`);
    return 1;
  }
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

function usage(msg) {
  console.error(`usage: agent-flow ${msg}`);
  return 2;
}

// ---------------------------------------------------------------------------

const args = fixBools(parseArgs(process.argv.slice(2)));
const cmd = args._[0];
const table = {
  doctor: cmdDoctor,
  "audit-risk": cmdAudit,
  baseline: cmdBaseline,
  classify: cmdClassify,
  "check-staged": cmdCheckStaged,
  state: cmdState,
  worktree: cmdWorktree,
  scan: cmdScan,
  install: cmdInstall,
  hook: cmdHook,
};

if (args.version || cmd === "version") {
  console.log(VERSION);
  process.exit(0);
}
if (!cmd || args.help || cmd === "help" || !table[cmd]) {
  (cmd && !table[cmd] && cmd !== "help" ? console.error : console.log)(HELP);
  process.exit(cmd && !table[cmd] && cmd !== "help" ? 2 : 0);
}
try {
  process.exit(table[cmd](args));
} catch (e) {
  console.error(`${c(31, "agent-flow:")} ${e.message}`);
  process.exit(2);
}
