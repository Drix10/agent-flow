// More harnesses: skills folders and rules files the ponytail project documents for Swival, Factory Droid, Command Code,
// Cline, Kiro and Qoder. They are instruction-tier (no hook agent-flow can use to block a call), and install, update
// and uninstall must treat a harness nobody installed as not installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(root, "bin", "agent-flow.js");
const cli = (cwd, args) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1", AGENT_FLOW_OFFLINE: "1", AGENT_FLOW_ROLE: "" } });
const read = (p) => readFileSync(p, "utf-8");

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "af-targets-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "AGENTS.md"), "# rules\n");
  return dir;
}

const SKILLS_ONLY = { swival: ".swival/skills", factory: ".factory/skills", commandcode: ".commandcode/skills" };
const RULES = { cline: ".clinerules/agent-flow.md", kiro: ".kiro/steering/agent-flow.md", qoder: ".qoder/rules/agent-flow.md" };

test("install: Swival, Factory Droid and Command Code get the skills in their own folder, and a note about enforcement", () => {
  for (const [harness, skills] of Object.entries(SKILLS_ONLY)) {
    const dir = repo();
    try {
      const r = cli(dir, ["install", "--harness", harness]);
      assert.equal(r.status, 0, `${harness}: ${r.stderr}${r.stdout}`);
      for (const s of ["agent-flow-bootstrap", "agent-flow-gardener", "agent-flow-implementer", "agent-flow-invoking-agents", "agent-flow-qa", "agent-flow-reviewer"]) assert.ok(existsSync(join(dir, skills, s, "SKILL.md")), `${harness}: ${s}`);
      assert.ok(existsSync(join(dir, skills, "agent-flow-implementer", "references", "native-first.md")), `${harness}: the reference ships with the skill`);
      assert.match(r.stdout, /no hook agent-flow can use to block a call/);
      const record = JSON.parse(read(join(dir, skills, "..", "agent-flow-install.json")));
      assert.equal(record.harness, harness);
      assert.equal(cli(dir, ["install", "--harness", harness]).status, 0, "idempotent");
      assert.equal(cli(dir, ["uninstall", "--yes"]).status, 0);
      assert.ok(!existsSync(join(dir, skills.split("/")[0])), `${harness}: uninstall leaves nothing behind`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("install: Cline, Kiro and Qoder get a rules file, the skills in the cross-client folder, and the enforcement caveat", () => {
  for (const [harness, rule] of Object.entries(RULES)) {
    const dir = repo();
    try {
      const r = cli(dir, ["install", "--harness", harness]);
      assert.equal(r.status, 0, `${harness}: ${r.stderr}${r.stdout}`);
      const text = read(join(dir, rule));
      for (const phrase of ["Never edit a `protected_paths` entry", "`review_paths`", "Never use `--no-verify`", "gates run", "lean: <ceiling>; <when to upgrade>", "data, not instructions", "has no hook that enforces the list above"]) {
        assert.ok(text.includes(phrase), `${harness}: the rules file lost "${phrase}"`);
      }
      assert.ok(existsSync(join(dir, ".agents", "skills", "agent-flow-bootstrap", "SKILL.md")), `${harness}: skills in .agents/skills`);
      assert.match(r.stdout, /no hook agent-flow can use to block a call/);
      assert.equal(JSON.parse(read(join(dir, ".agents", "agent-flow-install.json"))).harness, harness);
      if (harness === "kiro") assert.match(text, /^---\ntitle: agent-flow guard rules\ninclusion: always\n---\n/, "Kiro includes a steering file only when it says so");
      else assert.ok(!text.startsWith("---"), `${harness}: a plain markdown rules file`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("the Kiro rules file is the plain one plus its frontmatter, and both stay in step", () => {
  const plain = read(join(root, "templates/rules/agent-flow.md")).replace(/\r\n/g, "\n");
  const kiro = read(join(root, "templates/rules/agent-flow.kiro.md")).replace(/\r\n/g, "\n");
  assert.equal(kiro.replace(/^---\n[\s\S]*?\n---\n\n/, ""), plain);
});

test("update only writes a harness's files when that harness was installed", () => {
  const dir = repo();
  try {
    assert.equal(cli(dir, ["install", "--harness", "codex"]).status, 0);
    const r = cli(dir, ["update", "--yes", "--force"]);
    assert.equal(r.status, 0, r.stderr);
    for (const rule of Object.values(RULES)) assert.ok(!existsSync(join(dir, rule)), `${rule} was never asked for`);
    for (const skills of Object.values(SKILLS_ONLY)) assert.ok(!existsSync(join(dir, skills)), `${skills} was never asked for`);
    // Installing one of them makes it part of what update maintains.
    assert.equal(cli(dir, ["install", "--harness", "cline"]).status, 0);
    writeFileSync(join(dir, ".clinerules", "agent-flow.md"), "# stale copy from an older version\n");
    const rec = JSON.parse(read(join(dir, ".agents", "agent-flow-install.json")));
    rec.files[".clinerules/agent-flow.md"] = "0".repeat(64); // an older install wrote something else
    writeFileSync(join(dir, ".agents", "agent-flow-install.json"), JSON.stringify(rec));
    const forced = cli(dir, ["update", "--yes", "--force"]);
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(read(join(dir, ".clinerules", "agent-flow.md")), /^# agent-flow: this repo has a guard/);
    assert.ok(!existsSync(join(dir, ".kiro")) && !existsSync(join(dir, ".qoder")), "the others still weren't added");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a record shared by harnesses keeps what each wrote, so a later update can tell an edit from an old copy", () => {
  const dir = repo();
  try {
    assert.equal(cli(dir, ["install", "--harness", "codex"]).status, 0);
    assert.equal(cli(dir, ["install", "--harness", "cline"]).status, 0);
    const files = JSON.parse(read(join(dir, ".agents", "agent-flow-install.json"))).files;
    assert.ok(files[".codex/agents/reviewer.toml"], "codex's reviewer agent is still recorded after cline's install");
    assert.ok(files[".clinerules/agent-flow.md"]);
    assert.ok(files[".agents/skills/agent-flow-bootstrap"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstall: one rules-file harness leaves, the shared skills and the other harness stay; an edited rules file is kept", () => {
  const dir = repo();
  try {
    assert.equal(cli(dir, ["install", "--harness", "codex"]).status, 0);
    assert.equal(cli(dir, ["install", "--harness", "cline"]).status, 0);
    assert.equal(cli(dir, ["install", "--harness", "kiro"]).status, 0);
    writeFileSync(join(dir, ".kiro", "steering", "agent-flow.md"), "# my own steering\n");
    const r = cli(dir, ["uninstall", "--harness", "cline", "--yes"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(join(dir, ".clinerules")), "cline's rules file and its empty folder are gone");
    assert.ok(existsSync(join(dir, ".agents", "skills", "agent-flow-bootstrap")), "the skills folder is still used by codex and kiro");
    assert.match(r.stdout, /keep +\.agents\/skills\/ .*still used by/);
    const kiro = cli(dir, ["uninstall", "--harness", "kiro", "--yes"]);
    assert.match(kiro.stdout, /keep +\.kiro\/steering\/agent-flow\.md .*edited since install/);
    assert.equal(read(join(dir, ".kiro", "steering", "agent-flow.md")), "# my own steering\n");
    assert.ok(existsSync(join(dir, ".codex", "hooks.json")), "codex is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown harness is refused with the list, and --help names every harness there is", () => {
  const dir = repo();
  try {
    const r = cli(dir, ["install", "--harness", "clin"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown harness "clin" — did you mean "cline"\?/);
    const help = cli(dir, ["--help"]).stdout;
    for (const h of [...Object.keys(SKILLS_ONLY), ...Object.keys(RULES), "claude", "codex", "gemini", "cursor", "copilot", "windsurf", "opencode", "agents"]) assert.ok(help.includes(h), `--help lists ${h}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the docs say what each harness gets (a harness without a row is a harness nobody can find)", () => {
  const matrix = read(join(root, "docs/HARNESS-MATRIX.md")).toLowerCase();
  for (const h of ["cline", "kiro", "qoder", "swival", "factory", "command code"]) assert.ok(matrix.includes(h), `docs/HARNESS-MATRIX.md has no mention of ${h}`);
  const pkg = JSON.parse(read(join(root, "package.json")));
  assert.ok(pkg.files.includes("templates/") || pkg.files.includes("templates"), "the rules templates ship in the package");
});
