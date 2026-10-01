// doctor checks the commands, links and commits an AGENTS.md cites, and stays quiet about what it can't resolve.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkClaims, makeTargets, justRecipes } from "../extensions/lib/claims.js";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
const git = (d, ...a) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: d, encoding: "utf-8" });

function repo(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "af-claims-"));
  try {
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), c);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const pkg = JSON.stringify({ scripts: { "test:ci": "x", build: "y", lint: "z" } });
const kinds = (dir, md) => checkClaims(dir, "AGENTS.md", md).map((i) => `${i.kind}:${i.text}`);

test("npm/pnpm scripts: a missing one is flagged with a suggestion, an existing one isn't", () => {
  repo({ "package.json": pkg }, (dir) => {
    const r = checkClaims(dir, "AGENTS.md", "Run `npm run test:unit` and `pnpm run build`.\n```sh\nnpm test\nnpm run lint\n```\n");
    assert.deepEqual(r.map((i) => i.text), ["npm run test:unit", "npm test"]);
    assert.equal(r[0].suggestion, "test:ci");
    assert.equal(r[0].line, 1);
    assert.equal(r[1].line, 3);
  });
});

test("commands it can't resolve are skipped: workspaces, cd, variables, yarn binaries, no package.json", () => {
  repo({ "package.json": pkg }, (dir) => {
    const md = "`npm run nope -w web`\n`pnpm --filter web run nope`\n```sh\ncd web && npm run nope\nnpm run $TARGET\nyarn run tsc\n```\n";
    assert.deepEqual(kinds(dir, md), []);
  });
  repo({}, (dir) => assert.deepEqual(kinds(dir, "`npm run anything`"), []));
  repo({ "package.json": pkg }, (dir) => assert.deepEqual(checkClaims(dir, "tests/fixtures/x/AGENTS.md", "`npm run nope`"), []));
});

test("make targets and just recipes", () => {
  repo({ Makefile: ".PHONY: build test\nbuild:\n\techo\ntest: build\n\techo\n", justfile: "default:\n  just --list\nbuild:\n  echo\n" }, (dir) => {
    assert.deepEqual(kinds(dir, "`make build`\n`make tset`\n`just build`\n`just biuld`\n`just --list`"), ["command:make tset", "command:just biuld"]);
  });
  assert.equal(makeTargets("%.o: %.c\n\tcc\n"), null);
  assert.equal(makeTargets("include x.mk\n"), null);
  assert.equal(justRecipes("import 'a.just'\n"), null);
});

test("relative links resolve from the file's directory, case-exact; urls, anchors and code are skipped", () => {
  repo({ "docs/a.md": "x", "sub/AGENTS.md": "x" }, (dir) => {
    const md = "[ok](docs/a.md#top) [bad](docs/missing.md) [case](docs/A.md) [web](https://x.io/y) [anchor](#z) `[c](nope.md)`\n";
    assert.deepEqual(kinds(dir, md), ["link:docs/missing.md", "link:docs/A.md"]);
    assert.deepEqual(checkClaims(dir, "sub/AGENTS.md", "[up](../docs/a.md) [bad](a.md)").map((i) => i.text), ["a.md"]);
  });
});

test("cited commits: a fabricated SHA is flagged, a real one and a bare hash aren't; shallow clones are skipped", () => {
  repo({ "AGENTS.md": "x" }, (dir) => {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "one");
    const real = git(dir, "rev-parse", "HEAD").stdout.trim();
    assert.deepEqual(kinds(dir, `fixed in commit ${real.slice(0, 9)}, see commit 1234abc0 and hash 9f8e7d6c5b`), ["commit:1234abc0"]);
  });
  repo({ "AGENTS.md": "x" }, (dir) => assert.deepEqual(kinds(dir, "commit 1234abc0"), [])); // not a git repo: can't tell
});

test("doctor fails on a dead command and prints the did-you-mean", () => {
  repo({ "package.json": pkg, "AGENTS.md": "# A\n\n```sh\nnpm run test:unit\n```\n" }, (dir) => {
    const r = spawnSync(process.execPath, [BIN, "doctor"], { cwd: dir, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" } });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /AGENTS\.md:4\s+npm run test:unit — no such script in package\.json/);
    assert.match(r.stdout, /did you mean test:ci/);
  });
});

test("no false alarms: just default params, make -j 4, npm run env, prose that only looks like a link", () => {
  repo({ Makefile: "test:\n\techo\n", justfile: 'deploy env="prod":\n  echo\n', "package.json": pkg }, (dir) => {
    assert.deepEqual(kinds(dir, "`just deploy`\n`make -j 4 test`\n`npm run env`\nsee arr[0](y) and [1](2)\n"), []);
  });
});
