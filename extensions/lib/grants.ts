/**
 * Grants and pauses: the one place a human widens what the guard allows.
 *
 * A grant lets a role-less session land commits on the default branch; a pause switches one rule (or the whole guard) off until a
 * stated time. Both are written by a human running `agent-flow grant|pause|revoke` (with `!`, or from another terminal), never by
 * an agent: the guard refuses those commands and any write under this directory when they come through a tool call.
 *
 * They live in user scope, not in the repo, so a branch an agent pushes or a manifest it edits can't carry one. Expiry is an absolute
 * time (a wall-clock duration would run out during a usage-limit stop). An unreadable store means no grant: stricter, never looser.
 * This is best-effort against a determined agent with a shell; server-side branch protection is the real boundary.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { CASE_INSENSITIVE_FS, landingPath, toPosix } from "./fsutil.js";

export const GRANT_KINDS = ["push-default"] as const;
export type GrantKind = (typeof GRANT_KINDS)[number];

export interface Grant {
  id: string;
  kind: GrantKind;
  /** The repository root (normalised), or "*" for every repository. */
  repo: string;
  /** ISO time it ends, or null for a standing grant. */
  until: string | null;
  reason?: string;
  created: string;
}

export interface Pause {
  id: string;
  /** "all" or a rule name. */
  scope: string;
  repo: string;
  until: string;
  reason?: string;
  created: string;
}

export interface Store {
  version: 1;
  grants: Grant[];
  pauses: Pause[];
}

/** What applies to one repository right now. */
export interface Active {
  pushDefault: Grant | null;
  pauseAll: Pause | null;
  pausedRules: Map<string, Pause>;
}

export const NONE: Active = { pushDefault: null, pauseAll: null, pausedRules: new Map() };

export function storeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_FLOW_HOME ? resolve(env.AGENT_FLOW_HOME) : join(homedir(), ".agent-flow");
}

export const storeFile = (env: NodeJS.ProcessEnv = process.env) => join(storeDir(env), "grants.json");

/** A repository root as the store keys it: resolved through links, forward slashes, case-folded where the file system is. */
export function repoKey(root: string): string {
  const p = toPosix(landingPath(resolve(root)));
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
}

export function readStore(env: NodeJS.ProcessEnv = process.env): Store {
  const empty: Store = { version: 1, grants: [], pauses: [] };
  try {
    const raw = JSON.parse(readFileSync(storeFile(env), "utf-8"));
    if (!raw || typeof raw !== "object") return empty;
    const grants = Array.isArray(raw.grants) ? raw.grants.filter((g: Grant) => g && g.kind === "push-default" && typeof g.id === "string" && typeof g.repo === "string") : [];
    const pauses = Array.isArray(raw.pauses) ? raw.pauses.filter((p: Pause) => p && typeof p.id === "string" && typeof p.scope === "string" && typeof p.repo === "string" && typeof p.until === "string") : [];
    return { version: 1, grants, pauses };
  } catch {
    return empty;
  }
}

export function writeStore(store: Store, env: NodeJS.ProcessEnv = process.env): void {
  const dir = storeDir(env);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = storeFile(env);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

const live = (until: string | null, now: Date) => until === null || (Number.isFinite(Date.parse(until)) && Date.parse(until) > now.getTime());
const forRepo = (repo: string, root: string) => repo === "*" || repo === repoKey(root);

/** What a grant or pause lets through for `root` at `now`. Expired entries are ignored. */
export function activeFor(root: string, now: Date = new Date(), store: Store = readStore()): Active {
  const out: Active = { pushDefault: null, pauseAll: null, pausedRules: new Map() };
  for (const g of store.grants) if (g.kind === "push-default" && forRepo(g.repo, root) && live(g.until, now)) out.pushDefault = g;
  for (const p of store.pauses) {
    if (!forRepo(p.repo, root) || !live(p.until, now)) continue;
    if (p.scope === "all") out.pauseAll = p;
    else out.pausedRules.set(p.scope, p);
  }
  return out;
}

/** An absolute end time from `--until <ISO>`, `--days N` or `--hours N`; a missing flag uses `fallbackHours`. Throws on a past or unreadable time. */
export function untilFrom(opts: { until?: unknown; days?: unknown; hours?: unknown }, fallbackHours: number, now: Date = new Date()): Date {
  let t: number;
  if (typeof opts.until === "string") {
    t = Date.parse(opts.until);
    if (!Number.isFinite(t)) throw new Error(`--until ${JSON.stringify(opts.until)} is not a date (use an ISO time such as 2026-12-01T09:00:00Z)`);
  } else if (opts.days !== undefined || opts.hours !== undefined) {
    const n = Number(opts.days !== undefined ? opts.days : opts.hours) * (opts.days !== undefined ? 24 : 1);
    if (!Number.isFinite(n) || n <= 0) throw new Error("--days / --hours must be a positive number");
    t = now.getTime() + n * 3_600_000;
  } else t = now.getTime() + fallbackHours * 3_600_000;
  if (t <= now.getTime()) throw new Error("that time is already past");
  return new Date(t);
}

const newId = () => randomBytes(4).toString("hex");

export function addGrant(store: Store, g: { kind: GrantKind; repo: string; until: Date | null; reason?: string }, now: Date = new Date()): Grant {
  const grant: Grant = { id: newId(), kind: g.kind, repo: g.repo, until: g.until ? g.until.toISOString() : null, ...(g.reason ? { reason: g.reason.slice(0, 200) } : {}), created: now.toISOString() };
  store.grants.push(grant);
  return grant;
}

export function addPause(store: Store, p: { scope: string; repo: string; until: Date; reason?: string }, now: Date = new Date()): Pause {
  const pause: Pause = { id: newId(), scope: p.scope, repo: p.repo, until: p.until.toISOString(), ...(p.reason ? { reason: p.reason.slice(0, 200) } : {}), created: now.toISOString() };
  store.pauses.push(pause);
  return pause;
}

/** Remove one entry by id, or every entry that applies to `root` (and every "*" entry) when `id` is "all". Returns how many went. */
export function revoke(store: Store, id: string, root: string): number {
  const before = store.grants.length + store.pauses.length;
  const keep = (e: { id: string; repo: string }) => (id === "all" ? !forRepo(e.repo, root) : e.id !== id);
  store.grants = store.grants.filter(keep);
  store.pauses = store.pauses.filter(keep);
  return before - store.grants.length - store.pauses.length;
}

/** Entries to show: live ones for this repo and "*", newest last. */
export function listActive(root: string, now: Date = new Date(), store: Store = readStore()): { grants: Grant[]; pauses: Pause[] } {
  return { grants: store.grants.filter((g) => forRepo(g.repo, root) && live(g.until, now)), pauses: store.pauses.filter((p) => forRepo(p.repo, root) && live(p.until, now)) };
}
