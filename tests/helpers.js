// Shared test helpers (not a test file: node --test only picks up *.test.js here).
import { spawnSync } from "node:child_process";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const pkgRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Install agent-flow into `dir/node_modules` the way `npm i -D` would, so commands
 * that must point at the project's own copy (the Claude Code hook) behave as for a user.
 * Returns a runner for that copy's CLI.
 */
export function localInstall(dir) {
  const dest = join(dir, "node_modules", "@drix10", "agent-flow");
  for (const p of ["package.json", "bin", "extensions", "schemas", "skills", "templates", ".claude/agents", ".codex/agents", ".gemini/agents"]) {
    cpSync(join(pkgRoot, p), join(dest, p), { recursive: true, filter: (src) => !src.endsWith(".ts") || src.endsWith(".d.ts") });
  }
  const bin = join(dest, "bin", "agent-flow.js");
  return (cwd, ...args) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" } });
}
