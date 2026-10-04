/**
 * The debt ledger: every deliberate shortcut an agent (or a person) left behind, collected from the code.
 *
 * A shortcut that cuts a real corner (a global lock, an O(n²) scan, a naive heuristic) is marked where it lives with a
 * comment `lean: <the ceiling>; <when to upgrade>`. This reads them back, so a deferral can't quietly become permanent:
 * one row per marker, and a `no_trigger` flag on the ones that name no condition for revisiting them, which are the
 * ones that rot. Deterministic, read-only, offline. `ponytail:` (the convention this one comes from) is read too.
 */

import { join } from "node:path";
import { readTextFile } from "./fsutil.js";
import { listRepoFiles } from "./repofiles.js";

export interface DebtRow {
  file: string;
  line: number;
  marker: "lean" | "ponytail";
  /** The comment text after the marker, trimmed. */
  text: string;
  ceiling: string;
  /** The condition for revisiting it, or null when the comment names none. */
  upgrade: string | null;
  /** True when nothing in the comment says when to revisit the shortcut. */
  no_trigger: boolean;
}

export interface DebtReport {
  rows: DebtRow[];
  scanned: number;
  truncated: boolean;
}

/** Documentation shows the convention in examples; only code carries real markers. */
const DOC_FILE = /\.(md|mdx|markdown|rst|txt|adoc)$/i;
/** A comment opener (`#`, `//`, `/*`, `--`, `<!--`) right before the marker, so prose that merely mentions it doesn't count. */
const MARKER = /(?:^|[^\w`'"])(?:#|\/\/|\/\*|--|<!--)[ \t]?(lean|ponytail):[ \t]*(\S.*)$/;
/** Words that name a condition for coming back to it. */
const TRIGGER_WORDS = /\b(when|if|until|once|upgrade|replace|switch|move to|add|needs?|before|after|beyond|exceeds?|grows?)\b/i;
const MAX_ROWS = 2_000;

/**
 * Is the end of `prefix` inside a quoted string? `print("# lean: x")` and a test fixture `"x // lean: y"` carry the marker
 * as text, not as a comment. Line-local on purpose (a string that spans lines is rare, and a miss only adds a row).
 */
export function insideString(prefix: string): boolean {
  let quote = "";
  for (let i = 0; i < prefix.length; i++) {
    const c = prefix[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
  }
  return quote !== "";
}

function clean(text: string): string {
  return text.replace(/\s*(\*\/|-->)\s*$/, "").trim();
}

/** `<ceiling>; <upgrade>` (this repo's form) or `<ceiling>, <upgrade>` (ponytail's). */
export function parseShortcut(text: string): { ceiling: string; upgrade: string | null; no_trigger: boolean } {
  const t = clean(text);
  const semi = t.indexOf(";");
  const comma = semi < 0 ? t.indexOf(",") : -1;
  const cut = semi >= 0 ? semi : comma;
  const ceiling = (cut >= 0 ? t.slice(0, cut) : t).trim();
  const upgrade = cut >= 0 ? t.slice(cut + 1).trim() || null : null;
  const named = upgrade !== null || TRIGGER_WORDS.test(t);
  return { ceiling, upgrade, no_trigger: !named };
}

export function scanDebt(root: string, opts: { maxFiles?: number; budgetMs?: number } = {}): DebtReport {
  const deadline = opts.budgetMs ? Date.now() + opts.budgetMs : Infinity;
  const { files, truncated } = listRepoFiles(root, { maxFiles: opts.maxFiles ?? 50_000 });
  const rows: DebtRow[] = [];
  let scanned = 0;
  for (const file of files) {
    if (Date.now() > deadline) return { rows, scanned, truncated: true };
    if (DOC_FILE.test(file) || rows.length >= MAX_ROWS) continue;
    const content = readTextFile(join(root, file));
    if (content === null) continue;
    scanned++;
    if (!/lean:|ponytail:/.test(content)) continue;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length && rows.length < MAX_ROWS; i++) {
      // A minified bundle is one enormous line: nothing in it is a note to a person.
      if (lines[i].length > 2_000) continue;
      const m = MARKER.exec(lines[i]);
      if (!m || insideString(lines[i].slice(0, m.index))) continue;
      const text = clean(m[2]);
      rows.push({ file, line: i + 1, marker: m[1] as "lean" | "ponytail", text, ...parseShortcut(text) });
    }
  }
  return { rows, scanned, truncated };
}
