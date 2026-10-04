// Token budget: what every session pays for (skill descriptions, rules file, starter templates) stays small.
// A ceiling here is a reminder: raising it should be a decision, not drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(join(root, p), "utf-8").replace(/\r\n/g, "\n");
const skills = readdirSync(join(root, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

test("skill descriptions are loaded into every session: each is short and the total is bounded", () => {
  let total = 0;
  for (const name of skills) {
    const desc = /^description:\s*(.+)$/m.exec(read(`skills/${name}/SKILL.md`))[1];
    assert.ok(desc.length <= 450, `${name}: description is ${desc.length} chars (budget 450)`);
    total += desc.length;
  }
  assert.ok(total <= 2_200, `skill descriptions total ${total} chars (budget 2200)`);
});

test("the orchestrator skill keeps its procedure in a reference, so a CLI run never loads it", () => {
  assert.ok(read("skills/invoking-agents/SKILL.md").length <= 4_500);
  assert.ok(read("skills/invoking-agents/references/manual.md").includes("## Step 1: The round loop"));
});

test("the rules file and the starter templates stay small", () => {
  assert.ok(read("templates/rules/agent-flow.md").length <= 2_200, "rules file");
  assert.ok(read("templates/rules/agent-flow.kiro.md").length <= 2_300, "kiro rules file");
  assert.ok(read("templates/AGENTS.md.template").length <= 2_000, "AGENTS.md template");
  assert.ok(read("templates/DOCS_INDEX.md.template").length <= 1_000, "DOCS_INDEX.md template");
});

test("the role skills ask for terse output and the QA output limit favours the end of the log", () => {
  for (const s of ["implementer", "reviewer", "qa"]) {
    assert.match(read(`skills/${s}/SKILL.md`), /No text around it|Terse\.|No praise|nothing else/i, s);
  }
  assert.match(read("skills/qa/SKILL.md"), /first 50 and last 100/);
});
