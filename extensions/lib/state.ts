/**
 * Needs Me / Working / Completed state machine.
 *
 * What is now MECHANICAL (was prose in v1.0.2):
 *  - Transitions are validated. `Completed` is terminal unless explicitly reopened.
 *  - Review rounds are monotonic and bounded. Reporting a round past the limit
 *    auto-escalates to `Needs Me` — the orchestrator cannot "forget" the cap.
 *  - `Needs Me` requires a reason (the structured escalation summary).
 *  - Every transition is appended to per-session history + .agent-flow/audit.jsonl.
 *  - Writes are locked + atomic, and always go to the MAIN repo root, so
 *    parallel implementers in separate worktrees share one state file.
 */

import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, readFileSync, fstatSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, isoNow, readJson, withLock } from "./fsutil.js";
import { DEFAULT_MAX_REVIEW_ROUNDS } from "./manifest.js";

export const STATES = ["Needs Me", "Working", "Completed"] as const;
export type SessionState = (typeof STATES)[number];

export interface Transition {
  at: string;
  from: SessionState | null;
  to: SessionState;
  phase: string;
  round: number;
  reason?: string;
}

export interface Session {
  issue: number;
  state: SessionState;
  phase: string;
  round: number;
  startedAt: string;
  updatedAt?: string;
  worktree: string;
  reason?: string;
  history?: Transition[];
}

export interface StateFile {
  sessions: Session[];
  lastUpdated: string;
}

export const STATE_FILE = ".agent-state.json";
export const STATE_MD = "AGENT_STATE.md";
export const AUDIT_LOG = join(".agent-flow", "audit.jsonl");
const HISTORY_CAP = 50;
const MAX_PHASE = 80;
const MAX_REASON = 2000;

const ALLOWED: Record<string, SessionState[]> = {
  new: ["Working", "Needs Me"],
  Working: ["Working", "Needs Me", "Completed"],
  "Needs Me": ["Needs Me", "Working", "Completed"],
  Completed: [],
};

/** The hash a fresh log starts from. */
export const AUDIT_GENESIS = "genesis";

/** Hash of one audit entry: the previous hash and the entry's own JSON (without its `hash`), so editing or removing any line breaks every hash after it. */
export function auditHash(prev: string, body: Record<string, unknown>): string {
  return createHash("sha256").update(`${prev}\n${JSON.stringify(body)}`).digest("hex");
}

/** The `hash` of the last line of the log, from its tail (never the whole file). */
function lastAuditHash(path: string): string {
  if (!existsSync(path)) return AUDIT_GENESIS;
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, 65_536);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf-8").split("\n").filter((l) => l.trim() !== "");
    for (let k = lines.length - 1; k >= 0; k--) {
      try {
        const h = JSON.parse(lines[k]).hash;
        // An `unchained` line (written when the lock timed out) has no hash; the verifier skips it, so the chain
        // continues from the last line that does.
        if (typeof h === "string") return h;
      } catch {
        /* a partial first line of the tail window */
      }
    }
    return AUDIT_GENESIS;
  } finally {
    closeSync(fd);
  }
}

/**
 * Append one line to `.agent-flow/audit.jsonl`, chained to the line before it (`prev` → `hash`) so that
 * `agent-flow audit verify` notices an edited, removed or reordered line. Serialised by a lock; if the lock
 * can't be had, the line is still written, marked `unchained`, rather than lost. Best-effort: never blocks the pipeline.
 */
export function appendAudit(root: string, entry: Record<string, unknown>): void {
  try {
    mkdirSync(join(root, ".agent-flow"), { recursive: true });
    const path = join(root, AUDIT_LOG);
    try {
      withLock(join(root, ".agent-flow", "audit.lock"), () => {
        const prev = lastAuditHash(path);
        const body = { at: isoNow(), ...entry, prev };
        appendFileSync(path, JSON.stringify({ ...body, hash: auditHash(prev, body) }) + "\n", "utf-8");
      }, 5_000, 2_000);
    } catch {
      appendFileSync(path, JSON.stringify({ at: isoNow(), ...entry, unchained: true }) + "\n", "utf-8");
    }
  } catch {
    /* audit is best-effort; never block the pipeline on a log write */
  }
}

export function readState(root: string): StateFile {
  const path = join(root, STATE_FILE);
  if (!existsSync(path)) return { sessions: [], lastUpdated: isoNow() };
  const r = readJson<StateFile>(path);
  if (!r.ok) throw new Error(`${r.error} — refusing to overwrite; fix or move the file`);
  if (!Array.isArray(r.value?.sessions)) throw new Error(`${path}: missing sessions array — refusing to overwrite`);
  return r.value;
}

