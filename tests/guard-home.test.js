// A repository that lives under the home directory (the usual case) must not turn `mv x ~/` into "removes the repo".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decide } from "../extensions/lib/guard.js";

test("moving a file into the home directory is allowed when the repo is under it; deleting home is not", () => {
  const root = mkdtempSync(join(homedir(), ".af-guard-home-"));
  try {
    const run = (command) => decide({ role: null, toolName: "Bash", input: { command }, cwd: root, root, manifest: { protected_paths: ["a/"] } });
    for (const c of ["mv a.txt ~/", "mv a.txt ~", "mv a.txt $HOME/"]) assert.equal(run(c), null, c);
    for (const c of ["rm -rf ~", "mv ~ /tmp/x", "rm -rf .."]) assert.equal(run(c)?.rule, "catastrophic-delete", c);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
