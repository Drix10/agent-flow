// pipeline.lean (how hard the Implementer and Reviewer push for the smallest correct change) and pipeline.isolate_roles
// (roles ignore this machine's global Claude Code settings), plus the report fields they add.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeArgs, retryArgs } from "../extensions/lib/orchestrate.js";
import { DEFAULT_LEAN, LEAN_LEVELS, leanLevel, validateManifest } from "../extensions/lib/manifest.js";
import { checkReport, reportSchema, strictSchema } from "../extensions/lib/report.js";
import { commits, fakeAgent, makeRepo, passing, readText, reviewReport, reviewing, run } from "./pipeline-harness.js";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const lastArg = (call) => call.argv.at(-1);

test("pipeline.lean: levels, default, and validation", () => {
  assert.deepEqual([...LEAN_LEVELS], ["off", "lite", "full"]);
  assert.equal(DEFAULT_LEAN, "lite");
  assert.equal(leanLevel(null), "lite");
  assert.equal(leanLevel({ pipeline: {} }), "lite");
  assert.equal(leanLevel({ pipeline: { lean: "full" } }), "full");
  assert.equal(leanLevel({ pipeline: { lean: "off" } }), "off");
  assert.equal(leanLevel({ pipeline: { lean: "ultra" } }), "lite", "an unknown level falls back, it never disables");
  const base = { version: "2", context_files: [] };
  assert.ok(!validateManifest({ ...base, pipeline: { lean: "full", isolate_roles: true } }).some((p) => /pipeline\.(lean|isolate_roles)/.test(p)));
  assert.ok(validateManifest({ ...base, pipeline: { lean: "ultra" } }).some((p) => /pipeline\.lean must be one of off, lite, full/.test(p)));
  assert.ok(validateManifest({ ...base, pipeline: { isolate_roles: "yes" } }).some((p) => /pipeline\.isolate_roles must be true or false/.test(p)));
});

test("claudeArgs: isolation adds --setting-sources project,local before the prompt, and only when asked", () => {
  for (const role of ["implementer", "reviewer", "qa"]) {
    const plain = claudeArgs(role, { prompt: "go", model: "sonnet", dirs: ["/a"] });
    assert.ok(!plain.includes("--setting-sources"), role);
    const iso = claudeArgs(role, { prompt: "go", model: "sonnet", dirs: ["/a"], isolate: true });
    const at = iso.indexOf("--setting-sources");
    assert.ok(at > 0, role);
    assert.equal(iso[at + 1], "project,local");
    assert.equal(iso.at(-1), "go", "the prompt is still last");
  }
  // A resumed retry keeps every flag the first launch had, isolation included.
  const argv = claudeArgs("implementer", { prompt: "go", isolate: true });
  const retried = retryArgs(argv, "6f1c2a9e-1b7d-4c53-9a0e-2d8f4b6c7a10", ["bad"]);
  assert.ok(retried.includes("--setting-sources") && retried.includes("--resume"));
});

for (const [setting, expected] of [[undefined, "lite"], ["off", "off"], ["lite", "lite"], ["full", "full"]]) {
  test(`run: the Implementer and Reviewer are told the lean level (${setting ?? "unset"} → ${expected}); QA is not`, async () => {
    const env = makeRepo(setting === undefined ? {} : { pipeline: { max_review_rounds: 2, lean: setting } });
    try {
      const agent = fakeAgent(env.root, { implementer: [commits("a.txt")], reviewer: reviewing, qa: passing });
      const { result } = await run(env, agent);
      assert.equal(result.status, "ready", JSON.stringify(result));
      const by = (role) => agent.calls.find((c) => c.role === role);
      assert.match(lastArg(by("implementer")), new RegExp(`Lean level: ${expected}\\.$`));
      assert.match(lastArg(by("reviewer")), new RegExp(`Lean level: ${expected}\\.$`));
      assert.doesNotMatch(lastArg(by("qa")), /Lean level/);
    } finally {
      env.cleanup();
    }
  });
}

test("run: a working copy can't switch the lean level off for its own review (it is read from the default branch)", async () => {
  const env = makeRepo({ pipeline: { max_review_rounds: 2, lean: "full" } });
  try {
    const { writeFileSync } = await import("node:fs");
    const path = join(env.root, "CONTEXT_MANIFEST.json");
    const m = JSON.parse(readFileSync(path, "utf-8"));
    m.pipeline.lean = "off";
    writeFileSync(path, JSON.stringify(m));
    const agent = fakeAgent(env.root, { implementer: [commits("a.txt")], reviewer: reviewing, qa: passing });
    await run(env, agent);
    assert.match(lastArg(agent.calls.find((c) => c.role === "implementer")), /Lean level: full\.$/);
  } finally {
    env.cleanup();
  }
});