/** One line, no markdown control chars — issue text is untrusted input. */
function oneLine(s: string | undefined, max = 300): string {
  if (!s) return "";
  const flat = s.replace(/[\r\n]+/g, " ").replace(/[`|]/g, "").replace(/</g, "&lt;").replace(/>/g, "&gt;").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function renderMarkdown(state: StateFile): string {
  const by = (st: SessionState) => state.sessions.filter((s) => s.state === st).sort((a, b) => a.issue - b.issue);
  const needsMe = by("Needs Me");
  const working = by("Working");
  const completed = by("Completed");
  const list = (items: string[]) => (items.length ? items.join("\n") : "_None_");
  return `# Agent State

> Last updated: ${state.lastUpdated} · generated by agent-flow — do not edit by hand

## 🔴 Needs Me (${needsMe.length})

${list(needsMe.map((s) => `- **Issue #${s.issue}** — ${oneLine(s.reason) || "action required"} _(phase: ${oneLine(s.phase)}, round ${s.round})_`))}

## 🔵 Working (${working.length})

${list(working.map((s) => `- **Issue #${s.issue}** — ${oneLine(s.phase)} (round ${s.round}) · \`${s.worktree}\``))}

## 🟢 Completed (${completed.length})

${list(completed.map((s) => `- **Issue #${s.issue}** — done${s.reason ? ` — ${oneLine(s.reason)}` : ""}`))}
`;
}

export interface UpdateParams {
  issue: number;
  state: SessionState;
  phase?: string;
  round?: number;
  reason?: string;
  /** Human-only escape hatch: reopen a Completed session. */
  reopen?: boolean;
}

export interface UpdateResult {
  updated: number;
  from: SessionState | null;
  state: SessionState;
  round: number;
  escalated: boolean;
  reason?: string;
}

/** What an issue's role runs have cost so far, from the audit log. Only harnesses that report cost contribute. */
export function issueCost(root: string, issue: number): { total: number; by_round: Record<number, number>; unreported_runs: number } {
  const out = { total: 0, by_round: {} as Record<number, number>, unreported_runs: 0 };
  const path = join(root, AUDIT_LOG);
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf-8").split("\n")) {
    if (!raw.includes('"role_run"')) continue;
    try {
      const e = JSON.parse(raw);
      if (e.event !== "role_run" || e.issue !== issue) continue;
      if (typeof e.cost_usd === "number" && Number.isFinite(e.cost_usd) && e.cost_usd >= 0) {
        out.total += e.cost_usd;
        const r = Number.isInteger(e.round) ? e.round : 0;
        out.by_round[r] = (out.by_round[r] ?? 0) + e.cost_usd;
      } else out.unreported_runs++;
    } catch {
      /* a torn line is `audit verify`'s business */
    }
  }
  out.total = Math.round(out.total * 1e6) / 1e6;
  return out;
}

/**
 * Drop an issue from the pipeline's list: a person handled it by hand, or no longer wants it. The issue's files stay
 * where they are and the audit trail records who-knows-what-why, so nothing is lost; only the "needs you" nag goes.
 */
export function dismissSession(root: string, issue: number, reason: string): { dismissed: boolean; from: SessionState | null } {
  if (!Number.isInteger(issue) || issue < 1) throw new Error(`issue must be a positive integer, got ${issue}`);
  if (!reason.trim()) throw new Error("a reason is required: say why it is being dropped");
  if (reason.length > MAX_REASON) throw new Error(`reason is limited to ${MAX_REASON} characters`);
  return withLock(join(root, ".agent-flow", "state.lock"), () => {
    const state = readState(root);
    const at = state.sessions.findIndex((s) => s.issue === issue);
    if (at < 0) return { dismissed: false, from: null };
    const [gone] = state.sessions.splice(at, 1);
    state.lastUpdated = isoNow();
    atomicWrite(join(root, STATE_FILE), JSON.stringify(state, null, 2) + "\n");
    atomicWrite(join(root, STATE_MD), renderMarkdown(state));
    appendAudit(root, { event: "session_dismissed", issue, from: gone.state, phase: gone.phase, round: gone.round, reason });
    return { dismissed: true, from: gone.state };
  });
}

export function updateState(root: string, p: UpdateParams, maxRounds = DEFAULT_MAX_REVIEW_ROUNDS, maxCostUsd?: number): UpdateResult {
  if (!Number.isInteger(p.issue) || p.issue < 1) throw new Error(`issue must be a positive integer, got ${p.issue}`);
  if (!STATES.includes(p.state)) throw new Error(`state must be one of ${STATES.join(" | ")}`);
  if (p.round !== undefined && (!Number.isInteger(p.round) || p.round < 0)) throw new Error(`round must be a non-negative integer`);
  // The Pi tool schema enforces these; the CLI and library callers get the same limits.
  if (p.phase !== undefined && p.phase.length > MAX_PHASE) throw new Error(`phase is limited to ${MAX_PHASE} characters`);
  if (p.reason !== undefined && p.reason.length > MAX_REASON) throw new Error(`reason is limited to ${MAX_REASON} characters — keep the decision brief short`);
  if (p.reopen && p.state === "Completed") throw new Error("reopen starts a Completed issue again; the target state must be Working or Needs Me");

  return withLock(join(root, ".agent-flow", "state.lock"), () => {
    const state = readState(root);
    const existing = state.sessions.find((s) => s.issue === p.issue);
    const from: SessionState | null = existing?.state ?? null;
    let to = p.state;
    let reason = p.reason;
    let escalated = false;

    // `reopen` only has effect when the session is actually Completed. A `Working` or `Needs Me`
    // session cannot use it to rewind its round counter — that would let anyone dodge the round
    // cap (below) by resetting the count instead of actually resolving the escalation.
    const reopening = existing?.state === "Completed" && !!p.reopen;
    if (existing?.state === "Completed") {
      if (!p.reopen) throw new Error(`issue #${p.issue} is Completed (terminal). Pass reopen: true to start it again.`);
      existing.round = 0;
    } else if (!ALLOWED[from ?? "new"].includes(to)) {
      throw new Error(`illegal transition for issue #${p.issue}: ${from ?? "(new)"} → ${to}`);
    }

    const prevRound = existing?.round ?? 0;
    const round = p.round ?? prevRound;
    if (round < prevRound && !reopening) {
      throw new Error(`round cannot go backwards (${prevRound} → ${round}) — rounds are monotonic so the cap cannot be reset`);
    }

    // The ≤N rounds rule, enforced here rather than trusted to the orchestrator prompt.
    if (round > maxRounds && to === "Working") {
      to = "Needs Me";
      escalated = true;
      reason = `max_rounds_exceeded: round ${round} exceeds limit ${maxRounds}${p.reason ? ` — ${p.reason}` : ""}`;
    }
    // The cost cap, enforced here for the same reason: once it is reached, nothing goes back to Working without a human raising it.
    if (maxCostUsd !== undefined && to === "Working" && existing) {
      const c = issueCost(root, p.issue);
      if (c.total >= maxCostUsd) {
        const rounds = Object.entries(c.by_round).map(([r, v]) => `round ${r}: $${Math.round(v * 100) / 100}`).join(", ");
        to = "Needs Me";
        escalated = true;
        reason = `budget_exceeded: $${c.total} spent, cap $${maxCostUsd} (${rounds || "no per-round data"})${p.reason ? ` — ${p.reason}` : ""}`;
      }
    }
    if (to === "Needs Me" && !reason?.trim()) {
      throw new Error("Needs Me requires a reason (what was tried, what failed, what the human must decide)");
    }

    const now = isoNow();
    const phase = p.phase || existing?.phase || "unknown";
    const t: Transition = { at: now, from, to, phase, round, ...(reason ? { reason } : {}) };
    if (existing) {
      existing.state = to;
      existing.phase = phase;
      existing.round = round;
      existing.reason = reason;
      existing.updatedAt = now;
      existing.history = [...(existing.history ?? []), t].slice(-HISTORY_CAP);
    } else {
      state.sessions.push({
        issue: p.issue,
        state: to,
        phase,
        round,
        startedAt: now,
        updatedAt: now,
        worktree: `.worktrees/issue-${p.issue}`,
        reason,
        history: [t],
      });
    }
    state.lastUpdated = now;
    // STATE_FILE is the source of truth and is written first; it's the only one anything
    // else reads back. AGENT_STATE.md and the audit line are derived/best-effort — a crash
    // between these three writes leaves them briefly behind STATE_FILE, not wrong, and the
    // next transition regenerates AGENT_STATE.md from STATE_FILE in full each time.
    atomicWrite(join(root, STATE_FILE), JSON.stringify(state, null, 2) + "\n");
    atomicWrite(join(root, STATE_MD), renderMarkdown(state));
    appendAudit(root, { event: "state_transition", issue: p.issue, from, to, phase, round, escalated, reason });
    return { updated: p.issue, from, state: to, round, escalated, ...(reason ? { reason } : {}) };
  });
}
