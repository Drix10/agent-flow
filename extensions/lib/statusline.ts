/**
 * The status badge for Claude Code's `statusLine`: whether the guard is wired and what is waiting on a person, in one
 * short line that is there on every screen. A person who comes back to an unattended run sees "2 need you" without
 * typing anything.
 *
 * It runs on every prompt refresh, so it is built to be quick and silent: plain file reads (no git, no scans), and any
 * problem prints nothing rather than an error in the user's status bar.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readState } from "./state.js";
import { MANIFEST_FILE } from "./manifest.js";

/** Is Claude Code's guard hook wired in this checkout, and does the file it runs exist? */
export function claudeGuardWired(root: string): boolean {
  try {
    const settings = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf-8").replace(/^\uFEFF/, ""));
    const groups: { hooks?: { command?: string }[] }[] = settings.hooks?.PreToolUse ?? [];
    const command = groups.flatMap((g) => g.hooks ?? []).map((h) => h.command ?? "").find((c) => /agent-flow/.test(c) && /\bguard\b/.test(c));
    if (!command) return false;
    const script = command.match(/"\$CLAUDE_PROJECT_DIR\/([^"]+)"/)?.[1];
    return !script || existsSync(join(root, script));
  } catch {
    return false;
  }
}

export interface StatuslineOptions {
  color?: boolean;
}

/** The badge for the repo at `root`; "" when agent-flow isn't set up there (nothing to show). */
export function buildStatusline(root: string, opts: StatuslineOptions = {}): string {
  if (!existsSync(join(root, MANIFEST_FILE))) return "";
  const paint = (code: number, s: string) => (opts.color ? `\x1b[38;5;${code}m${s}\x1b[0m` : s);
  const parts = [paint(108, "agent-flow")];
  parts.push(claudeGuardWired(root) ? "guard on" : paint(167, "guard OFF"));
  try {
    const sessions = readState(root).sessions ?? [];
    const needs = sessions.filter((s) => s.state === "Needs Me").length;
    const working = sessions.filter((s) => s.state === "Working" && s.phase !== "publish").length;
    const ready = sessions.filter((s) => s.state === "Working" && s.phase === "publish").length;
    if (needs) parts.push(paint(173, `${needs} ${needs === 1 ? "needs" : "need"} you`));
    if (ready) parts.push(`${ready} ready`);
    if (working) parts.push(`${working} working`);
  } catch {
    /* state that can't be read is the status screen's problem, not the status bar's */
  }
  return parts.join(" · ");
}
