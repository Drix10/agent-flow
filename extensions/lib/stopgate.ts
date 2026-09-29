/**
 * The stop gate: an interactive session may not end its turn while the gates the repo marked `on_stop` fail, but it
 * is only ever held back a bounded number of times per turn.
 *
 * What makes it different from a prose "run the tests before you stop" rule, and from a hook that keeps blocking:
 *  - the gates come from the trusted (default-branch) manifest, so the session can't rewrite the gate that judges it;
 *  - it runs only when the working tree changed since the last passing run, so a chat-only turn costs nothing;
 *  - it blocks at most `pipeline.max_stop_blocks` (default 2, max 5) consecutive times, then lets the turn end and
 *    writes `stop_gate_exhausted` to the audit log. It never traps a session.
 * A turn is recognised by Claude Code's `stop_hook_active` flag: false on a fresh stop, true when the session is
 * already continuing because this hook blocked it.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./fsutil.js";
import { git } from "./git.js";
import { GateSpec, describeCommand, runGates } from "./gates.js";
import { appendAudit } from "./state.js";
import { ContextManifest } from "./manifest.js";

export const STOP_STATE = join(".agent-flow", "stop-gate.json");
export const DEFAULT_MAX_STOP_BLOCKS = 2;

export function maxStopBlocks(man: ContextManifest | null): number {
  const n = man?.pipeline?.max_stop_blocks;
  return Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 5 ? (n as number) : DEFAULT_MAX_STOP_BLOCKS;
}

export function stopGates(gates: GateSpec[]): GateSpec[] {
  return gates.filter((g) => (g as GateSpec & { on_stop?: unknown }).on_stop === true);
}

const NOISE = [":(exclude).agent-flow", ":(exclude)AGENT_STATE.md", ":(exclude).agent-state.json"];
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

/** A hash of everything a gate could judge: HEAD, tracked changes and untracked files. null when this isn't a git work tree. */
export function fingerprint(root: string): string | null {
  const head = git(["rev-parse", "--verify", "--quiet", "HEAD"], root, 10_000);
  const inside = git(["rev-parse", "--is-inside-work-tree"], root, 10_000);
  if (!inside.ok || inside.stdout !== "true") return null;
  const h = createHash("sha256");
  h.update(`head:${head.ok ? head.stdout : "none"}\n`);
  const diff = git(head.ok ? ["diff", "HEAD", "--binary", "--", ".", ...NOISE] : ["diff", "--binary", "--cached", "--", ".", ...NOISE], root, 60_000);
  h.update(diff.stdout);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z", "--", ".", ...NOISE], root, 60_000).stdout.split("\0").filter(Boolean).sort();
  for (const f of untracked) {
    h.update(`\nuntracked:${f}:`);
    try {
      const p = join(root, f);
      const st = statSync(p);
      if (st.isFile() && st.size <= MAX_UNTRACKED_BYTES) h.update(createHash("sha256").update(readFileSync(p)).digest("hex"));
      else h.update(`${st.size}:${st.mtimeMs}`);
    } catch {
      h.update("gone");
    }
  }
  return h.digest("hex");
}

interface StopState {
  passed_fingerprint?: string;
  blocks?: number;
}

function readStopState(root: string): StopState {
  try {
    const j = JSON.parse(readFileSync(join(root, STOP_STATE), "utf-8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

function writeStopState(root: string, s: StopState): void {
  try {
    atomicWrite(join(root, STOP_STATE), JSON.stringify(s) + "\n");
  } catch {
    /* best effort: the worst case is one extra gate run */
  }
}

export interface StopDecision {
  /** true = hold the session back (the hook exits 2 with `message` for the model). */
  block: boolean;
  outcome: "no_gates" | "unchanged" | "passed" | "blocked" | "exhausted";
  message?: string;
  blocks: number;
  limit: number;
}

/**
 * Decide whether this stop may go through. `continuing` is Claude Code's `stop_hook_active`.
 * `gates` are the trusted manifest's gates; only those marked `on_stop` run.
 */
export function evaluateStop(root: string, gates: GateSpec[], limit: number, continuing: boolean): StopDecision {
  const chosen = stopGates(gates);
  if (!chosen.length) return { block: false, outcome: "no_gates", blocks: 0, limit };
  const state = readStopState(root);
  const blocksSoFar = continuing ? (state.blocks ?? 0) : 0;
  const fp = fingerprint(root);
  if (fp !== null && state.passed_fingerprint === fp) {
    writeStopState(root, { passed_fingerprint: fp, blocks: 0 });
    return { block: false, outcome: "unchanged", blocks: 0, limit };
  }

  const report = runGates(root, chosen, {});
  const failed = report.results.filter((r) => r.required && !r.ok);
  if (!failed.length) {
    // Re-take it: a gate that writes files (coverage, build output) must not make every later stop look "changed".
    const after = fingerprint(root);
    writeStopState(root, { passed_fingerprint: after ?? undefined, blocks: 0 });
    appendAudit(root, { event: "stop_gate", outcome: "passed", gates: chosen.map((g) => g.name) });
    return { block: false, outcome: "passed", blocks: 0, limit };
  }

  const names = failed.map((r) => r.name).join(", ");
  if (blocksSoFar >= limit) {
    writeStopState(root, { blocks: 0 });
    appendAudit(root, { event: "stop_gate_exhausted", gates: failed.map((r) => r.name), blocks: blocksSoFar, limit });
    return {
      block: false,
      outcome: "exhausted",
      message: `stop gate: ${names} still failing after ${blocksSoFar} block(s); letting the turn end. Tell the user these gates fail.`,
      blocks: blocksSoFar,
      limit,
    };
  }
  const blocks = blocksSoFar + 1;
  writeStopState(root, { blocks });
  appendAudit(root, { event: "stop_gate_blocked", gates: failed.map((r) => r.name), blocks, limit });
  const detail = failed
    .map((r) => `- ${r.name}: ${r.timed_out ? "timed out" : r.error ?? `exit ${r.exit_code}, expected ${r.expected_exit}`} (\`${describeCommand(chosen.find((g) => g.name === r.name)!.command)}\`, log ${r.log})`)
    .join("\n");
  return {
    block: true,
    outcome: "blocked",
    message: `Stop gate (${blocks}/${limit}): these gates must pass before you finish:\n${detail}\nFix the cause, or if you can't, say plainly that they fail. Do not edit the gate.`,
    blocks,
    limit,
  };
}

