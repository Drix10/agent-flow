import { resolve } from "node:path";
import { findRepoRoot } from "./lib/fsutil.js";

/** Wrap a value as a text tool result. */
export function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
}

/**
 * Where a tool should operate. Explicit `repoPath` wins (resolved against the
 * session cwd); otherwise the MAIN repository root — even when Pi was started
 * inside `.worktrees/issue-N` — so every agent shares one manifest and state.
 */
export function repoRoot(ctx: { cwd?: string } | undefined, repoPath?: string): string {
  const cwd = ctx?.cwd ?? process.cwd();
  return repoPath ? resolve(cwd, repoPath) : findRepoRoot(cwd);
}
