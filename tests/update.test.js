// update: version awareness for every way agent-flow gets installed (npm, npx, vendored), and `update` itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fileState, hashTree, isNewer, latestVersion, parseVersion, updateCheckAllowed, updateNotice } from "../extensions/lib/update.js";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(PKG, "bin/agent-flow.js");
const CURRENT_VERSION = JSON.parse(readFileSync(join(PKG, "package.json"), "utf-8")).version;
const [CURRENT_MAJOR, CURRENT_MINOR, CURRENT_PATCH] = CURRENT_VERSION.split(".").map(Number);
const NEXT_VERSION = `${CURRENT_MAJOR}.${CURRENT_MINOR}.${CURRENT_PATCH + 1}`;
const run = (bin, cwd, args, env = {}) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1", AGENT_FLOW_OFFLINE: "1", ...env } });

/** A copy of this package that claims to be `version`, with `qa` changed: what a newer release looks like to a repo. */
function newerPackage(dir, version) {
  const dest = join(dir, "newer-pkg");
  for (const p of ["package.json", "bin", "extensions", "skills", "templates", "schemas", ".claude/agents", ".codex/agents", ".gemini/agents"]) {
    cpSync(join(PKG, p), join(dest, p), { recursive: true });
  }
  const pj = JSON.parse(readFileSync(join(dest, "package.json"), "utf-8"));
  pj.version = version;
  writeFileSync(join(dest, "package.json"), JSON.stringify(pj));
  appendFileSync(join(dest, "skills/qa/SKILL.md"), `\n<!-- new in ${version} -->\n`);
  return join(dest, "bin/agent-flow.js");
}

function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "af-update-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    writeFileSync(join(repo, "AGENTS.md"), "# rules\n");
    return fn(dir, repo);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("versions: only a plain x.y.z that is strictly higher counts as newer", () => {
  assert.deepEqual(parseVersion("v1.2.3"), [1, 2, 3]);
  assert.equal(parseVersion("1.2.3-beta.1"), null);
  assert.equal(isNewer("1.1.7", "1.1.6"), true);
  assert.equal(isNewer("1.10.0", "1.9.9"), true, "numeric, not string, comparison");
  assert.equal(isNewer("1.1.6", "1.1.6"), false);
  assert.equal(isNewer("2.0.0-rc.1", "1.1.6"), false, "a pre-release never nags");
  assert.equal(isNewer("junk", "1.1.6"), false);
});

test("file state: replace only what agent-flow itself wrote last time", () => {
  assert.equal(fileState("a", "a", "a"), "up_to_date");
  assert.equal(fileState("old", "new", "old"), "upgrade", "unchanged since install");
  assert.equal(fileState("mine", "new", "old"), "edited", "the user changed it");
  assert.equal(fileState("mine", "new", undefined), "edited", "no record: assume it is theirs");
  assert.equal(fileState(null, "new", undefined), "new");
});

test("update: upgrades what is untouched, keeps what was edited, and stays that way on the next run", () => {
  withRepo((dir, repo) => {
    assert.equal(run(BIN, repo, ["install", "--harness", "claude"]).status, 0);
    const record = JSON.parse(readFileSync(join(repo, ".claude/agent-flow-install.json"), "utf-8"));
    assert.ok(record.files[".claude/skills/qa"] && record.files[".agent-flow-runtime"], "install records what it wrote");
    appendFileSync(join(repo, ".claude/skills/reviewer/SKILL.md"), "\nour team rule\n");
    const newer = newerPackage(dir, "9.9.9");

    const preview = run(newer, repo, ["update"]);
    assert.match(preview.stdout, /\.agent-flow-runtime\/ +\d+\.\d+\.\d+ -> 9\.9\.9/);
    assert.match(preview.stdout, /\.claude\/skills\/qa +upgrade/);
    assert.match(preview.stdout, /reviewer was edited since install: kept/);
    assert.match(preview.stdout, /nothing changed/);
    assert.equal(run(newer, repo, ["update", "--check"]).status, 10, "scheduled CI can detect an available update");

    assert.equal(run(newer, repo, ["update", "--yes"]).status, 0);
    assert.match(readFileSync(join(repo, ".claude/skills/qa/SKILL.md"), "utf-8"), /new in 9\.9\.9/);
    assert.match(readFileSync(join(repo, ".claude/skills/reviewer/SKILL.md"), "utf-8"), /our team rule/, "the edit survives");
    assert.equal(JSON.parse(readFileSync(join(repo, ".agent-flow-runtime/package.json"), "utf-8")).version, "9.9.9");

    // The regression this guards: recording the edited file's current hash made it look "unchanged since install"
    // on the next run, and the run after that overwrote it.
    run(newer, repo, ["update", "--yes"]);
    assert.match(readFileSync(join(repo, ".claude/skills/reviewer/SKILL.md"), "utf-8"), /our team rule/, "still there after a second update");
    assert.match(run(newer, repo, ["update"]).stdout, /reviewer was edited since install: kept/);

    assert.equal(run(newer, repo, ["update", "--yes", "--force"]).status, 0);
    assert.doesNotMatch(readFileSync(join(repo, ".claude/skills/reviewer/SKILL.md"), "utf-8"), /our team rule/, "--force replaces it");
    assert.equal(run(newer, repo, ["update", "--check"]).status, 0, "now everything is current");
  });
});

