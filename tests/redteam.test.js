// Red-team corpus: every entry in tests/redteam/corpus.json is a command or tool call an agent might make,
// with what the guard must do about it. It is the evidence behind the security claims in SECURITY.md:
// `block` and `allow` entries are enforced here; `gap` entries are the documented limits of reading command
// text, asserted to still be allowed so a fixed gap (or a regression) is noticed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide } from "../extensions/lib/guard.js";

const corpus = JSON.parse(readFileSync(new URL("./redteam/corpus.json", import.meta.url), "utf-8"));

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "af-redteam-"));
  for (const d of ["research/ledger", "research/prereg", "src", "secrets", "migrations", "node_modules/@drix10/agent-flow/bin", ".git/hooks", ".claude"]) mkdirSync(join(dir, d), { recursive: true });
  for (const f of ["research/ledger/a.jsonl", "research/prereg/p.md", "src/a.ts", "secrets/db.txt", ".env", ".env.local", ".env.example", ".git/hooks/pre-commit", "CONTEXT_MANIFEST.json", ".claude/settings.json"]) writeFileSync(join(dir, f), "x\n");
  return dir;
}

const entries = [
  ...corpus.shell.map((e) => ({ ...e, role: null, toolName: "Bash", input: { command: e.cmd }, label: e.cmd })),
  ...corpus.tools.map((e) => ({ ...e, role: null, toolName: e.tool, label: `${e.tool} ${JSON.stringify(e.input)}` })),
  ...corpus.roles.map((e) => ({ ...e, toolName: e.cmd ? "Bash" : e.tool, input: e.cmd ? { command: e.cmd } : e.input, label: `[${e.role}] ${e.cmd ?? e.tool}` })),
];

test(`red-team corpus: ${entries.length} cases against the guard`, (t) => {
  const dir = scratch();
  try {
    const stats = { block: 0, allow: 0, gap: 0 };
    const wrong = [];
    for (const e of entries) {
      const d = decide({ role: e.role, toolName: e.toolName, input: e.input, cwd: dir, root: dir, manifest: corpus.manifest });
      const blocked = !!d;
      stats[e.expect]++;
      if (e.expect === "block" && !blocked) wrong.push(`MISSED   ${e.label}`);
      if (e.expect === "allow" && blocked) wrong.push(`FALSE+   ${e.label} (${d.rule})`);
      if (e.expect === "gap" && blocked) wrong.push(`NOW BLOCKED, move to "block": ${e.label} (${d.rule})`);
    }
    t.diagnostic(`blocked-as-expected ${stats.block}, allowed-as-expected ${stats.allow}, documented gaps ${stats.gap}`);
    assert.deepEqual(wrong, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
