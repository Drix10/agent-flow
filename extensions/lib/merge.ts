/**
 * Helpers for rewriting a file that already has someone's content in it.
 *
 * A context file the user has edited (AGENTS.md, CONTEXT_MANIFEST.json, .claude/settings.json)
 * is theirs. Whatever writes over it must keep its line endings, its indentation and
 * anything it doesn't know about, and must say what it is about to remove.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { protectedPathsOf } from "./manifest.js";

export type Eol = "\n" | "\r\n";

/** The dominant line ending of `text` (LF when there are no line breaks at all). */
export function detectEol(text: string): Eol {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

/** `text` with every line ending replaced by `eol`. */
export function withEol(text: string, eol: Eol): string {
  return text.replace(/\r\n|\r(?!\n)|\n/g, eol);
}

/**
 * New content for an existing file: same BOM and line endings as before, and a final newline
 * if the old file had one. Without this, a rewrite turns a CRLF file into a mixed one and every
 * line shows up in `git diff`.
 */
export function matchExistingFormat(previous: string, next: string): string {
  const bom = previous.startsWith("\uFEFF");
  let out = withEol(next.replace(/^\uFEFF/, ""), detectEol(previous));
  const eol = detectEol(previous);
  if (/\r?\n$/.test(previous) && !out.endsWith(eol)) out += eol;
  return (bom ? "\uFEFF" : "") + out;
}

/** The indent of a JSON document as JSON.stringify wants it: a tab, or the width of the first indented line. */
export function detectJsonIndent(text: string): string | number {
  const m = text.match(/^\uFEFF?[{[][^\S\n]*\r?\n([ \t]+)\S/);
  if (!m) return 2;
  return m[1].includes("\t") ? "\t" : m[1].length;
}

export interface LineDiff {
  removed: string[];
  added: number;
  kept: number;
}

/** Non-blank lines of `before` that `after` no longer has (as a multiset), plus how many it adds. */
export function lineDiff(before: string, after: string): LineDiff {
  const lines = (s: string) => s.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  const left = new Map<string, number>();
  for (const l of lines(after)) left.set(l, (left.get(l) ?? 0) + 1);
  const removed: string[] = [];
  let kept = 0;
  for (const l of lines(before)) {
    const n = left.get(l) ?? 0;
    if (n > 0) {
      left.set(l, n - 1);
      kept++;
    } else removed.push(l);
  }
  let added = 0;
  for (const n of left.values()) added += n;
  return { removed, added, kept };
}

/**
 * What replacing manifest `before` with `after` would lose. Protection and user-added data must
 * never vanish because a model rewrote the file from a scan: a dropped `protected_paths` entry
 * silently switches protection off, a dropped custom key is someone's configuration.
 */
export function manifestLosses(before: unknown, after: unknown): string[] {
  if (!before || typeof before !== "object" || Array.isArray(before) || !after || typeof after !== "object" || Array.isArray(after)) return [];
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const losses: string[] = [];
  const kept = new Set(protectedPathsOf(a));
  for (const p of protectedPathsOf(b)) if (!kept.has(p)) losses.push(`protected_paths entry "${p}"`);
  const boundaries = (m: Record<string, unknown>) =>
    new Set((Array.isArray(m.risk_boundaries) ? m.risk_boundaries : []).map((x) => (x && typeof x === "object" ? String((x as { path?: unknown }).path) : "")));
  const after_b = boundaries(a);
  for (const p of boundaries(b)) if (p && !after_b.has(p)) losses.push(`risk_boundaries entry "${p}"`);
  // protected_paths / risk_boundaries are itemised above; an emptied list has nothing left to lose.
  for (const k of Object.keys(b)) if (!(k in a) && k !== "protected_paths" && k !== "risk_boundaries") losses.push(`top-level key "${k}"`);
  const pipeline = (m: Record<string, unknown>) => (m.pipeline && typeof m.pipeline === "object" ? (m.pipeline as Record<string, unknown>) : {});
  for (const k of Object.keys(pipeline(b))) if (!(k in pipeline(a))) losses.push(`pipeline.${k}`);
  return losses;
}

/** Copy `abs` to `<root>/.agent-flow/backups/<rel>.<stamp>` before it is replaced. Returns the repo-relative backup path. */
export function backupFile(root: string, abs: string, rel: string, stamp: string): string | null {
  if (!existsSync(abs)) return null;
  const safe = stamp.replace(/[:.]/g, "-");
  const relBackup = join(".agent-flow", "backups", `${rel}.${safe}`);
  const dest = join(root, relBackup);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(abs, dest);
  return relBackup.split("\\").join("/");
}
