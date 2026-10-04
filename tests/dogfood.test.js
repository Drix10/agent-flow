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
const SKILLS = ["bootstrap", "gardener", "implementer", "invoking-agents", "qa", "reviewer"];

test("each harness's skill copy equals skills/", () => {
  for (const harness of [".agents", ".cursor", ".gemini"]) {
    for (const skill of SKILLS) {
      assert.equal(read(`${harness}/skills/${skill}/SKILL.md`), read(`skills/${skill}/SKILL.md`), `${harness}/skills/${skill} drifted from skills/${skill}`);
    }
    for (const ref of ["invoking-agents/references/launch.md", "invoking-agents/references/manual.md", "implementer/references/native-first.md"]) {
      assert.equal(read(`${harness}/skills/${ref}`), read(`skills/${ref}`), `${harness}/skills/${ref} drifted`);
    }
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
