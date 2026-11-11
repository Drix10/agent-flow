// Grants and pauses: the one place a human widens what the guard allows. Store, guard integration, the CLI, and the refusal to let an agent touch any of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "../extensions/lib/guard.js";
import * as G from "../extensions/lib/grants.js";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
const now = new Date("2026-11-11T12:00:00Z");
const hours = (n) => new Date(now.getTime() + n * 3_600_000);

function sandbox(fn) {
  const home = mkdtempSync(join(tmpdir(), "af-home-"));
  const repo = mkdtempSync(join(tmpdir(), "af-grepo-"));
  try {
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    writeFileSync(join(repo, ".env"), "K=1\n");
    return fn({ home, repo, env: { ...process.env, AGENT_FLOW_HOME: home, AGENT_FLOW_ROLE: "", NO_COLOR: "1" } });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
}
const cli = (ctx, ...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: ctx.repo, encoding: "utf-8", env: ctx.env });
const hook = (ctx, command) => spawnSync(process.execPath, [BIN, "guard"], { cwd: ctx.repo, encoding: "utf-8", env: ctx.env, input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: ctx.repo }) });

test("store: a grant applies to its repo until it expires; an unreadable store grants nothing", () => {
  sandbox(({ home, repo, env }) => {
    const store = G.readStore(env);
    G.addGrant(store, { kind: "push-default", repo: G.repoKey(repo), until: hours(1) }, now);
    G.addGrant(store, { kind: "push-default", repo: "/somewhere/else", until: null }, now);
    G.addPause(store, { scope: "secret-read", repo: G.repoKey(repo), until: hours(2) }, now);
    G.writeStore(store, env);
    const a = G.activeFor(repo, now, G.readStore(env));
    assert.ok(a.pushDefault && a.pausedRules.has("secret-read") && !a.pauseAll);
    assert.equal(G.activeFor(repo, hours(1.5), G.readStore(env)).pushDefault, null, "expired");
    assert.equal(G.activeFor("/not/this/repo", now, G.readStore(env)).pushDefault, null, "another repo's grant is not ours");
    writeFileSync(G.storeFile(env), "{ not json");
    assert.equal(G.activeFor(repo, now, G.readStore(env)).pushDefault, null, "corrupt store: no grant");
  });
});

test("untilFrom: absolute times, defaults, and refusal of past or unreadable ones", () => {
  assert.equal(G.untilFrom({ until: "2026-12-01T00:00:00Z" }, 8, now).toISOString(), "2026-12-01T00:00:00.000Z");
  assert.equal(G.untilFrom({ hours: "2" }, 8, now).toISOString(), hours(2).toISOString());
  assert.equal(G.untilFrom({ days: "1" }, 8, now).toISOString(), hours(24).toISOString());
  assert.equal(G.untilFrom({}, 8, now).toISOString(), hours(8).toISOString());
  assert.throws(() => G.untilFrom({ until: "yesterday" }, 8, now), /not a date/);
  assert.throws(() => G.untilFrom({ until: "2026-01-01T00:00:00Z" }, 8, now), /past/);
  assert.throws(() => G.untilFrom({ hours: "-1" }, 8, now), /positive/);
});

const granted = { pushDefault: { id: "g1", kind: "push-default", repo: "*", until: null, created: "x" }, pauseAll: null, pausedRules: new Map() };
const run = (command, extra = {}) => decide({ role: null, toolName: "Bash", input: { command }, cwd: "/repo", root: "/repo", manifest: { default_branch: "main" }, ...extra })?.rule ?? null;

test("guard: a grant lets a role-less session land on the default branch, and nothing broader", () => {
  assert.equal(run("git push origin main"), "push-default-branch");
  assert.equal(run("git push origin main", { grants: granted }), null);
  assert.equal(run("git push origin 'HEAD~0:main'", { grants: granted }), null, "quoted spelling of the same landing");
  for (const c of ["git push --force origin main", "git push origin +main", "git push origin :main", "git push --delete origin main", "git push --all origin", "git push origin :"]) {
    assert.notEqual(run(c, { grants: granted }), null, `${c} stays blocked under a grant`);
  }
  assert.equal(run("git push origin main && git push --force origin agent/x", { grants: granted }), "force-push", "a landing push does not hide a later force-push in the same call");
  assert.equal(run("git push origin main", { grants: granted, role: "implementer" }), "push-default-branch", "pipeline roles never get a grant");
});

