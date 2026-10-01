/**
 * Keeping an installed agent-flow current, whichever way it got there (npm, npx, or the vendored runtime).
 *
 * Three jobs:
 *  - say when a newer version exists, rarely and politely (`latestVersion`, cached, never in CI or on the guard path);
 *  - say when the running CLI is newer than the copy a repo vendored (`vendoredVersion`), which needs no network;
 *  - record what `install` wrote, so `update` can tell "an older agent-flow file" (safe to replace) from "a file you
 *    edited" (never replaced without --force).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const VENDOR_DIR = ".agent-flow-runtime";
export const PACKAGE = "@drix10/agent-flow";
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** `1.2.3` → [1, 2, 3]; anything else (pre-releases, junk) → null, so it never counts as "newer". */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Is `a` strictly newer than `b`? False when either isn't a plain x.y.z. */
export function isNewer(a: string, b: string): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** The version of the runtime a repo vendored, or null when it has none. */
export function vendoredVersion(root: string): string | null {
  try {
    const v = JSON.parse(readFileSync(join(root, VENDOR_DIR, "package.json"), "utf-8")).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** SHA-256 over a file or a directory tree (sorted relative paths + contents), for "did anyone edit this?". */
export function hashTree(path: string): string | null {
  if (!existsSync(path)) return null;
  const h = createHash("sha256");
  const walk = (p: string, rel: string) => {
    if (statSync(p).isDirectory()) {
      for (const name of readdirSync(p).sort()) walk(join(p, name), rel ? `${rel}/${name}` : name);
    } else {
      h.update(`${rel}\0`);
      // Line endings differ between a Windows checkout and a Linux one; they are not an edit.
      h.update(readFileSync(p).toString("utf-8").replace(/\r\n/g, "\n"));
      h.update("\0");
    }
  };
  walk(path, "");
  return h.digest("hex");
}

export interface InstallRecord {
  version: string;
  harness: string;
  /** repo-relative path → hashTree() of what install wrote there */
  files: Record<string, string>;
}

/** The record lives beside the harness's skills (`.claude/agent-flow-install.json`), committed with them. */
export const recordPath = (root: string, skillsDir: string) => join(root, dirname(skillsDir), "agent-flow-install.json");

export function readRecord(root: string, skillsDir: string): InstallRecord | null {
  try {
    const r = JSON.parse(readFileSync(recordPath(root, skillsDir), "utf-8"));
    return r && typeof r.version === "string" && r.files && typeof r.files === "object" ? (r as InstallRecord) : null;
  } catch {
    return null;
  }
}

export function writeRecord(root: string, skillsDir: string, rec: InstallRecord): void {
  const p = recordPath(root, skillsDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(rec, null, 2)}\n`);
}

export type FileState = "up_to_date" | "upgrade" | "edited" | "new";

/**
 * Decide what `update` may do with one installed path.
 * `incoming` is the hash of the file the running agent-flow would write; `onDisk` what is there now;
 * `recorded` what install wrote last time (undefined if it never recorded).
 */
export function fileState(onDisk: string | null, incoming: string | null, recorded: string | undefined): FileState {
  if (onDisk === null) return "new";
  if (onDisk === incoming) return "up_to_date";
  // On disk is exactly what an earlier install wrote, so nobody edited it: replacing it loses nothing.
  if (recorded !== undefined && onDisk === recorded) return "upgrade";
  return "edited";
}

interface CacheFile {
  checkedAt: number;
  latest: string;
}

const cachePath = () => join(process.env.AGENT_FLOW_HOME ?? join(homedir(), ".agent-flow"), "update-check.json");

/** Should we even ask? Never in CI, offline mode, or when the user opted out. */
export function updateCheckAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return !(env.CI || env.AGENT_FLOW_OFFLINE === "1" || env.NO_UPDATE_NOTIFIER || env.AGENT_FLOW_NO_UPDATE_CHECK === "1");
}

/**
 * The newest published version, from a 24h cache or one quick registry request (2.5s cap). Null whenever it can't
 * be had cheaply: no network, slow registry, odd response. Callers print nothing in that case.
 */
export function latestVersion(opts: { now?: number; force?: boolean } = {}): string | null {
  const now = opts.now ?? Date.now();
  try {
    const c = JSON.parse(readFileSync(cachePath(), "utf-8")) as CacheFile;
    if (!opts.force && typeof c.latest === "string" && now - c.checkedAt < CACHE_TTL_MS) return c.latest;
  } catch {
    /* no cache yet */
  }
  const base = (process.env.AGENT_FLOW_REGISTRY ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
  // A separate short-lived process keeps this synchronous and lets a hung connection be killed outright.
  const script = `fetch(process.argv[1], { signal: AbortSignal.timeout(2200), headers: { accept: "application/vnd.npm.install-v1+json" } }).then((r) => (r.ok ? r.json() : Promise.reject())).then((j) => process.stdout.write(String(j["dist-tags"]?.latest ?? ""))).catch(() => process.exit(1));`;
  const r = spawnSync(process.execPath, ["-e", script, `${base}/${PACKAGE.replace("/", "%2f")}`], { encoding: "utf-8", timeout: 2500, stdio: ["ignore", "pipe", "ignore"] });
  const latest = r.status === 0 ? r.stdout.trim() : "";
  if (!parseVersion(latest)) return null;
  try {
    mkdirSync(dirname(cachePath()), { recursive: true });
    writeFileSync(cachePath(), JSON.stringify({ checkedAt: now, latest } satisfies CacheFile));
  } catch {
    /* a read-only home is fine: we just ask again next time */
  }
  return latest;
}

export interface UpdateNotice {
  kind: "vendored_behind" | "newer_published";
  message: string;
}

/**
 * The one line `doctor` may add. `running` is this CLI's version; `vendored` the repo's vendored runtime (or null).
 * The vendored comparison needs no network, so it runs even when update checks are off.
 */
export function updateNotice(root: string, running: string, opts: { check: boolean; latest?: string | null }): UpdateNotice | null {
  const vendored = vendoredVersion(root);
  if (vendored && isNewer(running, vendored)) {
    return { kind: "vendored_behind", message: `this repo's vendored agent-flow is ${vendored}; the CLI you ran is ${running}. Update it: npx ${PACKAGE}@latest update --yes` };
  }
  if (!opts.check) return null;
  const latest = opts.latest === undefined ? latestVersion() : opts.latest;
  if (!latest || !isNewer(latest, vendored ?? running)) return null;
  const have = vendored ?? running;
  const how = vendored ? `npx ${PACKAGE}@latest update --yes` : `npm i -D ${PACKAGE}@latest   (npx users: npx ${PACKAGE}@latest …)`;
  return { kind: "newer_published", message: `agent-flow ${latest} is available (${vendored ? "vendored here" : "you have"} ${have}). Update: ${how}` };
}
