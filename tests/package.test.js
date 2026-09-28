// Smoke test: package integrity — every file package.json points at must exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

test("entry points exist", () => {
  assert.ok(existsSync(join(root, "extensions/index.ts")), "extensions/index.ts missing");
  for (const skill of ["bootstrap", "implementer", "reviewer", "qa", "gardener", "invoking-agents"]) {
    assert.ok(existsSync(join(root, "skills", skill, "SKILL.md")), `skills/${skill}/SKILL.md missing`);
  }
  for (const t of ["AGENTS.md.template", "module-AGENTS.md.template", "CLAUDE.md.template", "DOCS_INDEX.md.template", "CONTEXT_MANIFEST.json.template"]) {
    assert.ok(existsSync(join(root, "templates", t)), `templates/${t} missing`);
  }
});

test("read-only reviewers really are read-only where the harness enforces it", () => {
  // Claude Code: the tools field IS enforcement — so it must not include a shell (a shell can write).
  const claude = readFileSync(join(root, ".claude", "agents", "reviewer.md"), "utf-8");
  const tools = claude.match(/^tools:\s*(.+)$/m)?.[1] ?? "";
  for (const t of ["Write", "Edit", "Bash", "MultiEdit", "NotebookEdit"]) assert.ok(!new RegExp(`\\b${t}\\b`).test(tools), `claude reviewer must not have ${t}`);
  const gemini = readFileSync(join(root, ".gemini", "agents", "reviewer.md"), "utf-8");
  for (const t of ["write_file", "replace", "run_shell_command"]) assert.ok(!gemini.includes(`- ${t}`), `gemini reviewer must not have ${t}`);
  assert.match(readFileSync(join(root, ".codex", "agents", "reviewer.toml"), "utf-8"), /sandbox_mode = "read-only"/);
  // Skills must not pretend allowed-tools is enforcement (FM-16).
  for (const skill of ["reviewer", "qa"]) {
    const m = readFileSync(join(root, "skills", skill, "SKILL.md"), "utf-8").match(/allowed-tools:\s*(.+)/);
    if (m) assert.ok(!/\b(write|edit)\b/.test(m[1]), `${skill} must not allow write/edit`);
  }
});

test("pi manifest points at the compiled single entry file", () => {
  // Explicit compiled entry: Pi loads exactly the build that the tests exercised.
  assert.deepEqual(pkg.pi.extensions, ["./extensions/index.js"]);
  assert.ok(existsSync(join(root, "extensions", "index.js")), "run npm run build");
});

test("zero runtime dependencies; pi packages are peers", () => {
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.ok(pkg.peerDependencies["@earendil-works/pi-coding-agent"]);
  assert.ok(pkg.bin?.["agent-flow"] && existsSync(join(root, pkg.bin["agent-flow"])));
});

test("no npm script calls a pi subcommand that does not exist", () => {
  for (const [name, cmd] of Object.entries(pkg.scripts)) assert.ok(!/\bpi run\b/.test(cmd), `script ${name} uses nonexistent \`pi run\``);
});

test("skills never reference nonexistent commands or the old context file names", () => {
  for (const dir of readdirSync(join(root, "skills"))) {
    const c = readFileSync(join(root, "skills", dir, "SKILL.md"), "utf-8");
    assert.ok(!/pi run \//.test(c), `${dir}: \`pi run /x\` is not a Pi command`);
    assert.ok(!/node extensions\/[\w-]+\.js/.test(c), `${dir}: extensions are not CLIs; use npx @drix10/agent-flow`);
  }
});

test("templates contain no stale file names, and no leftover files from the old names ship", () => {
  for (const f of ["AGENTS.md.template", "module-AGENTS.md.template", "CLAUDE.md.template", "DOCS_INDEX.md.template", "CONTEXT_MANIFEST.json.template"]) {
    const c = readFileSync(join(root, "templates", f), "utf-8");
    assert.ok(!c.includes("Root_AGENT.md") && !c.includes("Per-app_AGENT.md"), `${f} references the old names`);
  }
  const shipped = readdirSync(join(root, "templates"));
  for (const old of ["Root_AGENT.md.template", "Per-app_AGENT.md.template"]) {
    assert.ok(!shipped.includes(old), `templates/${old} is the pre-rename file and must not exist`);
  }
});

test("pi manifest keywords", () => {
  assert.ok(pkg.keywords.includes("pi-package"), "pi-package keyword required");
  assert.ok(pkg.pi?.skills && pkg.pi?.extensions, "pi manifest must list skills and extensions");
});

test("all extensions registered in entry point", () => {
  const index = readFileSync(join(root, "extensions", "index.ts"), "utf-8");
  for (const ext of ["bootstrap", "worktree", "state-machine", "stale-detector", "risk-auditor", "cross-harness"]) {
    assert.ok(index.includes(ext), `extensions/index.ts must register ${ext}`);
    assert.ok(existsSync(join(root, "extensions", `${ext}.ts`)), `extensions/${ext}.ts missing`);
  }
});

test("prompt commands exist with descriptions", () => {
  for (const cmd of ["bootstrap", "implement", "doctor", "sync-context", "audit-risk", "repair-docs", "garden"]) {
    const content = readFileSync(join(root, "prompts", `${cmd}.md`), "utf-8");
    assert.match(content, /description:\s*.+/, `prompts/${cmd}.md needs a description`);
  }
  assert.ok(pkg.pi?.prompts, "pi manifest must list prompts");
});

test("reviewer subagents live at harness-canonical paths", () => {
  assert.ok(existsSync(join(root, ".claude", "agents", "reviewer.md")), ".claude/agents/reviewer.md missing");
  assert.ok(existsSync(join(root, ".gemini", "agents", "reviewer.md")), ".gemini/agents/reviewer.md missing");
  assert.ok(existsSync(join(root, ".codex", "agents", "reviewer.toml")), ".codex/agents/reviewer.toml missing");
  const agentsDir = join(root, "skills", "reviewer", "agents");
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir)) {
      assert.ok(!f.endsWith(".yaml"), `unverified ${f} must not ship under skills/`);
    }
  }
});

test("skill frontmatter valid for cross-harness discovery", () => {
  const skillsDir = join(root, "skills");
  for (const dir of readdirSync(skillsDir)) {
    const skillPath = join(skillsDir, dir, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    const content = readFileSync(skillPath, "utf-8");
    // \r? tolerates CRLF: normalized by .gitattributes, but this stays robust
    // even for content read before normalization applies (e.g. a fresh clone
    // on a machine with core.autocrlf=true and no .gitattributes yet).
    const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(fm, `${dir}: missing frontmatter`);
    const name = fm[1].match(/^name:\s*(.+?)\r?$/m)?.[1].trim();
    assert.ok(name, `${dir}: missing name`);
    assert.equal(name, dir, `${dir}: name must match directory`);
    assert.match(name, /^[a-z0-9-]+$/, `${dir}: name must be lowercase alphanumeric with hyphens`);
    assert.ok(name.length <= 64, `${dir}: name exceeds 64 chars`);
    const desc = fm[1].match(/^description:\s*(.+?)\r?$/m)?.[1];
    assert.ok(desc, `${dir}: missing description`);
    assert.ok(desc.length <= 1024, `${dir}: description exceeds 1024 chars`);
  }
});
