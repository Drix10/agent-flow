import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { toSarif } from "../extensions/lib/sarif.js";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
const af = (dir, ...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" } });

test("toSarif: 2.1.0 shape, forward-slash URIs, only the rules in use", () => {
  const s = toSarif("9.9.9", [{ id: "a", description: "A" }, { id: "b", description: "B" }], [{ ruleId: "a", level: "error", message: "m", path: "x\\y.md", line: 3 }, { ruleId: "a", level: "note", message: "no location" }]);
  assert.equal(s.version, "2.1.0");
  const run = s.runs[0];
  assert.deepEqual(run.tool.driver.rules.map((r) => r.id), ["a"]);
  assert.equal(run.tool.driver.version, "9.9.9");
  assert.equal(run.results[0].locations[0].physicalLocation.artifactLocation.uri, "x/y.md");
  assert.equal(run.results[0].locations[0].physicalLocation.region.startLine, 3);
  assert.equal(run.results[1].locations, undefined);
});

test("doctor --sarif and audit-risk --sarif emit valid logs with locations", () => {
  const dir = mkdtempSync(join(tmpdir(), "af-sarif-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "AGENTS.md"), "# Rules\n\nSee `src/gone.ts` for the entry point.\n");
    writeFileSync(join(dir, "config.js"), `const key = "AKIA${"A".repeat(16)}"; // demo\n`);
    const d = af(dir, "doctor", "--sarif");
    assert.equal(d.status, 1);
    const dl = JSON.parse(d.stdout);
    const hit = dl.runs[0].results.find((r) => r.ruleId === "agent-flow/broken-reference");
    assert.ok(hit, d.stdout);
    assert.equal(hit.locations[0].physicalLocation.artifactLocation.uri, "AGENTS.md");
    assert.equal(hit.locations[0].physicalLocation.region.startLine, 3);
    const a = af(dir, "audit-risk", "--sarif");
    const al = JSON.parse(a.stdout);
    assert.equal(al.version, "2.1.0");
    assert.ok(al.runs[0].results.some((r) => r.locations?.[0].physicalLocation.artifactLocation.uri === "config.js"), a.stdout);
    assert.ok(!a.stdout.includes("A".repeat(16)), "no secret value in SARIF");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
