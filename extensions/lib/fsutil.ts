/**
 * Filesystem helpers shared by every tool and the CLI.
 *
 * Design rules:
 *  - Zero runtime dependencies (node: built-ins only) — smaller supply-chain surface.
 *  - Every path we hand back is POSIX-style and repo-relative, on every OS, so
 *    manifests written on Windows match manifests checked on Linux CI.
 *  - Every write is atomic (tmp + rename) so a crash never leaves half a JSON file.
 */

import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Directories no scan should ever descend into — at any depth. */
export const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".worktrees",
  ".agent-flow",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "target",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".tox",
  ".gradle",
  ".idea",
  ".vscode",
]);

export const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

export function toPosix(p: string): string {
  return p.split(sep).join("/").replace(/\\/g, "/");
}

export interface WalkOptions {
  /** Hard cap on files returned. Huge monorepos get truncated, never hang. */
  maxFiles?: number;
  /** Only return files whose name matches. */
  filter?: (relPath: string) => boolean;
  /** Extra directory names to skip. */
  ignoreDirs?: Iterable<string>;
}

export interface WalkResult {
  files: string[];
  truncated: boolean;
}

/** Deterministic (sorted) recursive walk. Never follows symlinks. */
export function walk(root: string, opts: WalkOptions = {}): WalkResult {
  const maxFiles = opts.maxFiles ?? 50_000;
  const ignore = new Set([...IGNORED_DIRS, ...(opts.ignoreDirs ?? [])]);
  const files: string[] = [];
  let truncated = false;

  const stack: string[] = [""];
  while (stack.length > 0) {
    const relDir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(join(root, relDir), { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip, never crash a scan
    }
    entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!ignore.has(entry.name)) stack.push(rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (opts.filter && !opts.filter(rel)) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      files.push(rel);
    }
    if (truncated) break;
  }
  files.sort();
  return { files, truncated };
}

/** Read a text file, refusing binaries and anything above `maxBytes`. */
export function readTextFile(path: string, maxBytes = 1_000_000): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = readFileSync(path);
    if (buf.subarray(0, 8000).includes(0)) return null; // binary
    return buf.toString("utf-8");
  } catch {
    return null;
  }
}

export type JsonResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function readJson<T = unknown>(path: string): JsonResult<T> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e: any) {
    return { ok: false, error: `cannot read ${path}: ${e.code ?? e.message}` };
  }
  try {
    return { ok: true, value: JSON.parse(raw.replace(/^﻿/, "")) as T };
  } catch (e: any) {
    return { ok: false, error: `invalid JSON in ${path}: ${e.message}` };
  }
}

/** Atomic write: tmp file in the same dir, then rename over the target. */
export function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  try {
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

function sleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** True if `pid` names a process that is still alive on this machine. */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM"; // exists, just owned by someone else
  }
}

/**
 * Cross-process mutex via O_EXCL lockfile. Parallel implementers updating the
 * same state file would otherwise lose writes (read-modify-write race).
 *
 * The lock file holds the holder's PID. A lock is broken immediately once its
 * PID is confirmed dead (works whenever the holder ran on this machine, which
 * is every real use of this tool — worktrees are always local). Age (`staleMs`)
 * is only a fallback for a lock we can't attribute to a live-or-dead PID (a
 * foreign/older-format lock file, or a cross-host holder) — `fn()` itself is
 * always a fast, synchronous, in-process critical section, so a legitimate
 * holder should never actually take anywhere near `staleMs`.
 */
