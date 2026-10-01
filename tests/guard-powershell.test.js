// Codex on Windows runs PowerShell: `Set-Content -LiteralPath …` and Windows paths must be judged like their POSIX twins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide } from "../extensions/lib/guard.js";

const root = mkdtempSync(join(tmpdir(), "af-ps-"));
const run = (command) => decide({ role: null, toolName: "Bash", input: { command }, cwd: root, root, manifest: { protected_paths: ["secrets/**"] } });

test("PowerShell writes to protected paths and hook wiring are blocked, whatever the parameter order or slash", () => {
  for (const c of [
    "Set-Content -LiteralPath '.codex/hooks.json' -Value '{hooks:{}}' -NoNewline",
    "Set-Content -Value x -LiteralPath secrets\\k.txt",
    "sc -Value x secrets\\k.txt",
    "Set-Content -Path .\\.codex\\hooks.json -Value x",
    "Remove-Item .claude\\settings.json",
    "Move-Item -Path allowed.txt -Destination secrets\\z.txt",
    "Copy-Item allowed.txt -Destination secrets\\k.txt",
    "Rename-Item -Path secrets\\k.txt -NewName y.txt",
    "Out-File -FilePath secrets/k.txt -InputObject x",
    "[IO.File]::WriteAllText('secrets/k.txt','x')",
  ]) assert.equal(run(c)?.block, true, c);
});

test("PowerShell writes to ordinary paths, reads and copies out of a protected path stay allowed", () => {
  for (const c of ["Set-Content -LiteralPath allowed.txt -Value ok", "Set-Content -Path sub\\ok.txt -Value 1", "Get-Content secrets\\k.txt"]) assert.equal(run(c), null, c);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
