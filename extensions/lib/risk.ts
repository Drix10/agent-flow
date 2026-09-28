/**
 * Risk-surface audit.
 *
 * Fixes over v1.0.2:
 *  - EVERY dependency is a surface (keyed per package), so "a new dependency
 *    appeared" is detected. v1.0.2 keyed deps by manifest file, so adding
 *    `stripe` to an existing package.json was never reported as new.
 *  - Parses package.json, requirements*.txt, pyproject.toml, go.mod,
 *    Cargo.toml and Gemfile (v1.0.2 globbed them but only parsed package.json).
 *  - Line-level, word-bounded patterns: `map.delete(` and `author` no longer
 *    light up every file in the repo. Alert fatigue kills audits.
 *  - Secret detection (values are NEVER echoed — only kind + line).
 *  - Baseline accept never silently wipes: omitted keys = accept current set.
 */

import { basename, join } from "node:path";
import { atomicWrite, isoNow, readJson, readTextFile, walk } from "./fsutil.js";

export type SurfaceType = "dependency" | "auth" | "payment" | "data-mutation" | "external-api" | "exec" | "secret";

export interface RiskSurface {
  key: string;
  type: SurfaceType;
  path: string;
  detail: string;
  lines?: number[];
  firstSeen: string;
}

export interface RiskBaseline {
  version: string;
  lastScan: string;
  surfaces: RiskSurface[];
}

export const BASELINE_FILE = ".risk-baseline.json";

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|rb|php|cs|swift|scala|ex|exs|sql|sh|bash|ps1)$/i;
const TEST_FILE = /(^|\/)(__tests__|__mocks__|tests?|spec|fixtures?|e2e)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/i;

