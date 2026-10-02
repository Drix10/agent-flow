/**
 * Starting a role (an agent CLI) as its own process, with a wall-clock limit, and recording what it printed.
 * This is the skill's `run-role.mjs` as library code, so `agent-flow run` and the skill behave the same way.
 *
 * Files written next to `base`: .argv (what ran), .pid, .raw (stdout), .err (stderr), .secs, and last .exit
 * (124 = timed out, 127 = could not start).
 */
import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, closeSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SpawnSpec {
  /** The command and its arguments, e.g. ["claude", "-p", "--model", "sonnet", "…prompt…"]. */
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  /** Path prefix for the files above, e.g. `<artifacts>/implementer-r1`. */
  base: string;
  timeoutSec: number;
}

export interface SpawnResult {
  exit: number;
  seconds: number;
}

export type Spawner = (spec: SpawnSpec) => Promise<SpawnResult>;

/** On Windows, find `claude.cmd` / `claude.exe` the way a shell would; elsewhere the name is used as given. */
export function resolveExecutable(cmd: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  if (platform !== "win32") return cmd;
  if (/[\\/]/.test(cmd) || /\.[a-z]+$/i.test(cmd)) return cmd;
  const exts = (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";");
  for (const dir of (env.PATH ?? env.Path ?? "").split(";")) {
    if (!dir) continue;
    for (const e of exts) {
      const p = join(dir, cmd + e);
      if (existsSync(p)) return p;
    }
  }
  return cmd;
}

/**
 * Quote one argument for cmd.exe (used only for npm's .cmd shims). A line break would end the command line there and
 * silently drop the rest of the prompt, so it becomes a space.
 */
export const quoteForCmd = (a: string): string => `"${String(a).replace(/\r\n|\r|\n/g, " ").replace(/"/g, '""')}"`;

/** Roles currently running, so an interrupted `run` can stop them instead of leaving them working unattended. */
const active = new Set<ChildProcess>();
const win = () => process.platform === "win32";

function stopTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (win()) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    // The role was started as a process group leader, so this reaches the tests and shells it started too.
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/** Stop every role that is still running (and the processes under it). Safe to call repeatedly. */
export function killActiveChildren(): number {
  const n = active.size;
  for (const child of active) stopTree(child, "SIGTERM");
  return n;
}

export const realSpawner: Spawner = (spec) =>
  new Promise((resolve) => {
    const { argv, env, cwd, base, timeoutSec } = spec;
    if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== "string" || a.includes("\0"))) {
      resolve({ exit: 127, seconds: 0 });
      return;
    }
    if (!Number.isSafeInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 86_400) {
      resolve({ exit: 127, seconds: 0 });
      return;
    }
    const exe = resolveExecutable(argv[0]);
    writeFileSync(`${base}.argv`, JSON.stringify(argv));
    const out = openSync(`${base}.raw`, "w");
    let err: number;
    try {
      err = openSync(`${base}.err`, "w");
    } catch (error) {
      try {
        closeSync(out);
      } catch {
        // Preserve the error that prevented stream setup.
      }
      throw error;
    }
    const stdio: ["ignore", number, number] = ["ignore", out, err];
    const childEnv = { ...process.env, ...env };
    delete childEnv.AF_SUPERVISED;
    const started = Date.now();
    let timedOut = false;
    let finished = false;
    const viaShell = win() && /\.(cmd|bat)$/i.test(exe);
    let child: ChildProcess;
    try {
      child = viaShell
        ? spawn(`${quoteForCmd(exe)} ${argv.slice(1).map(quoteForCmd).join(" ")}`, { cwd, env: childEnv, stdio, shell: true, windowsHide: true })
        : spawn(exe, argv.slice(1), { cwd, env: childEnv, stdio, windowsHide: true, detached: !win() });
    } catch {
      closeSync(out);
      closeSync(err);
      resolve({ exit: 127, seconds: 0 });
      return;
    }
    active.add(child);
    if (child.pid) {
      try {
        writeFileSync(`${base}.pid`, String(child.pid));
      } catch {
        /* the pid file is a convenience for crash checks, not a requirement */
      }
    }
    const timer = setTimeout(() => {
      timedOut = true;
      stopTree(child, "SIGTERM");
      setTimeout(() => stopTree(child, "SIGKILL"), 10_000).unref();
    }, timeoutSec * 1000);
    const done = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      active.delete(child);
      for (const fd of [out, err]) {
        try {
          closeSync(fd);
        } catch {
          /* closed already */
        }
      }
      const seconds = Math.round((Date.now() - started) / 1000);
      const exit = timedOut ? 124 : (code ?? 1);
      // The caller reads the report from .raw and the exit code from this result; these files are the record for a
      // human or a later resume, so a full disk must not turn a finished role into a crash.
      try {
        writeFileSync(`${base}.secs`, String(seconds));
        writeFileSync(`${base}.exit.tmp`, String(exit));
        renameSync(`${base}.exit.tmp`, `${base}.exit`);
      } catch {
        /* see above */
      }
      resolve({ exit, seconds });
    };
    child.on("error", () => done(127));
    child.on("exit", done);
  });