export function withLock<T>(lockPath: string, fn: () => T, timeoutMs = 10_000, staleMs = 30_000): T {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx");
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      try {
        const heldPid = Number.parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
        const dead = Number.isInteger(heldPid) && heldPid > 0 && heldPid !== process.pid && !processAlive(heldPid);
        const stale = Date.now() - statSync(lockPath).mtimeMs > staleMs;
        if (dead || stale) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue; // lock vanished between calls — retry immediately
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lockPath}`);
      sleep(25);
    }
  }
  try {
    writeFileSync(fd, String(process.pid));
  } catch {
    /* best-effort: an unreadable/missing PID just falls back to the age check above */
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * existsSync is case-insensitive on Windows and macOS, so a rename of
 * `Auth.ts` → `auth.ts` would never be flagged as drift. Check each segment
 * against the real directory listing instead.
 */
export function existsExact(root: string, relPath: string): boolean {
  const clean = toPosix(relPath).replace(/^\.\//, "").replace(/\/+$/, "");
  if (clean === "" || clean === ".") return existsSync(root);
  // A manifest reference that escapes the repo (`../../etc/hostname`) must never be reported
  // as existing — every other path check in this project is repo-confined, and stale/repair
  // certifying an outside-the-repo path as "verified" would be an inconsistent, surprising exception.
  const escapes = relative(root, resolve(root, clean));
  if (escapes.startsWith("..") || isAbsolute(escapes)) return false;
  if (!existsSync(join(root, clean))) return false;
  if (!CASE_INSENSITIVE_FS) return true;
  let dir = root;
  for (const seg of clean.split("/")) {
    if (seg === "..") {
      dir = resolve(dir, "..");
      continue;
    }
    if (seg === "." || seg === "") continue;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return false;
    }
    if (!names.includes(seg)) return false;
    dir = join(dir, seg);
  }
  return true;
}

/**
 * Resolve `p` against `root` and refuse anything that escapes it — via `..`,
 * absolute paths, or a symlinked parent directory pointing outside the repo.
 */
export function resolveInside(root: string, p: string): string {
  if (typeof p !== "string" || p.trim() === "" || p.includes("\0")) {
    throw new Error("path must be a non-empty string");
  }
  const rootReal = realpathSync(root);
  const abs = resolve(rootReal, p);
  const rel = relative(rootReal, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes the repository root: ${p}`);
  }
  // Walk up to the nearest existing ancestor and make sure its real path is inside.
  let probe = abs;
  while (!existsSync(probe)) probe = dirname(probe);
  const probeReal = realpathSync(probe);
  const relReal = relative(rootReal, probeReal);
  if (relReal.startsWith("..") || isAbsolute(relReal)) {
    throw new Error(`path resolves outside the repository through a symlink: ${p}`);
  }
  return abs;
}

/**
 * Where a write to `p` would really land: the real path of the nearest existing
 * ancestor with the rest appended. A lexical `resolve()` is fooled by a
 * symlinked directory (`src/up -> ../../..`), which is exactly how a confined
 * writer would escape its worktree or reach a protected path.
 */
export function landingPath(p: string, depth = 0): string {
  const abs = resolve(p);
  let probe = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(probe), ...rest.reverse());
    } catch {
      // A dangling symlink: writeFile follows it and creates the target.
      try {
        if (depth < 40 && lstatSync(probe).isSymbolicLink()) {
          return landingPath(join(resolve(dirname(probe), readlinkSync(probe)), ...rest.reverse()), depth + 1);
        }
      } catch {
        /* doesn't exist at all — keep walking up */
      }
      const parent = dirname(probe);
      if (parent === probe) return abs;
      rest.push(probe.slice(parent.length).replace(/^[\\/]+/, ""));
      probe = parent;
    }
  }
}

/** Repo-relative POSIX path for an absolute or cwd-relative path. */
export function repoRelative(root: string, p: string, cwd = root): string {
  return toPosix(relative(root, resolve(cwd, p)));
}

/**
 * The main repository root, even when called from inside a linked worktree
 * (`.worktrees/issue-42`). All agents must share ONE state file and ONE
 * manifest — resolving from process.cwd() silently forked them per worktree.
 */
export function findRepoRoot(cwd: string = process.cwd()): string {
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    const commonAbs = resolve(cwd, common);
    if (commonAbs.endsWith(`${sep}.git`) || commonAbs.endsWith("/.git")) return dirname(commonAbs);
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    if (top) return resolve(top);
  } catch {
    /* not a git repo — fall through */
  }
  return resolve(cwd);
}

export function isoNow(): string {
  return new Date().toISOString();
}
