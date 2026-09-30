import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
const hasBwrap = spawnSync("bwrap", ["--ro-bind", "/", "/", "true"]).status === 0;
const run = (cwd, ...a) => spawnSync("node", [bin, "sandbox", ...a], { cwd, encoding: "utf8" });

test("sandbox: usage errors need no bwrap", () => {
  const d = mkdtempSync(join(tmpdir(), "af-sb-"));
  const r = run(d);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage|bubblewrap/);
  if (hasBwrap) assert.match(run(d, "--bogus", "--", "true").stderr, /unknown option/);
});

test("sandbox: writes inside the worktree work, outside fail, --ro blocks both", { skip: !hasBwrap }, () => {
  const d = realpathSync(mkdtempSync(join(process.cwd(), ".sbtest-")));
  try {
    assert.equal(run(d, "--", "sh", "-c", "echo hi > in.txt").status, 0);
    assert.ok(existsSync(join(d, "in.txt")));
    assert.notEqual(run(d, "--", "sh", "-c", "echo x > /etc/af-sandbox-probe").status, 0);
    assert.ok(!existsSync("/etc/af-sandbox-probe"));
    assert.notEqual(run(d, "--ro", "--", "sh", "-c", "echo hi > ro.txt").status, 0);
    assert.ok(!existsSync(join(d, "ro.txt")));
    assert.notEqual(run(d, "--no-net", "--", "sh", "-c", "exec 3<>/dev/tcp/1.1.1.1/80").status, 0);
    assert.equal(run(d, "--", "sh", "-c", "exit 7").status, 7);
  } finally {
    spawnSync("rm", ["-rf", d]);
  }
});
