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
  for (const t of ["Root_AGENT.md.template", "Per-app_AGENT.md.template", "DOCS_INDEX.md.template", "CONTEXT_MANIFEST.json.template"]) {
    assert.ok(existsSync(join(root, "templates", t)), `templates/${t} missing`);
  }
});

test("reviewer and QA skills exclude write/edit tools", () => {
  for (const skill of ["reviewer", "qa"]) {
    const content = readFileSync(join(root, "skills", skill, "SKILL.md"), "utf-8");
    const m = content.match(/allowed-tools:\s*(.+)/);
    assert.ok(m, `${skill} missing allowed-tools`);
    assert.ok(!/\b(write|edit)\b/.test(m[1]), `${skill} must not allow write/edit`);
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

test("skill frontmatter valid for cross-harness discovery", () => {
  const skillsDir = join(root, "skills");
  for (const dir of readdirSync(skillsDir)) {
    const skillPath = join(skillsDir, dir, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    const content = readFileSync(skillPath, "utf-8");
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fm, `${dir}: missing frontmatter`);
    const name = fm[1].match(/^name:\s*(.+)$/m)?.[1].trim();
    assert.ok(name, `${dir}: missing name`);
    assert.equal(name, dir, `${dir}: name must match directory`);
    assert.match(name, /^[a-z0-9-]+$/, `${dir}: name must be lowercase alphanumeric with hyphens`);
    assert.ok(name.length <= 64, `${dir}: name exceeds 64 chars`);
    const desc = fm[1].match(/^description:\s*(.+)$/m)?.[1];
    assert.ok(desc, `${dir}: missing description`);
    assert.ok(desc.length <= 1024, `${dir}: description exceeds 1024 chars`);
  }
});
