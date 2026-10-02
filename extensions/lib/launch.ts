/**
 * Starting a role (an agent CLI) as its own process, with a wall-clock limit, and recording what it printed.
 * This is the skill's `run-role.mjs` as library code, so `agent-flow run` and the skill behave the same way.
 *
 * Files written next to `base`: .argv (what ran), .pid, .raw (stdout), .err (stderr), .secs, and last .exit
 * (124 = timed out, 127 = could not start).
 */
import { spawn, spawnSync } from "node:child_process";
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

/** Quote one argument for cmd.exe (used only for npm's .cmd shims). */
export const quoteForCmd = (a: string): string => `"${String(a).replace(/"/g, '""')}"`;

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
    const win = process.platform === "win32";
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
        // Preserve the error that prevented stderr from opening.
      }
      throw error;
    }
    const stdio: ["ignore", number, number] = ["ignore", out, err];
    const childEnv = { ...process.env, ...env };
    delete childEnv.AF_SUPERVISED;
    const started = Date.now();
    let timedOut = false;
    let finished = false;
    const viaShell = win && /\.(cmd|bat)$/i.test(exe);
    let child;
    try {
      child = viaShell
        ? spawn(`${quoteForCmd(exe)} ${argv.slice(1).map(quoteForCmd).join(" ")}`, { cwd, env: childEnv, stdio, shell: true, windowsHide: true })
        : spawn(exe, argv.slice(1), { cwd, env: childEnv, stdio, windowsHide: true });
    } catch {
      closeSync(out);
      closeSync(err);
      resolve({ exit: 127, seconds: 0 });
      return;
    }
    if (child.pid) writeFileSync(`${base}.pid`, String(child.pid));
    const stop = () => {
      if (win && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      else child.kill("SIGTERM");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, timeoutSec * 1000);
    const done = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      closeSync(out);
      closeSync(err);
      const seconds = Math.round((Date.now() - started) / 1000);
      const exit = timedOut ? 124 : (code ?? 1);
      writeFileSync(`${base}.secs`, String(seconds));
      writeFileSync(`${base}.exit.tmp`, String(exit));
      renameSync(`${base}.exit.tmp`, `${base}.exit`);
      resolve({ exit, seconds });
    };
    child.on("error", () => done(127));
    child.on("exit", done);
  });
