// Smoke test: package integrity — every file package.json points at must exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
