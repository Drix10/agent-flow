// First-run experience: one command to a real answer, friendly failures, no setup step.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { suggestPath } from "../extensions/lib/stale.js";
import { validateManifest } from "../extensions/lib/manifest.js";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
const run = (cwd, args, env = {}) =>
  spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "", AGENT_FLOW_ROLE: "", ...env },
  });

function write(dir, rel, content) {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

/** A repo whose AGENTS.md still names a file that was renamed. No manifest. */
function renamedRepo({ commit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "af-dx-"));
  const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" }).toString();
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  write(dir, "package.json", JSON.stringify({ name: "demo", scripts: { test: "node --test", build: "tsc" }, dependencies: { express: "4" } }));
  write(dir, "src/index.ts", "export {};\n");
  write(dir, "src/users/user-service.ts", "export {};\n");
  write(dir, "AGENTS.md", "# demo\n\nEntry: `src/index.ts`.\nUsers: `src/users/service.ts`.\n");
  if (commit) {
    g("add", "-A");
    g("commit", "-qm", "init");
  }
  return { dir, g };
}

const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

test("doctor with zero setup: auto-discovers AGENTS.md, catches the rename, suggests the new path, exit 1", () => {
  const { dir } = renamedRepo();
  try {
    const r = run(dir, ["doctor"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /AGENTS\.md:4\s+src\/users\/service\.ts\s+→ did you mean src\/users\/user-service\.ts\?/);
    assert.match(r.stdout, /no CONTEXT_MANIFEST\.json.*agent-flow init/);
    assert.doesNotMatch(r.stdout + r.stderr, /manifest_not_found|\/repair-docs \(Gardener\)/);
    assert.match(r.stdout, /gardener skill's \/repair-docs procedure/);
    const j = JSON.parse(run(dir, ["doctor", "--json"]).stdout);
    assert.equal(j.mode, "discovered");
    assert.deepEqual(j.report.missing_paths, [{ file: "AGENTS.md", path: "src/users/service.ts", source: "prose", suggestion: "src/users/user-service.ts" }]);

    write(dir, "AGENTS.md", "Entry: `src/index.ts`.\n");
    assert.equal(run(dir, ["doctor"]).status, 0);
  } finally {
    cleanup(dir);
  }
});

test("doctor discovers nested and per-harness context files, skipping node_modules", () => {
  const { dir } = renamedRepo();
  try {
    write(dir, "AGENTS.md", "fine\n");
    write(dir, "packages/api/AGENTS.md", "Handlers: `src/handlers/`.\n"); // relative to packages/api
    write(dir, "packages/api/src/handlers/a.ts", "");
    write(dir, ".cursor/rules/style.mdc", "See `src/gone.ts`.\n");
    write(dir, ".github/copilot-instructions.md", "See `src/index.ts`.\n");
    write(dir, "node_modules/x/AGENTS.md", "See `src/nope.ts`.\n");
    const j = JSON.parse(run(dir, ["doctor", "--json"]).stdout);
    assert.deepEqual(j.context_files, ["AGENTS.md", ".github/copilot-instructions.md", ".cursor/rules/style.mdc", "packages/api/AGENTS.md"]);
    assert.deepEqual(j.report.missing_paths.map((m) => `${m.file}:${m.path}`), [".cursor/rules/style.mdc:src/gone.ts"]);
  } finally {
    cleanup(dir);
  }
});

test("doctor on a repo with no context files is a friendly note, exit 0 (a fresh repo isn't broken in CI)", () => {
  const dir = mkdtempSync(join(tmpdir(), "af-dx-empty-"));
  try {
    const r = run(dir, ["doctor"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no agent context files found/);
    assert.match(r.stdout, /agent-flow init/);
  } finally {
    cleanup(dir);
  }
});

test("an empty or context-less manifest falls back to discovery instead of hiding the broken ref", () => {
  const { dir } = renamedRepo();
  try {
    for (const m of [{}, { context_files: [] }]) {
      write(dir, "CONTEXT_MANIFEST.json", JSON.stringify(m));
      const r = run(dir, ["doctor"]);
      assert.equal(r.status, 1, JSON.stringify(m));
      assert.match(r.stdout, /src\/users\/service\.ts/);
    }
  } finally {
    cleanup(dir);
  }
});

test("doctor on an unfilled template agrees with itself: no ✓ for timestamps or placeholders", () => {
  const { dir } = renamedRepo();
  try {
    write(dir, "CONTEXT_MANIFEST.json", run(dir, ["template", "CONTEXT_MANIFEST.json"]).stdout);
    const r = run(dir, ["doctor"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /✗ timestamps valid/);
    assert.match(r.stdout, /✗ no unfilled placeholders/);
    assert.doesNotMatch(r.stdout, /✓ timestamps valid|✓ no unfilled placeholders/);
    assert.doesNotMatch(r.stdout, /\{\{PATH_NAMED_IN_AGENTS_MD\}\} \(manifest\)/, "a placeholder isn't a missing path");
  } finally {
    cleanup(dir);
  }
});

test("invalid-JSON manifest: one line naming the file once, with a next step", () => {
  const { dir } = renamedRepo();
  try {
    write(dir, "CONTEXT_MANIFEST.json", "{nope");
    const r = run(dir, ["doctor"]);
    assert.equal(r.status, 2);
    const text = r.stdout + r.stderr;
    assert.equal(text.split("CONTEXT_MANIFEST.json").length - 1, 1, text);
    assert.match(text, /not valid JSON.*agent-flow init/);
  } finally {
    cleanup(dir);
  }
});

test("suggestPath only answers when confident", () => {
  const files = ["src/users/user-service.ts", "src/users/index.ts", "src/lib/util.ts", "lib/Auth.ts", "a/dup.ts", "b/dup.ts", "src/x/order-service.ts", "src/x/item-service.ts"];
  assert.equal(suggestPath("src/users/service.ts", files), "src/users/user-service.ts");
  assert.equal(suggestPath("lib/util.ts", files), "src/lib/util.ts");
  assert.equal(suggestPath("lib/auth.ts", files), "lib/Auth.ts");
  assert.equal(suggestPath("src/usres/", files), "src/users/");
  assert.equal(suggestPath("c/dup.ts", files), null, "two candidates: no guess");
  assert.equal(suggestPath("src/x/service.ts", files), null, "two renamed siblings: no guess");
  assert.equal(suggestPath("totally/unrelated.py", files), null);
});

test("init: non-TTY without --yes previews and writes nothing; --dry-run never writes; --yes writes a valid manifest + AGENTS.md", () => {
  const { dir } = renamedRepo();
  try {
    rmSync(join(dir, "AGENTS.md"));
    let r = run(dir, ["init"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--- AGENTS\.md \(would write\) ---/);
    assert.match(r.stdout, /--yes/);
    assert.ok(!existsSync(join(dir, "AGENTS.md")) && !existsSync(join(dir, "CONTEXT_MANIFEST.json")));
    r = run(dir, ["init", "--yes", "--dry-run"]);
    assert.equal(r.status, 0);
    assert.ok(!existsSync(join(dir, "CONTEXT_MANIFEST.json")));

    r = run(dir, ["init", "--yes"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf-8");
    assert.match(agents, /`npm test`/);
    assert.match(agents, /`npm run build`/);
    assert.match(agents, /`src\/` \| \| \[NEEDS VERIFICATION\]/);
    assert.doesNotMatch(agents, /\{\{/);
    const m = JSON.parse(readFileSync(join(dir, "CONTEXT_MANIFEST.json"), "utf-8"));
    assert.deepEqual(validateManifest(m), []);
    assert.equal(m.default_branch, "main");
    const refs = m.context_files.find((cf) => cf.path === "AGENTS.md").references;
    assert.ok(refs.some((x) => x.path === "src/" && x.type === "directory"));
    for (const x of refs) assert.equal(new Date(x.last_verified).toISOString(), x.last_verified);
    assert.equal(run(dir, ["doctor"]).status, 0, run(dir, ["doctor"]).stdout);

    // Never overwrites.
    write(dir, "AGENTS.md", "mine\n");
    r = run(dir, ["init", "--yes"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /CONTEXT_MANIFEST\.json exists — not overwritten/);
    assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf-8"), "mine\n");
  } finally {
    cleanup(dir);
  }
});

test("init records only references that exist, and works before the first commit", () => {
  const { dir } = renamedRepo({ commit: false });
  try {
    const r = run(dir, ["init", "--yes"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /1 referenced path\(s\) don't exist/);
    const m = JSON.parse(readFileSync(join(dir, "CONTEXT_MANIFEST.json"), "utf-8"));
    assert.equal(m.default_branch, "main");
    assert.deepEqual(m.context_files[0].references.map((x) => x.path), ["src/index.ts"]);
    const d = run(dir, ["doctor"]);
    assert.equal(d.status, 1);
    assert.match(d.stdout, /did you mean src\/users\/user-service\.ts/);
  } finally {
    cleanup(dir);
  }
});

test("typos get a did-you-mean and exit 2", () => {
  const { dir } = renamedRepo();
  try {
    let r = run(dir, ["docter"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown command "docter" — did you mean "doctor"\?/);
    assert.ok(r.stderr.length < 300, "no help dump");
    r = run(dir, ["install", "--harness", "claud"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown harness "claud" — did you mean "claude"\?/);
    r = run(dir, ["doctor", "--jsno"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown flag "--jsno" — did you mean "--json"\?/);
    assert.equal(run(dir, ["hook", "instal"]).status, 2);
  } finally {
    cleanup(dir);
  }
});

test("audit-risk lists what to review, grouped, without secret values or agent-flow itself", () => {
  const { dir } = renamedRepo();
  try {
    write(dir, "package.json", JSON.stringify({ dependencies: { express: "4", stripe: "1" }, devDependencies: { "@drix10/agent-flow": "1" } }));
    const key = "sk-ant-" + "q".repeat(30);
    write(dir, "src/k.ts", `export const k = "${key}";\n`);
    const r = run(dir, ["audit-risk"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /dependency\s+package\.json\s+express, stripe\n/);
    assert.match(r.stdout, /payment\s+package\.json\s+stripe/);
    assert.match(r.stdout, /secret\s+src\/k\.ts:1\s+Anthropic API key/);
    assert.doesNotMatch(r.stdout, /agent-flow,|@drix10\/agent-flow\n|q{30}/);
    assert.doesNotMatch(r.stdout, /\{"dependency"/);
    const j = JSON.parse(run(dir, ["audit-risk", "--json"]).stdout);
    assert.ok(!j.surfaces.some((s) => /@drix10\/agent-flow/.test(s.detail)));
  } finally {
    cleanup(dir);
  }
});

test("internal errors become one friendly line with a next step", () => {
  const { dir } = renamedRepo();
  const fresh = renamedRepo({ commit: false });
  const plain = mkdtempSync(join(tmpdir(), "af-dx-plain-"));
  try {
    const cases = [
      [dir, ["worktree", "create"], /needs an issue number/],
      [dir, ["worktree", "create", "abc"], /"abc" is not an issue number/],
      [dir, ["classify", "--base", "nope"], /--base "nope": no such branch/],
      [fresh.dir, ["classify"], /no commits yet/],
      [plain, ["hook", "install"], /not a git repository — .*git init/],
      [plain, ["repair", "--yes"], /no CONTEXT_MANIFEST\.json to repair/],
    ];
    for (const [cwd, args, re] of cases) {
      const r = run(cwd, args);
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, re, args.join(" "));
      assert.equal(r.stderr.trim().split("\n").length, 1, `${args.join(" ")} printed:\n${r.stderr}`);
      assert.doesNotMatch(r.stderr, /fatal:|NaN|rev-parse/);
    }
  } finally {
    cleanup(dir);
    cleanup(fresh.dir);
    cleanup(plain);
  }
});

test("install --harness claude imports AGENTS.md into CLAUDE.md, idempotently, and prints next steps", () => {
  const { dir } = renamedRepo();
  try {
    let r = run(dir, ["install", "--harness", "claude", "--dry-run"]);
    assert.match(r.stdout, /would write CLAUDE\.md/);
    assert.ok(!existsSync(join(dir, "CLAUDE.md")));
    r = run(dir, ["install", "--harness", "claude"]);
    assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf-8"), "@AGENTS.md\n");
    assert.match(r.stdout, /agent-flow doctor[\s\S]*bootstrap skill[\s\S]*hook install/);
    assert.doesNotMatch(r.stdout, /Add `@AGENTS\.md`/);

    write(dir, "CLAUDE.md", "# Claude notes");
    run(dir, ["install", "--harness", "claude"]);
    run(dir, ["install", "--harness", "claude"]);
    assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf-8"), "# Claude notes\n\n@AGENTS.md\n");
  } finally {
    cleanup(dir);
  }
});

test("colors: FORCE_COLOR turns them on without a TTY; NO_COLOR wins", () => {
  const { dir } = renamedRepo();
  try {
    assert.match(run(dir, ["doctor"], { NO_COLOR: "", FORCE_COLOR: "1" }).stdout, /\x1b\[3\dm/);
    assert.doesNotMatch(run(dir, ["doctor"], { NO_COLOR: "1", FORCE_COLOR: "1" }).stdout, /\x1b\[/);
    assert.doesNotMatch(run(dir, ["doctor"], { NO_COLOR: "", FORCE_COLOR: "0" }).stdout, /\x1b\[/);
  } finally {
    cleanup(dir);
  }
});

test("read-only roles can't mutate pipeline state through the CLI", () => {
  const { dir } = renamedRepo();
  try {
    const denied = [
      ["reviewer", ["state", "update", "--issue", "1", "--state", "Working"]],
      ["qa", ["baseline", "accept", "--all", "--yes"]],
      ["reviewer", ["worktree", "create", "1"]],
      ["qa", ["worktree", "remove", "1"]],
      ["reviewer", ["repair", "--yes"]],
      ["reviewer", ["install", "--harness", "codex"]],
      ["qa", ["hook", "install"]],
      ["reviewer", ["init", "--yes"]],
      ["implementer", ["baseline", "accept", "--all", "--yes"]],
      ["implementer", ["repair", "--yes"]],
      ["implementer", ["install", "--harness", "codex"]],
      ["implementer", ["hook", "install"]],
      ["implementer", ["init", "--yes"]],
      ["implementer", ["state", "update", "--issue", "1", "--state", "Working"]], // only the orchestrator records state
      ["banana", ["state", "update", "--issue", "1", "--state", "Working"]], // unknown role fails closed
    ];
    for (const [role, args] of denied) {
      const r = run(dir, args, { AGENT_FLOW_ROLE: role });
      assert.equal(r.status, 2, `${role} ${args.join(" ")}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /may not run `agent-flow /);
    }
    assert.ok(!existsSync(join(dir, ".risk-baseline.json")) && !existsSync(join(dir, "CONTEXT_MANIFEST.json")) && !existsSync(join(dir, ".agents")));
    assert.equal(run(dir, ["state", "update", "--issue", "1", "--state", "Working"], { AGENT_FLOW_ROLE: "orchestrator" }).status, 0);
    assert.equal(run(dir, ["state"], { AGENT_FLOW_ROLE: "reviewer" }).status, 0, "reading is fine");
    assert.equal(run(dir, ["doctor"], { AGENT_FLOW_ROLE: "qa" }).status, 1, "checks still run");
  } finally {
    cleanup(dir);
  }
});

test("audit-risk never lists agent-flow itself as a dependency surface, so it can't land in the baseline either", async () => {
  const { auditRisk } = await import("../extensions/lib/risk.js");
  const dir = mkdtempSync(join(tmpdir(), "af-self-dep-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { "@drix10/agent-flow": "^1.1.0", stripe: "^14.0.0" } }));
    const keys = auditRisk(dir, join(dir, ".risk-baseline.json")).surfaces.map((s) => s.key);
    assert.ok(keys.includes("dependency:package.json:stripe"));
    assert.ok(!keys.some((k) => k.includes("@drix10/agent-flow")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
