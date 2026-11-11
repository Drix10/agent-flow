// Credential stores (cloud, ssh, npm, the host agent's own login) are not readable by an agent, force-adding an env file is not allowed,
// and `agent-flow env-check` is the way to ask whether a key is set without ever printing it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "../extensions/lib/guard.js";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "af-cred-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    for (const d of [".aws", ".ssh", ".config/gh"]) mkdirSync(join(home, d), { recursive: true });
    for (const f of [".aws/credentials", ".ssh/id_rsa", ".ssh/id_rsa.pub", ".ssh/known_hosts", ".ssh/config", ".config/gh/hosts.yml", ".npmrc"]) writeFileSync(join(home, f), "x\n");
    return fn(home);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }
}
const sh = (home, command, extra = {}) => decide({ role: null, toolName: "Bash", input: { command }, cwd: home, root: home, manifest: null, ...extra })?.rule ?? null;
const read = (home, file_path) => decide({ role: null, toolName: "Read", input: { file_path }, cwd: home, root: home, manifest: null })?.rule ?? null;

test("credential stores in the home directory are blocked for reads, by shell and by the read tool", () => {
  withHome((home) => {
    for (const f of [".aws/credentials", ".ssh/id_rsa", ".config/gh/hosts.yml", ".npmrc"]) {
      assert.equal(sh(home, `cat ~/${f}`), "secret-read", `cat ~/${f}`);
      assert.equal(read(home, join(home, f)), "secret-read", `Read ${f}`);
    }
    assert.equal(sh(home, "grep -r KEY ~/.aws"), "secret-read", "a sweep of the credential directory");
    for (const f of [".ssh/id_rsa.pub", ".ssh/known_hosts", ".ssh/config"]) assert.equal(sh(home, `cat ~/${f}`), null, `cat ~/${f} is not a secret`);
  });
});

test("commands that print a stored credential are blocked; the harmless ones are not", () => {
  withHome((home) => {
    for (const c of ["gh auth token", "gh auth status --show-token", "git credential fill", "security find-generic-password -s x -w"]) assert.equal(sh(home, c), "secret-read", c);
    for (const c of ["gh auth status", "gh pr list", "git credential-cache exit", "security list-keychains"]) assert.equal(sh(home, c), null, c);
  });
});

test("git add -f never stages an env file or a directory of ignored files", () => {
  withHome((home) => {
    mkdirSync(join(home, "src"));
    writeFileSync(join(home, ".env"), "K=1\n");
    writeFileSync(join(home, "src", "a.ts"), "x\n");
    for (const c of ["git add -f .env", "git add --force .env.local", "git add -f .", "git add -f src", "git add -f *", "git add -f $F"]) assert.equal(sh(home, c), "secret-read", c);
    for (const c of ["git add -f src/a.ts", "git add src/a.ts", "git add -A"]) assert.equal(sh(home, c), null, c);
  });
});

test("agent-flow env-check says whether a variable is set and how long it is, never its value", () => {
  const dir = mkdtempSync(join(tmpdir(), "af-env-"));
  try {
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    writeFileSync(join(dir, ".env"), 'OPENAI_API_KEY=sk-aaaaaaaaaaaaaaaaaaaa\nEMPTY=\nexport QUOTED="hello world"\n# COMMENTED=1\n');
    const run = (...a) => spawnSync(process.execPath, [BIN, "env-check", ...a], { cwd: dir, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1", FROM_PROCESS: "abc" } });
    const r = run("OPENAI_API_KEY", "QUOTED", "EMPTY", "NOPE", "FROM_PROCESS", "--json");
    assert.equal(r.status, 1, "a missing name fails");
    assert.doesNotMatch(r.stdout + r.stderr, /sk-aaaa|hello world|abc\b/, "no value is ever printed");
    const rows = Object.fromEntries(JSON.parse(r.stdout).map((x) => [x.name, x]));
    assert.deepEqual([rows.OPENAI_API_KEY.set, rows.OPENAI_API_KEY.length, rows.QUOTED.length, rows.EMPTY.set, rows.NOPE.set, rows.FROM_PROCESS.source], [true, 23, 11, false, false, "process environment"]);
    const all = run("--json");
    assert.deepEqual(JSON.parse(all.stdout).map((x) => x.name).sort(), ["EMPTY", "OPENAI_API_KEY", "QUOTED"], "no names lists the defined variables");
    assert.equal(run("OPENAI_API_KEY").status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
