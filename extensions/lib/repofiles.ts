/**
 * The files of a repository, for scans.
 *
 * In a git checkout the answer is git's own: tracked plus untracked-but-not-ignored. Walking the disk instead
 * descends into whatever `.gitignore` excludes (a 7 GB `data/` directory, build caches, vendored trees) and
 * turns a sub-second scan into minutes. Outside git, or when the root isn't the repository's top level, it
 * falls back to the directory walk.
 */

import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { CASE_INSENSITIVE_FS, IGNORED_DIRS, WalkOptions, WalkResult, escapesBase, linksToRepoFile, toPosix, walk } from "./fsutil.js";
import { git } from "./git.js";

function isRepoTop(root: string): boolean {
  const top = git(["rev-parse", "--show-toplevel"], root, 10_000);
  if (!top.ok || !top.stdout) return false;
  try {
    // `.native` expands Windows 8.3 short names (RUNNER~1), which git reports in long form.
    const norm = (p: string) => (CASE_INSENSITIVE_FS ? p.toLowerCase() : p);
    return norm(realpathSync.native(resolve(top.stdout))) === norm(realpathSync.native(root));
  } catch {
    return false;
  }
}

export function listRepoFiles(root: string, opts: WalkOptions = {}): WalkResult {
  if (!isRepoTop(root)) return walk(root, opts);
  const listed = git(["-c", "core.quotepath=off", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], root, 120_000);
  if (!listed.ok) return walk(root, opts);

  const maxFiles = opts.maxFiles ?? 50_000;
  const skip = new Set([...IGNORED_DIRS, ...(opts.ignoreDirs ?? [])]);
  const seen = new Set<string>();
  const files: string[] = [];
  let truncated = false;
  // A tracked directory swapped for a symlink to somewhere else would let git's list lead outside the repo.
  const rootReal = realpathSync.native(root);
  const dirInside = new Map<string, boolean>();
  const insideRoot = (dir: string): boolean => {
    let ok = dirInside.get(dir);
    if (ok === undefined) {
      try {
        ok = !escapesBase(relative(rootReal, realpathSync.native(join(root, dir))));
      } catch {
        ok = false;
      }
      dirInside.set(dir, ok);
    }
    return ok;
  };
  for (const raw of listed.stdout.split("\0")) {
    if (!raw) continue;
    // git prints names verbatim; only Windows separators need converting (a backslash is a legal POSIX filename character).
    const rel = process.platform === "win32" ? toPosix(raw) : raw;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const segs = rel.split("/");
    if (segs.slice(0, -1).some((s) => skip.has(s))) continue;
    if (!insideRoot(dirname(rel) === "." ? "" : dirname(rel))) continue;
    let st;
    try {
      st = lstatSync(join(root, rel));
    } catch {
      continue; // tracked but deleted in the working tree
    }
    if (st.isSymbolicLink()) {
      if (!opts.linkedFiles || !linksToRepoFile(root, rel)) continue;
    } else if (!st.isFile()) continue; // a submodule's directory
    if (opts.filter && !opts.filter(rel)) continue;
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
    files.push(rel);
  }
  files.sort();
  return { files, truncated };
}
