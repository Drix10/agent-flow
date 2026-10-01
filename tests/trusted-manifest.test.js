// What judges a change (gates, policy, secret_scan, pipeline) is read from the default branch, not from a working copy an agent can edit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { trustedManifest } from "../extensions/lib/manifest.js";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
const git = (dir, ...a) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir, encoding: "utf-8" });
const cli = (dir, env, ...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1", AGENT_FLOW_ROLE: "", ...env } });
const write = (dir, m) => writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify(m));
const node = (code) => [process.execPath, "-e", code];

/** A repo whose main branch commits `committed`, with `edited` then written to the working copy. */
function repo(committed, edited, fn) {
  const dir = mkdtempSync(join(tmpdir(), "af-trust-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    write(dir, committed);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    git(dir, "checkout", "-q", "-b", "agent/issue-1");
    if (edited) write(dir, edited);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const committed = {
  version: "1",
  protected_paths: ["secrets/"],
  gates: [{ name: "unit", command: node("process.exit(0)") }],
  policy: { max_changed_files: 5 },
  pipeline: { max_review_rounds: 2 },
};

test("gates, policy and pipeline come from the default branch; the working copy's edits are ignored", () => {
  const edited = {
    ...committed,
    gates: [{ name: "evil", command: node("process.exit(0)") }],
    policy: { max_changed_files: 500 },
    pipeline: { max_review_rounds: 5 },
    secret_scan: { ignore_paths: ["**"] },
  };
  repo(committed, edited, (dir) => {
    const t = trustedManifest(dir);
    assert.deepEqual(t.manifest.gates.map((g) => g.name), ["unit"]);
    assert.equal(t.manifest.policy.max_changed_files, 5);
    assert.equal(t.manifest.pipeline.max_review_rounds, 2);
    assert.equal(t.manifest.secret_scan, undefined);
    assert.deepEqual(t.ignoredEdits.sort(), ["gates", "pipeline", "policy", "secret_scan"]);
  });
});

test("`gates list` shows the committed gates and says the working copy's differ", () => {
  const edited = { ...committed, gates: [{ name: "evil", command: node("process.exit(0)") }] };
  repo(committed, edited, (dir) => {
    const r = cli(dir, {}, "gates", "list");
    assert.match(r.stdout, /unit/);
    assert.doesNotMatch(r.stdout, /evil/);
    assert.match(r.stdout, /working copy's gates differ/);
  });
});

test("an agent can't add a gate the orchestrator would then run", () => {
  const edited = { ...committed, gates: [...committed.gates, { name: "extra", command: node("process.exit(1)") }] };
  repo(committed, edited, (dir) => {
    const r = cli(dir, {}, "gates", "run", "--json");
    const names = JSON.parse(r.stdout).results.map((x) => x.name);
    assert.deepEqual(names, ["unit"]);
    assert.equal(r.status, 0);
  });
});

test("a human can opt in to the working copy while iterating locally", () => {
  const edited = { ...committed, gates: [{ name: "mine", command: node("process.exit(0)") }] };
  repo(committed, edited, (dir) => {
    const t = spawnSync(process.execPath, ["-e", `import("${new URL("../extensions/lib/manifest.js", import.meta.url).href}").then(m=>console.log(JSON.stringify(m.trustedManifest(process.cwd()).manifest.gates.map(g=>g.name))))`], { cwd: dir, encoding: "utf-8", env: { ...process.env, AGENT_FLOW_TRUST_WORKING_MANIFEST: "1" } });
    assert.equal(t.stdout.trim(), '["mine"]');
  });
});

test("risk_boundaries: the working copy may add entries but not remove committed ones", () => {
  const base = { ...committed, risk_boundaries: [{ path: "src/billing/", risk_level: "critical" }] };
  const edited = { ...base, risk_boundaries: [{ path: "src/docs/", risk_level: "low" }] };
  repo(base, edited, (dir) => {
    const paths = trustedManifest(dir).manifest.risk_boundaries.map((b) => b.path);
    assert.deepEqual(paths, ["src/billing/", "src/docs/"]);
  });
});

test("a deleted or unparseable working copy falls back to the committed manifest", () => {
  repo(committed, null, (dir) => {
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), "{ not json");
    assert.deepEqual(trustedManifest(dir).manifest.gates.map((g) => g.name), ["unit"]);
  });
});

test("with no committed manifest anywhere, the working copy is used (first-time adoption)", () => {
  const dir = mkdtempSync(join(tmpdir(), "af-trust-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    write(dir, committed);
    assert.deepEqual(trustedManifest(dir).manifest.gates.map((g) => g.name), ["unit"]);
    assert.deepEqual(trustedManifest(dir).ignoredEdits, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("protected_paths and deny_read: deleting them from the working copy doesn't lower the committed floor", () => {
  const base = { ...committed, deny_read: ["private/"] };
  const edited = { ...base, protected_paths: [], deny_read: [] };
  repo(base, edited, (dir) => {
    const t = trustedManifest(dir).manifest;
    assert.deepEqual(t.protected_paths, ["secrets/"]);
    assert.deepEqual(t.deny_read, ["private/"]);
  });
});

test("reordering a manifest's keys isn't reported as an ignored edit", () => {
  const edited = { pipeline: committed.pipeline, policy: committed.policy, gates: committed.gates, protected_paths: committed.protected_paths, version: "1" };
  repo(committed, edited, (dir) => assert.deepEqual(trustedManifest(dir).ignoredEdits, []));
});

test("pipeline.harness_by_role is validated", async () => {
  const { validateManifest } = await import("../extensions/lib/manifest.js");
  assert.deepEqual(validateManifest({ pipeline: { harness_by_role: { reviewer: "codex" } } }).filter((p) => /harness_by_role/.test(p)), []);
  assert.equal(validateManifest({ pipeline: { harness_by_role: { reviewer: "gpt" } } }).filter((p) => /harness_by_role/.test(p)).length, 1);
  assert.equal(validateManifest({ pipeline: { harness_by_role: { orchestrator: "claude" } } }).filter((p) => /harness_by_role/.test(p)).length, 1);
});

test("`config get` reads a value the way the pipeline does: from the default branch for floored keys", () => {
  const edited = { ...committed, pipeline: { max_review_rounds: 5, models: { fast: "evil" } } };
  repo({ ...committed, pipeline: { models: { fast: "sonnet" } } }, edited, (dir) => {
    assert.equal(cli(dir, {}, "config", "get", "pipeline.models.fast").stdout.trim(), "sonnet");
    assert.equal(cli(dir, {}, "config", "get", "pipeline.nope").stdout.trim(), "");
    assert.equal(cli(dir, {}, "config", "get", "version").stdout.trim(), "1");
  });
});
