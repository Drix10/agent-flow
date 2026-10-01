/**
 * Gates: commands the pipeline runs itself, so a pass or fail is an exit code the orchestrator observed, not a claim
 * a model made about output it read. The QA role can still run and interpret commands; a gate is the part that can't
 * be argued with.
 *
 * Declared in CONTEXT_MANIFEST.json (`gates`), run from the MAIN checkout's manifest, so a branch under test can't
 * edit the gate that judges it. Each run leaves a log, its SHA-256, and an audit line.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isoNow, resolveInside, toPosix } from "./fsutil.js";
import { ContextManifest } from "./manifest.js";
import { appendAudit } from "./state.js";
import { branchTip } from "./binding.js";

let shellCache: string | true | undefined;
/** The gate's shell itself (not a script it started) couldn't find or execute the command. */
const SHELL_SAID_UNRUNNABLE = /(^|\n)([A-Za-z]:)?([^\n:]*[/\x5c])?(ba|da|z)?sh(\.exe)?: (line \d+: )?[^\n]*(command not found|: not found|Permission denied|cannot execute|No such file or directory)/;

/**
 * The shell a string gate runs in. Gate commands are POSIX (they come from CI files and READMEs), so on
 * Windows they need Git's bash, not cmd.exe, which can't run `./build.sh` or a `for` loop.
 * AGENT_FLOW_SHELL overrides. WSL's System32 bash is never picked: it runs in another filesystem.
 */
export function gateShell(): string | true {
  if (process.env.AGENT_FLOW_SHELL) return process.env.AGENT_FLOW_SHELL;
  if (process.platform !== "win32") return true;
  if (shellCache !== undefined) return shellCache;
  shellCache = true;
  try {
    const exec = execFileSync("git", ["--exec-path"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const gitRoot = resolve(exec, "..", "..", "..");
    for (const p of [join(gitRoot, "bin", "bash.exe"), join(gitRoot, "usr", "bin", "bash.exe")]) {
      if (existsSync(p)) {
        shellCache = p;
        break;
      }
    }
  } catch {
    // no git on PATH: cmd.exe it is, and a POSIX gate will say so in its log
  }
  return shellCache;
}

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
  /** Platforms the gate can run on (Node's process.platform: linux, darwin, win32). Elsewhere it is skipped and says so. */
  os?: string[];
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
  /** Set when the gate's `os` excludes this machine: nothing ran, so nothing passed. CI on a listed platform is the judge. */
  skipped?: string;
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
    if (Array.isArray(g.os) && g.os.length && !g.os.includes(process.platform)) {
      const r: GateResult = { name: g.name, command: describeCommand(g.command), cwd: toPosix(base), expected_exit: g.expect_exit ?? 0, exit_code: null, ok: true, required: g.required !== false, timed_out: false, skipped: `runs on ${g.os.join("/")}, this is ${process.platform}`, duration_ms: 0, started_at, log: "", log_sha256: "" };
      results.push(r);
      appendAudit(root, { event: "gate_skipped", issue: opts.issue, gate: r.name, reason: r.skipped });
      continue;
    }
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
      // `"cwd": "."` means the checkout itself, which resolveInside (for paths *inside* the root) refuses.
      cwd = g.cwd && resolve(base, g.cwd) !== resolve(base) ? resolveInside(base, g.cwd) : base;
      const r = Array.isArray(g.command)
        ? spawnSync(g.command[0], g.command.slice(1), { cwd, encoding: "buffer", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_LOG, env: { ...process.env, AGENT_FLOW_GATE: g.name } })
        : spawnSync(g.command, { cwd, shell: gateShell(), encoding: "buffer", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_LOG, env: { ...process.env, AGENT_FLOW_GATE: g.name } });
      output = `${r.stdout?.toString("utf-8") ?? ""}${r.stderr?.toString("utf-8") ?? ""}`;
      if (r.error) {
        const code = (r.error as NodeJS.ErrnoException).code;
        if (code === "ETIMEDOUT") timedOut = true;
        else error = `${code ?? "error"}: ${r.error.message}`;
      }
      exit = r.status;
      if (r.signal && !timedOut) error = `killed by ${r.signal}`;
      // 126/127: the shell couldn't find or execute the command. That's the environment, not the code under test.
      // A 126/127 from inside a script the gate ran (`./build.sh: line 36: …`) is that script's own failure.
      else if (!Array.isArray(g.command) && (exit === 126 || exit === 127) && expected !== exit && SHELL_SAID_UNRUNNABLE.test(output)) error = `command not runnable here (exit ${exit})`;
      else if (!Array.isArray(g.command) && exit !== expected && gateShell() === true && process.platform === "win32" && /is not recognized as an internal or external command/.test(output)) error = "cmd.exe can't run this command; install Git for Windows or set AGENT_FLOW_SHELL to a POSIX shell";
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
    appendAudit(root, { event: "gate_run", issue: opts.issue, head: opts.issue ? branchTip(root, opts.issue) : undefined, gate: r.name, ok: r.ok, exit_code: r.exit_code, expected_exit: r.expected_exit, timed_out: r.timed_out, error: r.error, log: r.log, log_sha256: r.log_sha256 });
  }

  const ok = results.every((r) => r.ok || !r.required);
  const report = results.length ? toPosix(join(".agent-flow", "gates", `${tag}-report-${stamp}.json`)) : null;
  const environmentError = results.some((r) => r.required && !r.ok && !!r.error);
  if (report) writeFileSync(join(root, report), JSON.stringify({ ok, environment_error: environmentError, results }, null, 2) + "\n", "utf-8");
  return { ok, environment_error: environmentError, results, report };
}
