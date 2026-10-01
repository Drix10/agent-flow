/**
 * Reading `.agent-flow/audit.jsonl` back: is it intact, and what does it say.
 *
 * The log is a hash chain (see `appendAudit`): every line carries the hash of the line before it. That makes an
 * edit, a deletion or a reorder visible to anyone who re-runs `verify`. It is tamper-EVIDENT, not tamper-PROOF:
 * someone who can write the file can recompute every hash after their edit. Record `audit head` somewhere they can't
 * (a commit, a CI artifact, a ticket); `verify --anchor <hash>` then proves the history up to that point is unchanged.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_GENESIS, AUDIT_LOG, auditHash } from "./state.js";

export interface AuditVerification {
  ok: boolean;
  lines: number;
  /** Lines that carry a valid link in the chain. */
  chained: number;
  /** Lines written before chaining existed (they precede the first chained line). */
  legacy: number;
  /** Lines written while the lock was unavailable (or after the chain started without a hash). */
  unchained: number;
  /** The hash of the last chained line: record it to anchor the log. */
  head: string | null;
  /** First place the chain is broken, if any. */
  broken?: { line: number; reason: string };
  /** Set when `anchor` was given: was that hash found in an intact chain? */
  anchor?: { hash: string; found: boolean; line?: number };
}

export function verifyAudit(root: string, opts: { anchor?: string } = {}): AuditVerification {
  const path = join(root, AUDIT_LOG);
  const out: AuditVerification = { ok: true, lines: 0, chained: 0, legacy: 0, unchained: 0, head: null };
  if (!existsSync(path)) return out;
  if (opts.anchor) out.anchor = { hash: opts.anchor, found: false };
  let prev = AUDIT_GENESIS;
  let started = false;
  const rows = readFileSync(path, "utf-8").split("\n");
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].trim() === "") continue;
    out.lines++;
    const line = i + 1;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(rows[i]);
    } catch {
      if (!out.broken) out.broken = { line, reason: "not valid JSON" };
      continue;
    }
    if (typeof entry.hash !== "string") {
      if (started || entry.unchained) out.unchained++;
      else out.legacy++;
      continue;
    }
    const { hash, ...body } = entry;
    started = true;
    if (body.prev !== prev) {
      if (!out.broken) out.broken = { line, reason: "does not follow the line before it (a line was removed, inserted or reordered)" };
    } else if (auditHash(prev, body) !== hash) {
      if (!out.broken) out.broken = { line, reason: "its content no longer matches its hash (the line was edited)" };
    }
    prev = hash;
    out.chained++;
    out.head = hash;
    if (out.anchor && hash === out.anchor.hash && !out.broken) out.anchor = { hash, found: true, line };
  }
  out.ok = !out.broken && (!out.anchor || out.anchor.found);
  return out;
}

export interface AuditSummary {
  entries: number;
  from: string | null;
  to: string | null;
  events: Record<string, number>;
  guard_blocks: { total: number; by_role: Record<string, number>; by_rule: Record<string, number> };
  escalations: { issue: number; at: string; reason: string }[];
  issues: { issue: number; state: string; round: number }[];
  role_runs: { total: number; ok: number; failed: number; cost_usd: number; cost_unreported: number; by_role: Record<string, { runs: number; failed: number; cost_usd: number }> };
}

const bump = (m: Record<string, number>, k: string, n = 1) => {
  m[k] = (m[k] ?? 0) + n;
};

/** What the log says, for a human or the Gardener deciding which `protected_paths` or lint rule to add. */
export function summarizeAudit(root: string): AuditSummary {
  const path = join(root, AUDIT_LOG);
  const s: AuditSummary = {
    entries: 0,
    from: null,
    to: null,
    events: {},
    guard_blocks: { total: 0, by_role: {}, by_rule: {} },
    escalations: [],
    issues: [],
    role_runs: { total: 0, ok: 0, failed: 0, cost_usd: 0, cost_unreported: 0, by_role: {} },
  };
  if (!existsSync(path)) return s;
  const latest = new Map<number, { state: string; round: number }>();
  for (const raw of readFileSync(path, "utf-8").split("\n")) {
    if (raw.trim() === "") continue;
    let e: Record<string, any>;
    try {
      e = JSON.parse(raw);
    } catch {
      continue;
    }
    s.entries++;
    if (typeof e.at === "string") {
      s.from ??= e.at;
      s.to = e.at;
    }
    bump(s.events, String(e.event ?? "unknown"));
    if (e.event === "guard_block") {
      s.guard_blocks.total++;
      bump(s.guard_blocks.by_role, String(e.role ?? "none"));
      bump(s.guard_blocks.by_rule, String(e.rule ?? "unknown"));
    } else if (e.event === "state_transition" && Number.isInteger(e.issue)) {
      latest.set(e.issue, { state: String(e.to), round: Number(e.round) || 0 });
      if (e.to === "Needs Me") s.escalations.push({ issue: e.issue, at: String(e.at ?? ""), reason: String(e.reason ?? "") });
    } else if (e.event === "role_run") {
      const role = String(e.role ?? "unknown");
      const r = (s.role_runs.by_role[role] ??= { runs: 0, failed: 0, cost_usd: 0 });
      s.role_runs.total++;
      r.runs++;
      if (e.ok === true) s.role_runs.ok++;
      else {
        s.role_runs.failed++;
        r.failed++;
      }
      if (typeof e.cost_usd === "number") {
        s.role_runs.cost_usd += e.cost_usd;
        r.cost_usd += e.cost_usd;
      } else s.role_runs.cost_unreported++;
    }
  }
  s.issues = [...latest.entries()].map(([issue, v]) => ({ issue, ...v })).sort((a, b) => a.issue - b.issue);
  s.role_runs.cost_usd = Math.round(s.role_runs.cost_usd * 1e6) / 1e6;
  return s;
}