test("guard: a pause lifts one rule or all of them for a role-less session only", () => {
  const pause = { id: "p", scope: "x", repo: "*", until: "2099-01-01T00:00:00Z", created: "x" };
  const rule = { pushDefault: null, pauseAll: null, pausedRules: new Map([["push-default-branch", pause]]) };
  const all = { pushDefault: null, pauseAll: pause, pausedRules: new Map() };
  assert.equal(run("git push origin main", { grants: rule }), null);
  assert.equal(run("git push --force origin x", { grants: rule }), "force-push", "only the named rule");
  assert.equal(run("git push --force origin x", { grants: all }), null, "pause --all");
  assert.equal(run("git push --force origin x", { grants: all, role: "implementer" }), "force-push", "roles are never relaxed");
});

test("guard: an agent cannot grant, pause, revoke or write the store", () => {
  for (const c of ["agent-flow grant push-default --standing", "npx @drix10/agent-flow grant push-default", "node node_modules/@drix10/agent-flow/bin/agent-flow.js pause --all --hours 1", "agent-flow revoke --all", "FOO=1 agent-flow --json grant push-default"]) {
    assert.equal(run(c), "grant-store", c);
  }
  assert.equal(run("agent-flow grants"), null, "listing is harmless");
  assert.equal(run("agent-flow status"), null);
  sandbox(({ home, env }) => {
    const old = process.env.AGENT_FLOW_HOME;
    process.env.AGENT_FLOW_HOME = home;
    try {
      assert.equal(decide({ role: null, toolName: "Write", input: { file_path: join(home, "grants.json"), content: "{}" }, cwd: "/repo", root: "/repo", manifest: null })?.rule, "grant-store");
      assert.equal(run(`echo '{}' > ${home.replace(/\\/g, "/")}/grants.json`), "grant-store");
      assert.equal(run("echo x > /tmp/notes.txt"), null);
    } finally {
      if (old === undefined) delete process.env.AGENT_FLOW_HOME;
      else process.env.AGENT_FLOW_HOME = old;
    }
  });
});

test("CLI: grant, list, the hook honouring it, revoke; and an expired grant lets nothing through", () => {
  sandbox((ctx) => {
    const denied = hook(ctx, "git push origin main");
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /agent-flow grant push-default/, "the deny names the human path");
    const g = cli(ctx, "grant", "push-default", "--days", "1", "--reason", "solo project");
    assert.equal(g.status, 0, g.stderr);
    assert.equal(hook(ctx, "git push origin main").status, 0, "granted");
    assert.equal(hook(ctx, "git push --force origin main").status, 2, "still no force");
    const list = JSON.parse(cli(ctx, "grants", "--json").stdout);
    assert.equal(list.grants.length, 1);
    assert.equal(list.grants[0].reason, "solo project");
    assert.equal(cli(ctx, "revoke", "--all").status, 0);
    assert.equal(hook(ctx, "git push origin main").status, 2, "revoked");
    assert.equal(cli(ctx, "grant", "push-default", "--until", "2020-01-01T00:00:00Z").status, 1, "a past time is refused");
    assert.equal(cli(ctx, "grant", "force-everything").status, 2, "unknown grant kind");
  });
});

test("CLI: pause --all is the kill switch and expires", () => {
  sandbox((ctx) => {
    assert.equal(hook(ctx, "cat .env").status, 2);
    assert.equal(cli(ctx, "pause", "--all", "--hours", "1").status, 0);
    assert.equal(hook(ctx, "cat .env").status, 0, "paused");
    const store = G.readStore(ctx.env);
    store.pauses[0].until = "2020-01-01T00:00:00.000Z";
    G.writeStore(store, ctx.env);
    assert.equal(hook(ctx, "cat .env").status, 2, "expired pause lets nothing through");
    assert.equal(cli(ctx, "pause").status, 2, "needs --all or --rule");
    assert.equal(cli(ctx, "pause", "--rule", "secret-read", "--hours", "1").status, 0);
    assert.equal(hook(ctx, "cat .env").status, 0, "rule pause");
    assert.equal(hook(ctx, "git push --force origin x").status, 2, "other rules still apply");
  });
});
