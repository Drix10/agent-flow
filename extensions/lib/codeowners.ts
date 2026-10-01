/**
 * The guard stops an agent editing protected paths on the machine it runs on. A pull request can still change
 * them; only the host can refuse that (CODEOWNERS plus "require review from Code Owners"). This checks that the
 * repo has a CODEOWNERS entry over each protected path, nothing about whether the host enforces it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FILES = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/^\*\*\//, "");
/** Literal directory part of a glob: `docs/**` → `docs`, `.github/workflows/*.yml` → `.github/workflows`, `a/b.txt` → `a/b.txt`. */
const literalDir = (g: string) => {
  const n = norm(g);
  const i = n.search(/[*?[]/);
  if (i < 0) return n.replace(/\/$/, "");
  return n.slice(0, i).replace(/[^/]*$/, "").replace(/\/$/, "");
};

/** Non-comment CODEOWNERS lines as [pattern, ownerCount]. An owner-less line un-owns the path on GitHub. */
export function codeownersRules(root: string): [string, number][] | null {
  for (const f of FILES) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    return readFileSync(p, "utf-8")
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*$/, "").trim().split(/\s+/))
      .filter((w) => w[0])
      .map((w) => [w[0], w.length - 1] as [string, number]);
  }
  return null;
}

/** Does CODEOWNERS pattern `raw` own everything under the protected glob `g`? Segment-wise, never by string prefix. */
function covers(raw: string, g: string): boolean {
  const p = norm(raw);
  if (p === "*" || p === "**" || p === "**/*" || p === "") return true;
  const gd = literalDir(g);
  const wide = /(\*\*|\/)$/.test(raw) || /^[^*?[]*$/.test(p) && !p.includes("."); // `dir/`, `dir/**`, or a bare directory name
  const pd = literalDir(p);
  if (p === norm(g)) return true;
  // A directory rule owns every descendant; a single-star rule (`docs/*`) owns direct children only.
  if (/\/\*$/.test(p) && !/\*\*/.test(p)) return gd === pd && /\*\*/.test(g) === false;
  if (!wide && !/\*\*/.test(p)) return false;
  return pd === "" ? false : gd === pd || gd.startsWith(`${pd}/`);
}

/** Protected globs that no CODEOWNERS entry covers. `null` when there is no CODEOWNERS file at all. */
export function uncoveredProtected(root: string, protectedPaths: string[]): string[] | null {
  const rules = codeownersRules(root);
  if (rules === null) return null;
  // Last matching rule wins on GitHub: an owner-less match un-owns.
  return protectedPaths.filter((g) => {
    let owned = false;
    for (const [raw, owners] of rules) if (covers(raw, g)) owned = owners > 0;
    return !owned;
  });
}
