/**
 * Git operations. Every call uses execFile with an argv array — never a shell
 * string. v1.0.2 interpolated a model-supplied `baseBranch` into
 * `execSync(\`git worktree add ... ${baseBranch}\`)`, i.e. arbitrary command
 * execution via a tool parameter.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { toPosix } from "./fsutil.js";

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function git(args: string[], cwd: string, timeout = 60_000): GitResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true, stdout: stdout.trimEnd(), stderr: "" };
  } catch (e: any) {
    return { ok: false, stdout: e.stdout?.toString?.().trimEnd() ?? "", stderr: (e.stderr?.toString?.() ?? e.message ?? "").trim() };
  }
}

export function mustGit(args: string[], cwd: string): string {
  const r = git(args, cwd);
  if (!r.ok) throw new Error(`git ${args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? args[0]} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** Reject anything git itself would not accept as a branch name (and option-looking values). */
export function validateBranchName(name: string, cwd: string): string {
  if (typeof name !== "string" || !name || name.startsWith("-") || /[\s\0]/.test(name)) {
    throw new Error(`invalid branch name: ${JSON.stringify(name)}`);
  }
  const r = git(["check-ref-format", "--branch", name], cwd);
  if (!r.ok) throw new Error(`invalid branch name: ${JSON.stringify(name)}`);
  return name;
}

/** origin/HEAD → main/master → current branch. v1.0.2 hardcoded "main" (and the PR step "develop"). */
export function defaultBranch(root: string): string {
  const sym = git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], root);
  if (sym.ok && sym.stdout) return sym.stdout.replace(/^origin\//, "");
  for (const b of ["main", "master", "trunk", "develop"]) {
    if (git(["show-ref", "--verify", "--quiet", `refs/heads/${b}`], root).ok) return b;
  }
  const cur = git(["rev-parse", "--abbrev-ref", "HEAD"], root);
  if (cur.ok && cur.stdout && cur.stdout !== "HEAD") return cur.stdout;
  throw new Error("cannot determine a default branch (no origin/HEAD, main, master, or checked-out branch)");
}

/**
 * A revision to diff against when nothing names one. CI checkouts (a PR build is a detached HEAD
 * with no local `main` and often no `origin/HEAD`) fail `defaultBranch`; the remote-tracking ref
 * `actions/checkout` fetched is still a perfectly good base.
 */
export function defaultBase(root: string): string {
  try {
    return defaultBranch(root);
  } catch (e) {
    for (const b of ["main", "master", "trunk", "develop"]) {
      if (git(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${b}`], root).ok) return `origin/${b}`;
    }
    throw e;
  }
}

export function gitCommonDir(root: string): string {
  return resolve(root, mustGit(["rev-parse", "--git-common-dir"], root));
}

/** Keep agent scratch out of `git status` without touching the user's committed .gitignore. */
export function ensureLocalExcludes(root: string, entries: string[]): string[] {
  const excludePath = join(gitCommonDir(root), "info", "exclude");
  mkdirSync(dirname(excludePath), { recursive: true });
  const current = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
  const lines = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const added = entries.filter((e) => !lines.has(e));
  if (added.length) {
    const prefix = current && !current.endsWith("\n") ? "\n" : "";
    appendFileSync(excludePath, `${prefix}# agent-flow (local only)\n${added.join("\n")}\n`, "utf-8");
  }
  return added;
}

/** A revision passed as argv must never look like an option (`--output=/etc/x` writes files). */
export function validateRevision(rev: string): string {
  if (typeof rev !== "string" || !/^[A-Za-z0-9_][\w./@^~{}-]*$/.test(rev) || rev.includes("..")) {
    throw new Error(`invalid git revision: ${JSON.stringify(rev)}`);
  }
  return rev;
}

/** The `git diff` range for a change: `base...head`, or the working tree against the merge-base with `base`. */
function diffRange(cwd: string, base: string, head?: string): string[] {
  validateRevision(base);
  if (head) validateRevision(head);
  if (head) return [`${base}...${head}`];
  // Diffing against the base branch's tip instead would count every commit landed on main after this branch was cut.
  const mb = git(["merge-base", base, "HEAD"], cwd);
  return [mb.ok && mb.stdout ? mb.stdout : base];
}

export function changedFiles(cwd: string, base: string, head?: string): string[] {
  const out = new Set<string>();
  for (const f of nameList(["diff", "--name-only", "--no-renames", ...diffRange(cwd, base, head)], cwd)) out.add(f);
  if (!head) {
    for (const f of nameList(["ls-files", "--others", "--exclude-standard"], cwd)) out.add(f);
  }
  return [...out].sort();
}

/** Lines added and removed per file (binary files: null), including untracked files when diffing the working tree. */
export function diffStats(cwd: string, base: string, head?: string): Map<string, { added: number; removed: number } | null> {
  const out = new Map<string, { added: number; removed: number } | null>();
  const raw = mustGit(["-c", "core.quotepath=off", "diff", "--numstat", "-z", "--no-renames", ...diffRange(cwd, base, head)], cwd);
  for (const rec of raw.split("\0").filter(Boolean)) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(rec);
    if (m) out.set(toPosix(m[3]), m[1] === "-" ? null : { added: Number(m[1]), removed: Number(m[2]) });
  }
  if (!head) {
    for (const f of nameList(["ls-files", "--others", "--exclude-standard"], cwd)) {
      try {
        const buf = readFileSync(join(cwd, f));
        out.set(f, buf.includes(0) ? null : { added: buf.toString("utf-8").split("\n").length - (buf.length && buf[buf.length - 1] === 10 ? 1 : 0), removed: 0 });
      } catch {
        out.set(f, null);
      }
    }
  }
  return out;
}

/** Text of the lines a change adds to one file (untracked files: the whole file); null when it can't be read (a diff past the buffer, a vanished file), which is not the same as nothing added. */
export function addedLines(cwd: string, file: string, base: string, head?: string): string[] | null {
  const tracked = git(["ls-files", "--error-unmatch", "--", file], cwd).ok;
  if (!tracked && !head) {
    try {
      const buf = readFileSync(join(cwd, file));
      return buf.includes(0) ? [] : buf.toString("utf-8").split("\n");
    } catch {
      return null;
    }
  }
  const r = git(["-c", "core.quotepath=off", "diff", "-U0", "--no-color", "--no-renames", ...diffRange(cwd, base, head), "--", file], cwd);
  return r.ok ? r.stdout.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)) : null;
}

