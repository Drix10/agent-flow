// Shared harness for tests that drive `runIssue` end to end: a real git repo with an origin, the real CLI as the
// orchestrator's tool belt, and a scripted agent in place of `claude`. Not a test file (node --test only picks up *.test.js).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runIssue } from "../extensions/lib/orchestrate.js";

export const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
export const N = 100001;
export const git = (cwd, ...a) => spawnSync("git", a, { cwd, encoding: "utf-8" });

/** A repo with a manifest, an `origin` to push to, and optional extra tracked files. */
export function makeRepo(manifest = {}, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "af-pipe-"));
  const root = join(dir, "repo");
  const remote = join(dir, "remote.git");
  mkdirSync(root);
  spawnSync("git", ["init", "-q", "--bare", remote]);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.test");
  git(root, "config", "user.name", "t");
  git(root, "config", "core.autocrlf", "false");
  writeFileSync(join(root, "AGENTS.md"), "# rules\n");
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(root, ...f.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(root, f), body);
  }
  writeFileSync(join(root, "CONTEXT_MANIFEST.json"), JSON.stringify({ version: "2", default_branch: "main", context_files: [{ path: "AGENTS.md", references: [] }], protected_paths: ["secret/**"], pipeline: { max_review_rounds: 2 }, ...manifest }));
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "origin", "main");
  return { dir, root, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const af = (root) => (a) => {
  const env = { ...process.env, NO_COLOR: "1", AGENT_FLOW_OFFLINE: "1" };
  delete env.AGENT_FLOW_ROLE;
  const r = spawnSync(process.execPath, [BIN, ...a], { cwd: root, encoding: "utf-8", env });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export function fakeSh() {
  const calls = [];
  let created = false;
  const sh = (cmd, a, cwd) => {
    if (cmd === "gh") {
      calls.push(a.join(" "));
      if (a[0] === "pr" && a[1] === "list") return { status: 0, stdout: created ? '[{"number":7,"url":"https://example.test/pull/7"}]' : "[]", stderr: "" };
      if (a[0] === "pr" && a[1] === "create") {
        created = true;
        return { status: 0, stdout: "https://example.test/pull/7\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    const r = spawnSync(cmd, a, { cwd, encoding: "utf-8" });
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { sh, calls };
}

export const implReport = (commit, extra = {}) => ({ status: "ready_for_review", issue: N, branch: `agent/issue-${N}`, commit, files_changed: ["x"], criteria: [{ criterion: "it works", evidence: "test" }], checks: { test: "passed" }, ...extra });
export const reviewReport = (round, extra = {}) => ({ status: "approved", round, summary: "ok", findings: [], criteria: [{ criterion: "it works", met: true, evidence: "read" }], ...extra });
export const qaReport = () => ({ status: "passed", issue: N, commands: [{ name: "t", command: "node t", exit_code: 0, raw_output: "ok" }] });

/** A scripted agent: `steps[role]` is a list of functions, one per call of that role; the last one repeats. */
export function fakeAgent(root, steps) {
  const calls = [];
  const counts = { implementer: 0, reviewer: 0, qa: 0 };
  const wt = join(root, ".worktrees", `issue-${N}`);
  const spawner = async (spec) => {
    const role = spec.env.AGENT_FLOW_ROLE;
    const list = steps[role] ?? [];
    const step = list[Math.min(counts[role]++, list.length - 1)] ?? (() => ({}));
    calls.push({ role, argv: spec.argv, env: spec.env });
    const out = step({ wt, round: Number(/-r(\d+)$/.exec(spec.base)[1]) });
    writeFileSync(`${spec.base}.argv`, JSON.stringify(spec.argv));
    writeFileSync(`${spec.base}.raw`, out.report ? JSON.stringify(out.report) : "");
    writeFileSync(`${spec.base}.exit`, "0");
    return { exit: 0, seconds: 1 };
  };
  return { spawner, calls, counts, wt };
}

/** An Implementer step that commits one new file and reports the real commit. */
export const commits = (name, extra = {}) => ({ wt }) => {
  mkdirSync(join(wt, ...name.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(join(wt, name), `${name}\n`);
  git(wt, "add", "-A");
  git(wt, "commit", "-qm", `add ${name}`);
  return { report: implReport(git(wt, "rev-parse", "HEAD").stdout.trim(), extra) };
};

export const reviewing = [({ round }) => ({ report: reviewReport(round) })];
export const passing = [() => ({ report: qaReport() })];

export async function run(env, agent, over = {}) {
  const { sh, calls } = fakeSh();
  const result = await runIssue({
    root: env.root, issue: N, title: "Add a thing", body: "It should print the thing, so that users see it.", fromGitHub: false,
    af: af(env.root), sh, spawner: agent.spawner, log: () => {}, pr: false, timeoutSec: 30, commands: "node t", ...over,
  });
  return { result, gh: calls };
}

export const readText = (p) => readFileSync(p, "utf-8");
