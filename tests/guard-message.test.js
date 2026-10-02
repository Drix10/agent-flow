// The guard blocks a command that edits files and also names a protected path. Its message must tell a model how to
// get unstuck (split the command) instead of only telling it to give up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide } from "../extensions/lib/guard.js";

test("guard: mixing an edit with a protected path is blocked with advice, while merely running that path is allowed", () => {
  const dir = mkdtempSync(join(tmpdir(), "af-guardmsg-"));
  try {
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "freeze-check.sh"), "#!/bin/sh\n");
    writeFileSync(join(dir, "a.txt"), "x\n");
    const manifest = { version: "2", protected_paths: ["scripts/freeze-check.sh"] };
    const run = (command) => decide({ role: "implementer", toolName: "Bash", input: { command }, cwd: dir, root: dir, manifest });

    const mixed = run("sed -i 1d a.txt; bash scripts/freeze-check.sh");
    assert.equal(mixed?.rule, "protected-path");
    assert.match(mixed.reason, /do that in a separate command from the edit/, "it says how to get unstuck");
    assert.match(mixed.reason, /escalate to Needs Me instead/, "and still names the escalation for a real change");
    assert.match(mixed.reason, /scripts\/freeze-check\.sh/);

    assert.equal(run("bash scripts/freeze-check.sh"), null, "running a protected script on its own is fine");
    assert.equal(run("sed -i 1d a.txt"), null, "and so is editing something else");
    assert.equal(run("sed -i 1d scripts/freeze-check.sh")?.rule, "protected-path", "editing the protected file itself is still blocked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