test("update: the vendored copy explains how to update instead of crashing, and an older CLI never downgrades", () => {
  withRepo((dir, repo) => {
    run(BIN, repo, ["install", "--harness", "claude"]);
    const vendored = join(repo, ".agent-flow-runtime/bin/agent-flow.js");
    const r = run(vendored, repo, ["update"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /can't update itself/);
    assert.match(r.stdout, /npx @drix10\/agent-flow@latest update --yes/);

    const newer = newerPackage(dir, "9.9.9");
    run(newer, repo, ["update", "--yes"]);
    const old = run(BIN, repo, ["update"]);
    assert.match(old.stdout, /newer than this CLI .*not downgrading/);
  });
});

test("install records only what it wrote: a skill it refused to overwrite stays 'edited' for update", () => {
  withRepo((dir, repo) => {
    mkdirSync(join(repo, ".claude/skills/qa"), { recursive: true });
    writeFileSync(join(repo, ".claude/skills/qa/SKILL.md"), "my own qa skill\n");
    const inst = run(BIN, repo, ["install", "--harness", "claude"]);
    assert.match(inst.stdout, /qa exists and differs/);
    const record = JSON.parse(readFileSync(join(repo, ".claude/agent-flow-install.json"), "utf-8"));
    assert.equal(record.files[".claude/skills/qa"], undefined, "a file install did not write is not claimed");
    const newer = newerPackage(dir, "9.9.9");
    run(newer, repo, ["update", "--yes"]);
    assert.equal(readFileSync(join(repo, ".claude/skills/qa/SKILL.md"), "utf-8"), "my own qa skill\n");
  });
});

test("doctor: a newer CLI notices an older vendored runtime without any network", () => {
  withRepo((dir, repo) => {
    run(BIN, repo, ["install", "--harness", "claude"]);
    const pj = join(repo, ".agent-flow-runtime/package.json");
    writeFileSync(pj, JSON.stringify({ ...JSON.parse(readFileSync(pj, "utf-8")), version: "1.0.0" }));
    const r = run(BIN, repo, ["doctor"]);
    assert.match(r.stdout, /note: this repo's vendored agent-flow is 1\.0\.0; the CLI you ran is \d/);
    assert.match(r.stdout, /update --yes/);
    assert.doesNotMatch(run(BIN, repo, ["doctor", "--json"]).stdout, /vendored agent-flow is/, "not in machine output");
  });
});

test("update notice: says so once when the registry has a newer version, and never in CI or when opted out", () => {
  withRepo((dir, repo) => {
    run(BIN, repo, ["install", "--harness", "claude"]);
    const n = updateNotice(repo, CURRENT_VERSION, { check: true, latest: NEXT_VERSION });
    assert.equal(n.kind, "newer_published");
    assert.ok(n.message.includes(`${NEXT_VERSION} is available`) && n.message.includes("update --yes"), "a vendored repo is told to run update");
    assert.equal(updateNotice(repo, CURRENT_VERSION, { check: true, latest: CURRENT_VERSION }), null);
    assert.equal(updateNotice(repo, CURRENT_VERSION, { check: false, latest: NEXT_VERSION }), null, "checks off: no registry line");
  });
  assert.match(updateNotice("/definitely/not/a/repo", CURRENT_VERSION, { check: true, latest: NEXT_VERSION }).message, /npm i -D @drix10\/agent-flow@latest/, "an npm user is told how to upgrade");
  assert.equal(updateCheckAllowed({ CI: "true" }), false);
  assert.equal(updateCheckAllowed({ NO_UPDATE_NOTIFIER: "1" }), false);
  assert.equal(updateCheckAllowed({ AGENT_FLOW_OFFLINE: "1" }), false);
  assert.equal(updateCheckAllowed({}), true);
});
test("latestVersion asks the registry once, caches for a day, and returns null instead of throwing", async () => {
  const home = mkdtempSync(join(tmpdir(), "af-home-"));
  // The registry runs in its own process: latestVersion blocks while it asks, so a server in this one could never answer.
  const server = spawn(process.execPath, ["-e", `
    const s = require("node:http").createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ "dist-tags": { latest: "7.8.9" } })); });
    s.listen(0, "127.0.0.1", () => console.log(s.address().port));`], { stdio: ["ignore", "pipe", "ignore"] });
  const port = await new Promise((resolve) => server.stdout.once("data", (d) => resolve(String(d).trim())));
  const prev = { reg: process.env.AGENT_FLOW_REGISTRY, home: process.env.AGENT_FLOW_HOME };
  try {
    process.env.AGENT_FLOW_HOME = home;
    process.env.AGENT_FLOW_REGISTRY = `http://127.0.0.1:${port}`;
    assert.equal(latestVersion({ now: 1_000_000 }), "7.8.9", "one real round trip");
    assert.equal(JSON.parse(readFileSync(join(home, "update-check.json"), "utf-8")).latest, "7.8.9", "and it is cached");
    server.kill();
    assert.equal(latestVersion({ now: 1_000_000 + 3600_000 }), "7.8.9", "an hour later: served from the cache, registry not needed");
    assert.equal(latestVersion({ now: 1_000_000 + 25 * 3600_000 }), null, "a day later with the registry gone: null, no throw");
  } finally {
    server.kill();
    if (prev.reg === undefined) delete process.env.AGENT_FLOW_REGISTRY;
    else process.env.AGENT_FLOW_REGISTRY = prev.reg;
    if (prev.home === undefined) delete process.env.AGENT_FLOW_HOME;
    else process.env.AGENT_FLOW_HOME = prev.home;
    rmSync(home, { recursive: true, force: true });
  }
});

test("hashTree ignores line endings, so a Windows checkout of an untouched file is not 'edited'", () => {
  const dir = mkdtempSync(join(tmpdir(), "af-hash-"));
  try {
    writeFileSync(join(dir, "a.md"), "one\ntwo\n");
    writeFileSync(join(dir, "b.md"), "one\r\ntwo\r\n");
    assert.equal(hashTree(join(dir, "a.md")), hashTree(join(dir, "b.md")));
    writeFileSync(join(dir, "c.md"), "one\nTWO\n");
    assert.notEqual(hashTree(join(dir, "a.md")), hashTree(join(dir, "c.md")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update leaves a customized guard hook alone (warns), refreshes a stock one, and --force replaces it", () => {
  withRepo((dir, repo) => {
    run(BIN, repo, ["install", "--harness", "claude"]);
    const file = join(repo, ".claude/settings.json");
    const settings = JSON.parse(readFileSync(file, "utf-8"));
    const hook = settings.hooks.PreToolUse[0].hooks[0];
    const stock = hook.command;
    settings.hooks.PreToolUse[0].matcher = "Bash"; // an older install's narrower matcher
    writeFileSync(file, JSON.stringify(settings));
    const newer = newerPackage(dir, "9.9.9");

    run(newer, repo, ["update", "--yes"]);
    assert.match(JSON.parse(readFileSync(file, "utf-8")).hooks.PreToolUse[0].matcher, /Task\|Agent/, "a stock hook gets the current matcher");

    hook.command = `${stock} --my-flag`;
    settings.hooks.PreToolUse[0].hooks[0] = hook;
    writeFileSync(file, JSON.stringify(settings));
    const kept = run(newer, repo, ["update", "--yes"]);
    assert.match(kept.stdout, /guard hook was customized, so update left it alone/);
    assert.equal(JSON.parse(readFileSync(file, "utf-8")).hooks.PreToolUse[0].hooks[0].command, `${stock} --my-flag`);

    run(newer, repo, ["update", "--yes", "--force"]);
    assert.equal(JSON.parse(readFileSync(file, "utf-8")).hooks.PreToolUse[0].hooks[0].command, stock, "--force restores the stock hook");
  });
});

test("update treats the OpenCode plugin like any installed file: untouched is upgraded, edited is kept", () => {
  withRepo((dir, repo) => {
    assert.equal(run(BIN, repo, ["install", "--harness", "opencode"]).status, 0);
    const plugin = join(repo, ".opencode/plugins/agent-flow-guard.js");
    const newer = newerPackage(dir, "9.9.9");
    const tpl = join(dir, "newer-pkg/templates/opencode/agent-flow-guard.js");
    appendFileSync(tpl, "\n// new in 9.9.9\n");
    run(newer, repo, ["update", "--yes"]);
    assert.match(readFileSync(plugin, "utf-8"), /new in 9\.9\.9/, "an untouched plugin follows the template (same hash format on both sides)");

    appendFileSync(plugin, "\n// ours\n");
    appendFileSync(tpl, "// and more in 9.9.9\n");
    const r = run(newer, repo, ["update", "--yes"]);
    assert.match(r.stdout, /agent-flow-guard\.js was edited since install: kept/);
    assert.match(readFileSync(plugin, "utf-8"), /\/\/ ours/);
  });
});

test("update is a setup action: no pipeline role may run it, any more than install", () => {
  for (const role of ["implementer", "reviewer", "qa", "orchestrator"]) {
    for (const cmd of ["update --yes --force", "update --check"]) {
      const r = spawnSync(process.execPath, [BIN, "guard"], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: `agent-flow ${cmd}` } }), encoding: "utf-8", env: { ...process.env, AGENT_FLOW_ROLE: role } });
      assert.equal(r.status, 2, `${role}: ${cmd}`);
      assert.match(r.stderr, /may not run `agent-flow update`/);
    }
  }
});
