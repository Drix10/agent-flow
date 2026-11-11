// A recursive search that cannot be checked in time must not become an allow: it falls back to git's file list, then to a block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide } from "../extensions/lib/guard.js";

const run = (dir, command, extra = {}) => decide({ role: null, toolName: "Bash", input: { command }, cwd: dir, root: dir, manifest: { default_branch: "main" }, ...extra });
function tree(fn, { git = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "af-sweep-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "x\n");
    writeFileSync(join(dir, ".env"), "K=1\n");
    if (git) spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an exhausted walk fails closed outside a git repo", () => {
  tree((dir) => {
    assert.equal(run(dir, "grep -r KEY .", { sweepMs: 0 })?.rule, "secret-read");
    assert.equal(run(dir, "grep -r KEY .")?.rule, "secret-read", "and the normal walk finds .env");
  });
});

test("an exhausted walk inside a git repo uses git's file list and blocks only when an env file is listed", () => {
  tree((dir) => {
    assert.equal(run(dir, "grep -r KEY .", { sweepMs: 0 })?.rule, "secret-read", ".env is untracked and ignored by nothing: still listed");
    rmSync(join(dir, ".env"));
    assert.equal(run(dir, "grep -r KEY .", { sweepMs: 0 }), null, "no env file in the list: allowed");
  }, { git: true });
});

test("a search from the filesystem root or the home directory is refused without walking", () => {
  tree((dir) => {
    assert.equal(run(dir, "grep -r KEY /")?.rule, "secret-read");
    assert.equal(run(dir, "grep -r KEY ~")?.rule, "secret-read");
  });
});
