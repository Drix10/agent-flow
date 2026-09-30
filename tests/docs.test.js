// Docs and skills are read by agents as instructions: a command or flag that no longer exists is a bug, so it fails CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(ROOT, "bin", "agent-flow.js");

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === ".git" || n === ".worktrees" || n === "plan") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.md$/.test(n)) out.push(p);
  }
  return out;
}
const DOCS = walk(ROOT).filter((p) => !/CHANGELOG\.md$/.test(p) && !relative(ROOT, p).startsWith("tests/"));

const src = readFileSync(BIN, "utf-8");
const flags = new Set(["help", "version", ...[...src.matchAll(/(?:BOOL_FLAGS = new Set|VALUE_FLAGS = )\(?\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"([\w-]+)"/g)].map((x) => x[1]))]);
const commands = new Set([...src.matchAll(/^  "?([\w-]+)"?: cmd\w+,/gm)].map((m) => m[1]));
commands.add("help");
commands.add("version");

test("the CLI command and flag lists were parsed", () => {
  assert.ok(commands.size >= 15 && commands.has("gates") && commands.has("audit"), [...commands].join());
  assert.ok(flags.size >= 20 && flags.has("fail-on-policy"), [...flags].join());
});

// Only flags on a line that also invokes agent-flow are checked: `git --no-verify` and friends are someone else's.
test("every `agent-flow <command>` and --flag mentioned in the docs exists", () => {
  const bad = [];
  for (const file of DOCS) {
    readFileSync(file, "utf-8").split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/(?:agent-flow(?:\.js)?|AF)\s+((?:--?[\w-]+\s+)*)([a-z][\w-]*)/g)) {
        const word = m[2];
        if (!/`|^\s{4}|^\s*[$>]|^\s*(AF|npx|agent-flow)/.test(line)) continue; // prose like "agent-flow is"
        if (!commands.has(word) && /^(doctor|init|state|worktree|scan|install|hook|schema|template|report|repair|guard|classify|baseline|audit|gates|check)/.test(word)) bad.push(`${relative(ROOT, file)}:${i + 1}: unknown command "${word}"`);
      }
      if (/agent-flow|\bAF\b/.test(line) && /`|^\s{4}|^\s*[$>]/.test(line)) {
        for (const m of line.matchAll(/(?<![\w-])--([a-z][\w-]*)/g)) {
          if (!flags.has(m[1]) && !ALLOWED_FOREIGN_FLAGS.has(m[1])) bad.push(`${relative(ROOT, file)}:${i + 1}: unknown flag --${m[1]}`);
        }
      }
    });
  }
  assert.deepEqual(bad, []);
});

// Flags that appear on lines mentioning agent-flow but belong to another program.
const ALLOWED_FOREIGN_FLAGS = new Set(["no-verify", "force-with-lease", "hard", "approval-mode", "title", "output-schema", "add-dir", "tools", "approve", "no-install", "json-schema"]);

test("backticked repo paths in the docs exist (illustrative ones are listed)", () => {
  const ILLUSTRATIVE = /^(src|app|lib|docs\/private|packages|services|tests?\/|\.agent-flow\/|\.worktrees\/|\.agent-state|AGENT_STATE|\.risk-baseline|CONTEXT_MANIFEST|\.env|node_modules|dist|build|coverage|\.claude\/settings|\.claude\/skills|\.claude\/agents|\.claude\/plugin|\.codex|\.gemini|\.agents|\.pi|\.git\/|\.github\/|CLAUDE\.md|AGENTS\.md|GEMINI\.md|CODEX\.md|MEMORY|~|\/|\.\/|\.\.\/)/;
  const known = new Set(walkAll(ROOT).map((p) => relative(ROOT, p).split("\\").join("/")));
  const bad = [];
  for (const file of DOCS) {
    const text = readFileSync(file, "utf-8").replace(/```[\s\S]*?```/g, "");
    for (const m of text.matchAll(/`((?:bin|extensions|skills|schemas|templates|prompts|docs|tests)\/[\w./-]+\.(?:ts|js|json|md|yml|yaml|toml))`/g)) {
      const p = m[1];
      if (ILLUSTRATIVE.test(p) && !/^(extensions|skills|schemas|templates|prompts|docs|bin)\//.test(p)) continue;
      if (/[*<>{}]/.test(p)) continue;
      if (!known.has(p) && !known.has(p.replace(/\.ts$/, ".js"))) bad.push(`${relative(ROOT, file)}: ${p}`);
    }
  }
  assert.deepEqual(bad, []);
});

function walkAll(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === ".git" || n === ".worktrees" || n === "plan") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walkAll(p, out);
    else out.push(p);
  }
  return out;
}

test("the CLI's own --help mentions every command", () => {
  const help = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf-8" }).stdout;
  for (const c of commands) if (!["help", "version"].includes(c)) assert.ok(new RegExp(`(^|\\s)${c}(\\s|$)`, "m").test(help), `--help doesn't mention "${c}"`);
});
