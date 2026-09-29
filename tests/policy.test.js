// Manifest policy rules: size limits, forbidden added lines, source-needs-tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluatePolicy, validatePolicy } from "../extensions/lib/policy.js";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
const run = (cmd, args, cwd, env = {}) => spawnSync(cmd, args, { cwd, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1", ...env } });
const af = (dir, ...a) => run(process.execPath, [BIN, ...a], dir);
const put = (dir, f, text) => {
  mkdirSync(dirname(join(dir, f)), { recursive: true });
  writeFileSync(join(dir, f), text);
};

function repo(policy, boundaries = [{ path: "docs/**", risk_level: "low" }]) {
  const dir = mkdtempSync(join(tmpdir(), "af-policy-"));
  for (const a of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"], ["config", "commit.gpgsign", "false"]]) run("git", a, dir);
  put(dir, "CONTEXT_MANIFEST.json", JSON.stringify({ version: "1", protected_paths: [], risk_boundaries: boundaries, policy }));
  put(dir, "src/a.js", "export const a = 1;\n");
  run("git", ["add", "-A"], dir);
  run("git", ["commit", "-qm", "init"], dir);
  return dir;
}

test("evaluatePolicy: limits, forbidden patterns, tests required", () => {
  const stats = new Map([["src/a.js", { added: 30, removed: 30 }]]);
  const v = evaluatePolicy(
    { max_changed_files: 1, max_diff_lines: 50, forbid_patterns: [{ paths: ["src/**"], pattern: "console\\.log", message: "no console.log" }], require_tests: [{ paths: ["src/**"], tests: ["tests/**"] }] },
    ["src/a.js", "src/b.js"],
    stats,
    (f) => (f === "src/a.js" ? ["const x = 1;", "console.log(x)"] : []),
  );
  assert.deepEqual(v.map((x) => x.rule).sort(), ["forbid_patterns", "max_changed_files", "max_diff_lines", "require_tests"]);
  assert.match(v.find((x) => x.rule === "forbid_patterns").message, /no console\.log.*src\/a\.js/);
  const ok = evaluatePolicy({ require_tests: [{ paths: ["src/**"], tests: ["tests/**"] }] }, ["src/a.js", "tests/a.test.js"], null, () => []);
  assert.deepEqual(ok, []);
  assert.deepEqual(evaluatePolicy(null, ["x"], null, () => []), []);
});

test("validatePolicy names what is wrong", () => {
  assert.deepEqual(validatePolicy(undefined), []);
  assert.match(validatePolicy([]).join(), /must be an object/);
  const p = validatePolicy({ max_changed_files: 0, forbid_patterns: [{ pattern: "(" }], require_tests: [{ paths: [] }] }).join("\n");
  assert.match(p, /max_changed_files/);
  assert.match(p, /not a valid regular expression/);
  assert.match(p, /require_tests\[0\]\.tests/);
});

test("classify --fail-on-policy on a real branch diff, including an untracked file", () => {
  const dir = repo({ forbid_patterns: [{ pattern: "TODO\\(", message: "no TODO(" }], max_changed_files: 5 });
  try {
    run("git", ["checkout", "-qb", "feat"], dir);
    put(dir, "src/a.js", "export const a = 2; // TODO(me)\n");
    const r = af(dir, "classify", "--base", "main", "--fail-on-policy");
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /no TODO\(/);
    put(dir, "src/a.js", "export const a = 2;\n");
    put(dir, "src/new.js", "// TODO(untracked)\n");
    assert.equal(af(dir, "classify", "--base", "main", "--fail-on-policy").status, 1);
    put(dir, "src/new.js", "// fine\n");
    assert.equal(af(dir, "classify", "--base", "main", "--fail-on-policy").status, 0);
    const j = JSON.parse(af(dir, "classify", "--base", "main", "--json").stdout);
    assert.deepEqual(j.policy_violations, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classify --fail-on-heuristic fails only when risk_boundaries are unset", () => {
  const dir = repo(undefined, []);
  try {
    put(dir, "src/a.js", "export const a = 3;\n");
    assert.equal(af(dir, "classify", "--base", "main", "--fail-on-heuristic").status, 1);
    const withBoundaries = repo(undefined);
    try {
      put(withBoundaries, "src/a.js", "export const a = 3;\n");
      assert.equal(af(withBoundaries, "classify", "--base", "main", "--fail-on-heuristic").status, 0);
    } finally {
      rmSync(withBoundaries, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-staged enforces policy on the staged content only", () => {
  const dir = repo({ forbid_patterns: [{ paths: ["src/**"], pattern: "debugger", message: "no debugger" }], require_tests: [{ paths: ["src/**"], tests: ["tests/**"], message: "add a test" }] });
  try {
    put(dir, "src/a.js", "debugger;\n");
    run("git", ["add", "src/a.js"], dir);
    const r = af(dir, "check-staged");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /no debugger/);
    assert.match(r.stdout, /add a test/);
    put(dir, "src/a.js", "export const a = 4;\n"); // unstaged fix doesn't count
    assert.equal(af(dir, "check-staged").status, 1);
    run("git", ["add", "src/a.js"], dir);
    put(dir, "tests/a.test.js", "// t\n");
    run("git", ["add", "tests/a.test.js"], dir);
    assert.equal(af(dir, "check-staged").status, 0, af(dir, "check-staged").stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
