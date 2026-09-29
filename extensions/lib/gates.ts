/**
 * Gates: commands the pipeline runs itself, so a pass or fail is an exit code the orchestrator observed, not a claim
 * a model made about output it read. The QA role can still run and interpret commands; a gate is the part that can't
 * be argued with.
 *
 * Declared in CONTEXT_MANIFEST.json (`gates`), run from the MAIN checkout's manifest, so a branch under test can't
 * edit the gate that judges it. Each run leaves a log, its SHA-256, and an audit line.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isoNow, resolveInside, toPosix } from "./fsutil.js";
import { ContextManifest } from "./manifest.js";
import { appendAudit } from "./state.js";

export interface GateSpec {
  name: string;
  /** A string runs through the shell; an array is an argv (no shell, no quoting to get wrong). */
  command: string | string[];
  /** Repo-relative working directory (default: the checkout being judged). */
  cwd?: string;
  timeout_seconds?: number;
  expect_exit?: number;
  /** A failing non-required gate is reported but doesn't fail the run. Default true. */
  required?: boolean;
}

export interface GateResult {
  name: string;
  command: string;
  cwd: string;
  expected_exit: number;
  exit_code: number | null;
  ok: boolean;
  required: boolean;
  timed_out: boolean;
  /** Set when the command could not be run at all (missing binary, bad cwd): an environment problem, not a test failure. */
  error?: string;
  duration_ms: number;
  started_at: string;
  log: string;
  log_sha256: string;
}

export interface GateReport {
  ok: boolean;
  /** True when a gate could not run at all: fix the environment, don't spend a review round. */
  environment_error: boolean;
  results: GateResult[];
  report: string | null;
}

export const DEFAULT_GATE_TIMEOUT_S = 600;
const MAX_LOG = 5 * 1024 * 1024;

/** The valid gates of a manifest; malformed entries are dropped here and reported by validateManifest. */
export function gatesOf(man: ContextManifest | null | undefined): GateSpec[] {
  const raw = (man as { gates?: unknown } | null | undefined)?.gates;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: GateSpec[] = [];
  for (const g of raw) {
    if (!g || typeof g !== "object") continue;
    const s = g as Partial<GateSpec>;
    const cmdOk = (typeof s.command === "string" && s.command.trim() !== "") || (Array.isArray(s.command) && s.command.length > 0 && s.command.every((a) => typeof a === "string" && a !== ""));
    if (typeof s.name !== "string" || !/^[\w.-]+$/.test(s.name) || !cmdOk || seen.has(s.name)) continue;
    seen.add(s.name);
    out.push(s as GateSpec);
  }
  return out;
}

export function describeCommand(c: string | string[]): string {
  return Array.isArray(c) ? c.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ") : c;
}

export interface RunOptions {
  /** Run only these gates (by name). An unknown name is an error, not a silent skip. */
  only?: string[];
  /** Directory the gates judge: the repo root, or an issue's worktree. Gate `cwd` is relative to it. */
  cwd?: string;
  /** Label for log names and the audit line. */
  issue?: number;
}

export function runGates(root: string, gates: GateSpec[], opts: RunOptions = {}): GateReport {
  const base = opts.cwd ?? root;
  const unknown = (opts.only ?? []).filter((n) => !gates.some((g) => g.name === n));
  if (unknown.length) throw new Error(`no such gate: ${unknown.join(", ")} (defined: ${gates.map((g) => g.name).join(", ") || "none"})`);
  const chosen = opts.only?.length ? gates.filter((g) => opts.only!.includes(g.name)) : gates;
  const stamp = isoNow().replace(/[:.]/g, "-");
  const dir = join(root, ".agent-flow", "gates");
  mkdirSync(dir, { recursive: true });
  const tag = opts.issue ? `issue-${opts.issue}` : "run";

  const results: GateResult[] = [];
  for (const g of chosen) {
    const started_at = isoNow();
    const t0 = Date.now();
    const expected = g.expect_exit ?? 0;
    const required = g.required !== false;
    const timeoutMs = (g.timeout_seconds ?? DEFAULT_GATE_TIMEOUT_S) * 1000;
    let cwd = base;
    let error: string | undefined;
    let exit: number | null = null;
    let timedOut = false;
    let output = "";
    try {
      cwd = g.cwd ? resolveInside(base, g.cwd) : base;
      const r = Array.isArray(g.command)
        ? spawnSync(g.command[0], g.command.slice(1), { cwd, encoding: "buffer", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_LOG, env: { ...process.env, AGENT_FLOW_GATE: g.name } })
        : spawnSync(g.command, { cwd, shell: true, encoding: "buffer", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_LOG, env: { ...process.env, AGENT_FLOW_GATE: g.name } });
      output = `${r.stdout?.toString("utf-8") ?? ""}${r.stderr?.toString("utf-8") ?? ""}`;
      if (r.error) {
        const code = (r.error as NodeJS.ErrnoException).code;
        if (code === "ETIMEDOUT") timedOut = true;
        else error = `${code ?? "error"}: ${r.error.message}`;
      }
      exit = r.status;
      if (r.signal && !timedOut) error = `killed by ${r.signal}`;
    } catch (e: any) {
      error = e.message;
    }
    const ok = !error && !timedOut && exit === expected;
    const header = `# gate ${g.name}\n# command: ${describeCommand(g.command)}\n# cwd: ${toPosix(cwd)}\n# started: ${started_at}\n# expected exit: ${expected}\n\n`;
    const trailer = `\n\n# exit: ${exit}${timedOut ? " (timed out)" : ""}${error ? ` (${error})` : ""}\n`;
    const body = header + output + trailer;
    const file = join(".agent-flow", "gates", `${tag}-${g.name}-${stamp}.log`);
    writeFileSync(join(root, file), body, "utf-8");
    const r: GateResult = {
      name: g.name,
      command: describeCommand(g.command),
      cwd: toPosix(cwd),
      expected_exit: expected,
      exit_code: exit,
      ok,
      required,
      timed_out: timedOut,
      ...(error ? { error } : {}),
      duration_ms: Date.now() - t0,
      started_at,
      log: toPosix(file),
      log_sha256: createHash("sha256").update(body).digest("hex"),
    };
    results.push(r);
    appendAudit(root, { event: "gate_run", issue: opts.issue, gate: r.name, ok: r.ok, exit_code: r.exit_code, expected_exit: r.expected_exit, timed_out: r.timed_out, error: r.error, log: r.log, log_sha256: r.log_sha256 });
  }

  const ok = results.every((r) => r.ok || !r.required);
  const report = results.length ? toPosix(join(".agent-flow", "gates", `${tag}-report-${stamp}.json`)) : null;
  const environmentError = results.some((r) => r.required && !r.ok && !!r.error);
  if (report) writeFileSync(join(root, report), JSON.stringify({ ok, environment_error: environmentError, results }, null, 2) + "\n", "utf-8");
  return { ok, environment_error: environmentError, results, report };
}