/**
 * File names from a git listing command, NUL-separated. Without `-z`, git
 * C-quotes any non-ASCII name (`"notes \303\251.txt"`), which then matches no
 * protected path and can't be `git show`n — the file silently skips every check.
 */
export function nameList(args: string[], cwd: string): string[] {
  return mustGit(["-c", "core.quotepath=off", args[0], "-z", ...args.slice(1)], cwd)
    .split("\0")
    .filter(Boolean)
    .map(toPosix);
}

export function stagedFiles(cwd: string): string[] {
  return nameList(["diff", "--cached", "--name-only", "--no-renames", "--diff-filter=ACMRDT"], cwd);
}

/**
 * The staged (index) content of many files through ONE `git cat-file --batch`, instead of a
 * process per file: a pre-commit hook that takes minutes on a big merge gets bypassed.
 * Deleted or unreadable entries, and blobs above `maxBytes`, map to null.
 */
export function stagedBlobs(cwd: string, files: string[], maxBytes = 2_000_000): Map<string, Buffer | null> {
  const out = new Map<string, Buffer | null>();
  const names = files.filter((f) => !/[\n\0]/.test(f));
  for (const f of files) out.set(f, null);
  if (!names.length) return out;
  let buf: Buffer;
  try {
    buf = execFileSync("git", ["cat-file", "--batch"], {
      cwd,
      input: names.map((f) => `:${f}\n`).join(""),
      stdio: ["pipe", "pipe", "ignore"],
      maxBuffer: 1024 * 1024 * 1024,
      timeout: 300_000,
    });
  } catch {
    return out;
  }
  let at = 0;
  for (const name of names) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) break;
    const header = buf.toString("utf-8", at, nl);
    at = nl + 1;
    const m = header.match(/^\S+ (\w+) (\d+)$/);
    if (!m) continue; // "<name> missing" / "ambiguous": no body follows
    const size = Number(m[2]);
    if (m[1] === "blob" && size <= maxBytes) out.set(name, buf.subarray(at, at + size));
    at += size + 1;
  }
  return out;
}

/** The base a worktree branch was cut from, as recorded by `createWorktree`. */
export function recordedBase(cwd: string, branch?: string): string | null {
  const b = branch ?? git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).stdout;
  if (!b || b === "HEAD") return null;
  const r = git(["config", "--get", `branch.${b}.agentflowbase`], cwd);
  return r.ok && r.stdout ? r.stdout : null;
}
