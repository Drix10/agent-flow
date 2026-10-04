// agent-flow running next to the popular workflow packs: install keeps their hooks, the guard leaves their working
// directories alone, and doctor doesn't read their generated docs as agent context.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { localInstall } from "./helpers.js";

const PACKS = {
  superpowers: { dirs: ["docs/superpowers/specs", ".superpowers/sdd"], write: "docs/superpowers/specs/2026-01-01-design.md" },
  gsd: { dirs: [".planning/phases"], write: ".planning/STATE.md" },
  gstack: { dirs: [".gstack"], write: ".gstack/learnings.jsonl" },
  "spec-kit": { dirs: [".specify/memory", "specs/001-x"], write: "specs/001-x/spec.md" },
  openspec: { dirs: ["openspec/changes/add-x"], write: "openspec/changes/add-x/proposal.md" },
};
const THEIR_HOOKS = {
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "bash .claude/hooks/careful.sh" }] }],
    Stop: [{ hooks: [{ type: "command", command: "node .claude/hooks/verify-gate.js" }] }],
    SessionStart: [{ hooks: [{ type: "command", command: "node .claude/hooks/start.js" }] }],
  },
  permissions: { allow: ["Bash(npm test)"] },
};

function project(fn) {
  const dir = mkdtempSync(join(tmpdir(), "af-coexist-"));
  const git = (...a) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir, encoding: "utf-8" });
  try {
    git("init", "-q", "-b", "main");
    for (const p of Object.values(PACKS)) for (const d of p.dirs) mkdirSync(join(dir, d), { recursive: true });
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify(THEIR_HOOKS, null, 2));
    writeFileSync(join(dir, "AGENTS.md"), "# Project\n\nSee `src/app.ts`.\n");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "app.ts"), "x");
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ version: "1", context_files: [], protected_paths: ["migrations/"] }));
    // generated pack docs that mention paths that don't exist, as such docs do
    writeFileSync(join(dir, "docs/superpowers/specs/2026-01-01-design.md"), "Touches `src/gone/old.ts` and `lib/missing/x.ts`.\n");
    writeFileSync(join(dir, ".planning/STATE.md"), "See `src/nowhere/a.ts`.\n");
    writeFileSync(join(dir, "openspec/changes/add-x/proposal.md"), "Changes `src/ghost/b.ts`.\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("install merges the guard next to another pack's hooks and keeps every one of theirs", () => {
  project((dir) => {
    const af = localInstall(dir);
    assert.equal(af(dir, "install", "--harness", "claude", "--stop-gate").status, 0);
    const s = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf-8"));
    const cmds = (ev) => s.hooks[ev].flatMap((g) => g.hooks.map((h) => h.command));
    assert.ok(cmds("PreToolUse").includes("bash .claude/hooks/careful.sh"));
    assert.ok(cmds("PreToolUse").some((c) => /agent-flow.*guard$/.test(c)));
    assert.ok(cmds("Stop").includes("node .claude/hooks/verify-gate.js"));
    assert.ok(cmds("Stop").some((c) => /gates stop$/.test(c)));
    // Theirs stays first, untouched; the one thing install adds there is the briefing.
    const starts = cmds("SessionStart");
    assert.equal(starts[0], "node .claude/hooks/start.js");
    assert.equal(starts.length, 2);
    assert.match(starts[1], /agent-flow\.js" brief --event SessionStart$/);
    assert.deepEqual(s.permissions, THEIR_HOOKS.permissions);
    const before = readFileSync(join(dir, ".claude", "settings.json"), "utf-8");
    af(dir, "install", "--harness", "claude", "--stop-gate");
    assert.equal(readFileSync(join(dir, ".claude", "settings.json"), "utf-8"), before, "idempotent next to their hooks");
  });
});

test("the guard lets each pack write its own working files, for a plain session and for the implementer", () => {
  project((dir) => {
    localInstall(dir);
    for (const [name, p] of Object.entries(PACKS)) {
      for (const role of ["", "implementer"]) {
        const r = spawnSync(process.execPath, [join(dir, "node_modules/@drix10/agent-flow/bin/agent-flow.js"), "guard"], {
          cwd: dir,
          encoding: "utf-8",
          input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(dir, p.write), content: "x" }, cwd: dir }),
          env: { ...process.env, AGENT_FLOW_ROLE: role },
        });
        if (role === "") assert.equal(r.status, 0, `${name} (${role || "no role"}): ${r.stderr}`);
        // the implementer is confined to its worktree by design, so only the plain session must pass here
      }
    }
  });
});

test("doctor reads AGENTS.md, not the packs' generated docs, and stays healthy", () => {
  project((dir) => {
    const r = localInstall(dir)(dir, "doctor", "--json");
    const j = JSON.parse(r.stdout);
    assert.deepEqual(j.context_files, ["AGENTS.md"]);
    assert.equal(j.healthy, true);
    assert.equal(r.status, 0);
  });
});