test("run: isolate_roles launches every role with --setting-sources project,local; by default none is", async () => {
  for (const [isolate, want] of [[true, true], [undefined, false]]) {
    const env = makeRepo(isolate === undefined ? {} : { pipeline: { max_review_rounds: 2, isolate_roles: isolate } });
    try {
      const agent = fakeAgent(env.root, { implementer: [commits("a.txt")], reviewer: reviewing, qa: passing });
      await run(env, agent);
      assert.equal(agent.calls.length, 3);
      for (const c of agent.calls) assert.equal(c.argv.includes("--setting-sources"), want, `${c.role} isolate=${isolate}`);
    } finally {
      env.cleanup();
    }
  }
});

test("run --pr: deferred shortcuts and removable lines reach the pull request", async () => {
  const env = makeRepo();
  try {
    const shortcuts = [{ where: "src/queue.ts:40", ceiling: "one global lock", upgrade: "throughput needs per-account locks" }];
    const agent = fakeAgent(env.root, { implementer: [commits("a.txt", { shortcuts })], reviewer: [({ round }) => ({ report: reviewReport(round, { net_lines_removable: 12 }) })], qa: passing });
    const { result } = await run(env, agent, { pr: true });
    assert.equal(result.status, "pr", JSON.stringify(result));
    const body = readText(join(result.artifacts, "pr.md"));
    assert.match(body, /Deferred shortcuts/);
    assert.match(body, /- src\/queue\.ts:40: one global lock; upgrade when throughput needs per-account locks/);
    assert.match(body, /\(12 line\(s\) could still be cut\)/);
  } finally {
    env.cleanup();
  }
  // Nothing deferred and nothing to cut: the body says neither.
  const clean = makeRepo();
  try {
    const agent = fakeAgent(clean.root, { implementer: [commits("a.txt")], reviewer: reviewing, qa: passing });
    const { result } = await run(clean, agent, { pr: true });
    const body = readText(join(result.artifacts, "pr.md"));
    assert.doesNotMatch(body, /Deferred shortcuts|could still be cut/);
  } finally {
    clean.cleanup();
  }
});

test("reports: shortcuts and net_lines_removable validate, malformed ones don't, and strict mode makes them nullable", () => {
  const impl = { status: "ready_for_review", issue: 1, commit: "abc", shortcuts: [{ where: "a.ts:1", ceiling: "c", upgrade: "u" }] };
  assert.equal(checkReport("implementer", JSON.stringify(impl)).ok, true);
  const bad = checkReport("implementer", JSON.stringify({ ...impl, shortcuts: [{ where: "a.ts:1" }] }));
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => /shortcuts\[0\]\.ceiling: required/.test(p)), bad.problems.join("; "));
  const review = { status: "approved", round: 1, summary: "s", findings: [], criteria: [] };
  assert.equal(checkReport("reviewer", JSON.stringify({ ...review, net_lines_removable: 4 })).ok, true);
  assert.equal(checkReport("reviewer", JSON.stringify({ ...review, net_lines_removable: -1 })).ok, false);
  // Codex's strict schemas list every key: the new optional fields are nullable there and a null reads as absent.
  assert.deepEqual(strictSchema(reportSchema("implementer")).properties.shortcuts.type, ["array", "null"]);
  assert.deepEqual(strictSchema(reportSchema("reviewer")).properties.net_lines_removable.type, ["integer", "null"]);
  assert.equal(checkReport("reviewer", JSON.stringify({ ...review, net_lines_removable: null })).ok, true);
});

test("the skills carry the lean rules and the native-first reference ships with the implementer", () => {
  const impl = readText(join(root, "skills/agent-flow-implementer/SKILL.md"));
  for (const phrase of ["Lean level: off | lite | full", "Reuse before you write", "Root cause, not symptom", "Leave one runnable check", "lean: <the ceiling>", "Never lean away", "references/native-first.md", "`shortcuts`"]) {
    assert.ok(impl.includes(phrase), `implementer skill lost: ${phrase}`);
  }
  const rev = readText(join(root, "skills/agent-flow-reviewer/SKILL.md"));
  for (const phrase of ["Lean lens", "net_lines_removable", "`delete:`", "`stdlib:`", "`native:`", "`reuse:`", "`yagni:`", "`shrink:`", "never flag one small runnable check"]) {
    assert.ok(rev.toLowerCase().includes(phrase.toLowerCase()), `reviewer skill lost: ${phrase}`);
  }
  assert.ok(existsSync(join(root, "skills/agent-flow-implementer/references/native-first.md")));
  const launch = readText(join(root, "skills/agent-flow-invoking-agents/references/launch.md"));
  assert.ok(launch.includes("LEAN=\"$(lean)\"") && (launch.match(/Lean level: \$LEAN\./g) ?? []).length >= 8, "every manual launch prompt carries the level");
});
