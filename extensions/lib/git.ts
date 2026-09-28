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
  if (!r.ok) throw new Error(`git ${args[0]} failed: ${r.stderr || r.stdout}`);
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

export function changedFiles(cwd: string, base: string, head?: string): string[] {
  validateRevision(base);
  if (head) validateRevision(head);
  const out = new Set<string>();
  // Without a head we diff the working tree, but against the merge-base — not the
  // base branch's tip. Otherwise every commit landed on main after this branch was
  // cut shows up as "this branch's change" (false critical / protected hits).
  const mb = head ? null : git(["merge-base", base, "HEAD"], cwd);
  const range = head ? [`${base}...${head}`] : [mb?.ok && mb.stdout ? mb.stdout : base];
  for (const f of mustGit(["diff", "--name-only", "--no-renames", ...range], cwd).split("\n")) if (f) out.add(toPosix(f));
  if (!head) {
    for (const f of mustGit(["ls-files", "--others", "--exclude-standard"], cwd).split("\n")) if (f) out.add(toPosix(f));
  }
  return [...out].sort();
}

export function stagedFiles(cwd: string): string[] {
  return mustGit(["diff", "--cached", "--name-only", "--no-renames", "--diff-filter=ACMRDT"], cwd)
    .split("\n")
    .filter(Boolean)
    .map(toPosix);
}

/** The base a worktree branch was cut from, as recorded by `createWorktree`. */
export function recordedBase(cwd: string, branch?: string): string | null {
  const b = branch ?? git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).stdout;
  if (!b || b === "HEAD") return null;
  const r = git(["config", "--get", `branch.${b}.agentflowbase`], cwd);
  return r.ok && r.stdout ? r.stdout : null;
}
