// The copies this repo tracks for its own use must stay in step with their sources, and no tracked
// file may carry a path from the machine that wrote it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf-8");
const SKILLS = ["agent-flow-bootstrap", "agent-flow-gardener", "agent-flow-implementer", "agent-flow-invoking-agents", "agent-flow-qa", "agent-flow-reviewer"];

test("each harness's skill copy equals skills/", () => {
  for (const harness of [".agents", ".cursor", ".gemini"]) {
    for (const skill of SKILLS) {
      assert.equal(read(`${harness}/skills/${skill}/SKILL.md`), read(`skills/${skill}/SKILL.md`), `${harness}/skills/${skill} drifted from skills/${skill}`);
    }
    for (const ref of ["agent-flow-invoking-agents/references/launch.md", "agent-flow-invoking-agents/references/manual.md", "agent-flow-implementer/references/native-first.md"]) {
      assert.equal(read(`${harness}/skills/${ref}`), read(`skills/${ref}`), `${harness}/skills/${ref} drifted`);
    }
  }
  // The Codex plugin bundles the same skills (portable plugin.json + skills/ auto-discovery).
  for (const skill of SKILLS) {
    assert.equal(read(`plugins/agent-flow/skills/${skill}/SKILL.md`), read(`skills/${skill}/SKILL.md`), `plugins/agent-flow/skills/${skill} drifted from skills/${skill}`);
  }
  for (const ref of ["agent-flow-invoking-agents/references/launch.md", "agent-flow-invoking-agents/references/manual.md", "agent-flow-implementer/references/native-first.md"]) {
    assert.equal(read(`plugins/agent-flow/skills/${ref}`), read(`skills/${ref}`), `plugins/agent-flow/skills/${ref} drifted`);
  }
});

test("the tracked OpenCode plugin is the template with this repo's bin path", () => {
  const rendered = read("templates/opencode/agent-flow-guard.js").replace("__AGENT_FLOW_BIN__", () => "bin/agent-flow.js");
  assert.equal(read(".opencode/plugins/agent-flow-guard.js"), rendered);
});

test("no tracked file names a path on the machine that wrote it", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf-8" }).split("\0").filter(Boolean);
  const bad = [];
  for (const f of files) {
    if (f.startsWith("tests/") || f === "CHANGELOG.md" || !existsSync(join(root, f))) continue;
    if (/\.(png|gif|mp4|m4a|jpg|ico)$/i.test(f)) continue;
    if (/[A-Za-z]:[\\/]+Users[\\/]|\/home\/[a-z]+\/|\/Users\/[a-z]+\//.test(read(f))) bad.push(f);
  }
  assert.deepEqual(bad, []);
});