/** Word-bounded, line-level. Each hit records the line numbers (first 5). */
export const CODE_PATTERNS: Record<Exclude<SurfaceType, "dependency" | "secret">, RegExp[]> = {
  auth: [
    /\b(jwt|jsonwebtoken|oauth2?|openid|saml|bcrypt|argon2|scrypt|passport|next-auth|authjs)\b/i,
    /\b(authenticate|authorize|verify_?token|verifyToken|sign_?in|signIn|login|logout)\s*\(/i,
    /\b(session_?secret|sessionSecret|api_?key|apiKey|access_?token|accessToken|refresh_?token|refreshToken|password_?hash|passwordHash)\b/i,
  ],
  payment: [
    /\b(stripe|paypal|braintree|adyen|razorpay|paddle|lemonsqueezy|chargebee|recurly)\b/i,
    /\b(create_?payment|createPayment|payment_?intent|paymentIntent|create_?charge|createCharge|refund|payout|invoice)\w*\s*\(/i,
  ],
  "data-mutation": [
    /\b(DROP\s+(TABLE|DATABASE|SCHEMA|INDEX)|TRUNCATE\s+(TABLE\s+)?\w|DELETE\s+FROM|ALTER\s+TABLE|UPDATE\s+\w+\s+SET)\b/i,
    /\.(destroy|deleteMany|delete_many|bulkDelete|bulk_delete|dropCollection|drop_table|truncate)\s*\(/,
    /\b(rm\s+-rf|fs\.rm(Sync)?\s*\(|rmSync\s*\(|shutil\.rmtree|os\.remove|os\.unlink|fs\.unlink(Sync)?\s*\()/,
  ],
  "external-api": [
    /(^|[^.\w])fetch\s*\(\s*[`'"]?https?:/,
    /\b(axios|got|ky|superagent|undici)(\.(get|post|put|patch|delete|request))?\s*\(/,
    /\bhttps?\.(request|get)\s*\(/,
    /\brequests\.(get|post|put|patch|delete|request)\s*\(/,
    /\bhttpx\.(get|post|put|patch|delete|AsyncClient|Client)\b/,
    /\bhttp\.(Get|Post|NewRequest|DefaultClient)\b/,
    /\b(reqwest::|urllib\.request|new\s+WebSocket\s*\()/,
  ],
  exec: [
    /\b(child_process|execSync|execFileSync|spawnSync)\b/,
    /\bsubprocess\.(run|call|check_output|Popen)\s*\(/,
    /\bos\.system\s*\(/,
    /\bexec\.Command\s*\(/,
    /(^|[^.\w])eval\s*\(/,
  ],
};

/** High-signal secret shapes. We report the KIND and LINE only — never the value. */
const SECRET_PATTERNS: { kind: string; re: RegExp; unless?: RegExp }[] = [
  { kind: "AWS access key id", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "AWS secret access key", re: /\baws_?secret_?access_?key\b["']?\s*[:=]\s*["']?[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/i },
  { kind: "private key block", re: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY( BLOCK)?-----|PuTTY-User-Key-File-\d/ },
  { kind: "GitHub token", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { kind: "GitLab token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { kind: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "Slack webhook", re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/ },
  { kind: "Stripe live key", re: /\b(sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { kind: "Stripe webhook secret", re: /\bwhsec_[A-Za-z0-9]{24,}\b/ },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { kind: "OpenAI API key", re: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { kind: "Hugging Face token", re: /\bhf_[A-Za-z0-9]{34,}\b/ },
  { kind: "SendGrid API key", re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/ },
  { kind: "Twilio API key", re: /\bSK[0-9a-f]{32}\b/ },
  { kind: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { kind: "JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/ },
  {
    kind: "database URL with password",
    re: /\b(postgres(ql)?|mysql|mariadb|mongodb(\+srv)?|rediss?|amqps?|mssql|sqlserver):\/\/[^\s:@/]+:[^\s@/]{3,}@/i,
    // Placeholders and interpolation aren't secrets; docker-compose dev defaults are too common to block on.
    unless: /:\/\/[^\s:@/]+:(password|passwd|pass|secret|changeme|postgres|root|example|test|x+|\*+|\$\{?[^@]*\}?|%[^@]*%|<[^>@]*>|\{\{[^@]*\}\})@/i,
  },
];

/** Secret kinds + line numbers in a blob of text. Never returns the matched value. */
export function findSecrets(content: string): { kind: string; lines: number[] }[] {
  const lines = content.split(/\r?\n/);
  const out: { kind: string; lines: number[] }[] = [];
  for (const { kind, re, unless } of SECRET_PATTERNS) {
    const hit: number[] = [];
    lines.forEach((l, i) => {
      if (hit.length < 5 && l.length < 20_000 && re.test(l) && !(unless && unless.test(l))) hit.push(i + 1);
    });
    if (hit.length) out.push({ kind, lines: hit });
  }
  return out;
}

const ENV_FILE = /(^|\/)\.env(\.[\w-]+)?$/;
const ENV_TEMPLATE = /\.(example|sample|template|dist|defaults)$/i;

/** A real environment file (`.env`, `.env.production`), not a checked-in template. */
export function isEnvFile(path: string): boolean {
  return ENV_FILE.test(path) && !ENV_TEMPLATE.test(path);
}

// ---------------------------------------------------------------------------
// Dependency parsing (heuristic, documented as such)
// ---------------------------------------------------------------------------

export function parseDependencies(file: string, content: string): string[] {
  const name = basename(file);
  const deps = new Set<string>();
  try {
    if (name === "package.json") {
      const pkg = JSON.parse(content);
      for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        for (const d of Object.keys(pkg[field] ?? {})) deps.add(d);
      }
    } else if (/^requirements.*\.txt$/.test(name)) {
      for (const line of content.split(/\r?\n/)) {
        const l = line.replace(/#.*/, "").trim();
        if (!l || l.startsWith("-")) continue;
        const m = l.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
        if (m) deps.add(m[1].toLowerCase());
      }
    } else if (name === "pyproject.toml") {
      const arr = content.match(/^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m);
      for (const m of arr?.[1].matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)/g) ?? []) deps.add(m[1].toLowerCase());
      const poetry = content.match(/\[tool\.poetry\.(?:dev-)?dependencies\]([\s\S]*?)(\n\[|$)/);
      for (const m of poetry?.[1].matchAll(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/gm) ?? []) {
        if (m[1] !== "python") deps.add(m[1].toLowerCase());
      }
    } else if (name === "go.mod") {
      const block = content.match(/require\s*\(([\s\S]*?)\)/g) ?? [];
      for (const b of block) for (const m of b.matchAll(/^\s*([\w.\-/]+)\s+v/gm)) deps.add(m[1]);
      for (const m of content.matchAll(/^require\s+([\w.\-/]+)\s+v/gm)) deps.add(m[1]);
    } else if (name === "Cargo.toml") {
      for (const sec of content.matchAll(/\[(?:dev-|build-)?dependencies\]([\s\S]*?)(?=\n\[|$)/g)) {
        for (const m of sec[1].matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)) deps.add(m[1]);
      }
    } else if (name === "Gemfile") {
      for (const m of content.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)) deps.add(m[1]);
    }
  } catch {
    /* malformed manifest — reported as zero deps, never crashes the audit */
  }
  return [...deps].sort();
}

const DEP_MANIFEST = /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile)$/;
export const isDependencyManifest = (p: string) => DEP_MANIFEST.test(p);

function depCategory(dep: string): SurfaceType | null {
  if (/(^|[-_/@])(stripe|paypal|braintree|adyen|razorpay|paddle|chargebee|recurly|payments?|billing)([-_/]|$)/i.test(dep)) return "payment";
  if (/(^|[-_/@])(auth|jwt|jsonwebtoken|oauth2?|passport|bcrypt|argon2|openid|saml|jose|next-auth|keycloak|auth0|clerk|lucia)([-_/]|$)/i.test(dep)) return "auth";
  return null;
}

// ---------------------------------------------------------------------------

export interface AuditOptions {
  includeTests?: boolean;
  maxFiles?: number;
}

export interface AuditScan {
  surfaces: RiskSurface[];
  scannedFiles: number;
  truncated: boolean;
}

export function scanRiskSurfaces(root: string, opts: AuditOptions = {}): AuditScan {
  const now = isoNow();
  const surfaces = new Map<string, RiskSurface>();
  const add = (s: Omit<RiskSurface, "firstSeen">) => {
    if (!surfaces.has(s.key)) surfaces.set(s.key, { ...s, firstSeen: now });
  };

  const { files, truncated } = walk(root, { maxFiles: opts.maxFiles ?? 50_000 });
  let scanned = 0;

  for (const file of files) {
    const isTest = TEST_FILE.test(file);

    if (isEnvFile(file)) {
      add({ key: `secret:${file}:env-file`, type: "secret", path: file, detail: "environment file present in working tree (check it is not committed)" });
    }

    if (isDependencyManifest(file)) {
      const content = readTextFile(join(root, file));
      if (content !== null) {
        for (const dep of parseDependencies(file, content)) {
          add({ key: `dependency:${file}:${dep}`, type: "dependency", path: file, detail: `Dependency: ${dep}` });
          const cat = depCategory(dep);
          if (cat) add({ key: `${cat}:${file}:${dep}`, type: cat, path: file, detail: `Dependency: ${dep}` });
        }
      }
    }

    const wantCode = SOURCE_EXT.test(file) && (opts.includeTests || !isTest);
    const content = readTextFile(join(root, file));
    if (content === null) continue;
    scanned++;
    const lines = content.split(/\r?\n/);

    // Secrets: every text file, tests included (test fixtures leak real keys too).
    for (const { kind, lines: hit } of findSecrets(content)) {
      add({ key: `secret:${file}:${kind}`, type: "secret", path: file, detail: `Possible ${kind} (value redacted)`, lines: hit });
    }

    if (!wantCode) continue;
    for (const [type, patterns] of Object.entries(CODE_PATTERNS) as [SurfaceType, RegExp[]][]) {
      const hit: number[] = [];
      lines.forEach((l, i) => {
        if (hit.length < 5 && l.length < 2000 && patterns.some((p) => p.test(l))) hit.push(i + 1);
      });
      if (hit.length) add({ key: `${type}:${file}`, type, path: file, detail: `${type} pattern`, lines: hit });
    }
  }

  return { surfaces: [...surfaces.values()].sort((a, b) => a.key.localeCompare(b.key)), scannedFiles: scanned, truncated };
}

function baselineKey(s: Partial<RiskSurface>): string {
  // v1.0.2 baselines had no `key`; reconstruct the same shape they were compared by.
  if (s.key) return s.key;
  const dep = s.detail?.match(/^Dependency: (.+)$/)?.[1];
  return dep ? `${s.type}:${s.path}:${dep}` : `${s.type}:${s.path}`;
}

export function readBaseline(path: string): { ok: true; value: RiskBaseline | null } | { ok: false; error: string } {
  const r = readJson<RiskBaseline>(path);
  if (!r.ok) return r.error.startsWith("cannot read") ? { ok: true, value: null } : { ok: false, error: r.error };
  if (!Array.isArray(r.value?.surfaces)) return { ok: false, error: `${path}: baseline has no surfaces array` };
  return { ok: true, value: r.value };
}

export interface AuditResult {
  totalSurfaces: number;
  newSurfaces: number;
  resolvedSurfaces: number;
  baselineExists: boolean;
  scannedFiles: number;
  truncated: boolean;
  byType: Record<string, number>;
  newSurfacesList: RiskSurface[];
  resolvedList: string[];
  surfaces: RiskSurface[];
}

export function auditRisk(root: string, baselinePath: string, opts: AuditOptions = {}): AuditResult {
  const scan = scanRiskSurfaces(root, opts);
  const base = readBaseline(baselinePath);
  if (!base.ok) throw new Error(base.error);
  const baseKeys = new Map((base.value?.surfaces ?? []).map((s) => [baselineKey(s), s]));
  // Preserve the original firstSeen for known surfaces.
  for (const s of scan.surfaces) {
    const known = baseKeys.get(s.key);
    if (known?.firstSeen) s.firstSeen = known.firstSeen;
  }
  const current = new Set(scan.surfaces.map((s) => s.key));
  const newList = base.value ? scan.surfaces.filter((s) => !baseKeys.has(s.key)) : scan.surfaces;
  const resolved = [...baseKeys.keys()].filter((k) => !current.has(k));
  const byType: Record<string, number> = {};
  for (const s of scan.surfaces) byType[s.type] = (byType[s.type] ?? 0) + 1;
  return {
    totalSurfaces: scan.surfaces.length,
    newSurfaces: newList.length,
    resolvedSurfaces: resolved.length,
    baselineExists: base.value !== null,
    scannedFiles: scan.scannedFiles,
    truncated: scan.truncated,
    byType,
    newSurfacesList: newList,
    resolvedList: resolved,
    surfaces: scan.surfaces,
  };
}

/**
 * Accept surfaces into the baseline. `acceptKeys` undefined → accept the full
 * current scan (after human review). Otherwise baseline = previously accepted
 * surfaces that still exist + the listed new keys. Unknown keys are rejected.
 */
export function updateBaseline(root: string, baselinePath: string, acceptKeys?: string[], opts: AuditOptions = {}) {
  const audit = auditRisk(root, baselinePath, opts);
  const byKey = new Map(audit.surfaces.map((s) => [s.key, s]));
  let chosen: RiskSurface[];
  if (acceptKeys === undefined) {
    chosen = audit.surfaces;
  } else {
    const unknown = acceptKeys.filter((k) => !byKey.has(k));
    if (unknown.length) throw new Error(`unknown surface keys (re-run risk_audit): ${unknown.join(", ")}`);
    const newKeys = new Set(audit.newSurfacesList.map((s) => s.key));
    const accepted = new Set(acceptKeys);
    chosen = audit.surfaces.filter((s) => !newKeys.has(s.key) || accepted.has(s.key));
  }
  const baseline: RiskBaseline = { version: "2", lastScan: isoNow(), surfaces: chosen };
  atomicWrite(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
  return {
    updated: baselinePath,
    count: chosen.length,
    stillUnaccepted: audit.surfaces.length - chosen.length,
    dropped: audit.resolvedList.length,
  };
}
