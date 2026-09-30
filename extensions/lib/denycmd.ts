/**
 * Opt-in command policy: `policy.deny_commands` names presets (`database`, `infra`) and custom regexes that the guard
 * refuses in every agent session. A headless pipeline has nobody to answer an "ask", so the answer is deny; a human
 * overrides with the same variable as protected paths (AGENT_FLOW_ALLOW_PROTECTED=1).
 *
 * Best-effort like all shell analysis: it reads the command text (and the text of `sh -c '…'`), it can't see a command
 * built at run time. Presets are conservative: destructive verbs on a named CLI, not "any use of the CLI".
 */

import type { ContextManifest } from "./manifest.js";

/** `sudo -u x`, `env A=b`, `command`, `nohup`, `xargs`, `A=b`, and a path prefix: what can sit in front of the program. */
const PRE = String.raw`^(?:(?:(?:sudo|doas|command|exec|nohup|time|nice|env|xargs|watch|timeout)(?:\s+-\S+(?:\s+[^\s-]\S*)?)*|[A-Za-z_]\w*=\S*)\s+)*(?:\S*/)?`;
const cli = (names: string) => new RegExp(`${PRE}(?:${names})(?:\\.exe)?\\b`, "i");

/**
 * Presets match one command segment at a time (split on unquoted `; | & newline`, quotes and backslashes removed), each
 * anchored at the segment start: linear time, and `git commit -m "kubectl delete docs"` or `echo terraform destroy` don't match.
 */
export const PRESETS: Record<string, { description: string; segment: RegExp[]; /** Each group matches when all its regexes match anywhere in the command (linear: no regex spans the whole text). */ whole?: RegExp[][] }> = {
  database: {
    description: "DROP / TRUNCATE through the psql, mysql, mariadb, sqlite3, sqlcmd, mongosh and redis-cli shells",
    segment: [
      new RegExp(`${PRE}(?:psql|mysql|mariadb|sqlite3|sqlcmd|mongosh|redis-cli)(?:\\.exe)?\\b.*?(?:\\bdrop\\s+(?:table|database|schema|index|view)\\b|\\btruncate\\s+(?!-)\\S|\\bflush(?:all|db)\\b|\\bdropDatabase\\b|\\.drop\\s*\\()`, "i"),
      new RegExp(`${PRE}(?:dropdb|mysqladmin\\s+(?:-\\S+\\s+)*drop)\\b`, "i"),
    ],
    // `echo "DROP TABLE t" | psql`, `psql <<EOF … DROP …`: the SQL and the shell are in different segments.
    whole: [
      [/\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/i, /\|\s*(?:sudo\s+)?(?:\S*\/)?(?:psql|mysql|mariadb|sqlite3|sqlcmd)\b/i],
      [/(?:^|\n)\s*(?:sudo\s+)?(?:\S*\/)?(?:psql|mysql|mariadb|sqlite3|sqlcmd)\b[^\n]*<<-?/i, /\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/i],
    ],
  },
  infra: {
    description: "kubectl delete, terraform/pulumi destroy, docker prune, helm uninstall, cloud CLI deletes",
    segment: [
      new RegExp(`${PRE}(?:kubectl|oc)\\b.*?\\sdelete(?:\\s|$)`, "i"),
      new RegExp(`${PRE}(?:terraform|tofu|terragrunt)\\b(?!.*\\splan\\b).*?\\s(?:destroy|-destroy)(?:\\s|$)`, "i"),
      new RegExp(`${PRE}pulumi\\s+destroy\\b`, "i"),
      new RegExp(`${PRE}docker\\b.*?\\s(?:system|volume|image|container|network|builder)\\s+prune\\b`, "i"),
      new RegExp(`${PRE}helm\\b.*?\\s(?:uninstall|delete)(?:\\s|$)`, "i"),
      new RegExp(`${PRE}aws\\s+s3\\s+(?:rb\\b|rm\\b.*--recursive)`, "i"),
      new RegExp(`${PRE}(?:gcloud|az)\\b.*?\\sdelete(?:\\s|$)`, "i"),
    ],
  },
};

/** Split on unquoted `; | & newline`, then drop quotes and backslashes so `kub"ectl" del\ete` reads as `kubectl delete`. */
export function segmentsOf(cmd: string): string[] {
  const src = cmd.replace(/\\\r?\n/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  const flush = () => {
    const t = cur.replace(/["'\\]/g, "").replace(/\s+/g, " ").trim();
    if (t) out.push(t);
    cur = "";
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"') i++;
      cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ";" || c === "|" || c === "&" || c === "\n" || c === "(" || c === ")") flush();
    else cur += c;
  }
  flush();
  return out;
}

export interface DenyCommands {
  presets?: string[];
  patterns?: { pattern: string; message?: string }[];
}

export function denyCommandsOf(man: ContextManifest | null | undefined): DenyCommands | null {
  const d = (man as { policy?: { deny_commands?: unknown } } | null | undefined)?.policy?.deny_commands;
  // Shorthand `["infra"]` means `{"presets": ["infra"]}`: a rule the author plainly meant must not silently load nothing.
  if (Array.isArray(d)) return { presets: d.filter((x): x is string => typeof x === "string") };
  return d && typeof d === "object" ? (d as DenyCommands) : null;
}

export function validateDenyCommands(d: unknown): string[] {
  if (d === undefined) return [];
  if (Array.isArray(d)) return validateDenyCommands({ presets: d });
  if (!d || typeof d !== "object") return ["policy.deny_commands must be an object like {\"presets\": [\"database\"], \"patterns\": []}"];
  const s = d as DenyCommands;
  const problems: string[] = [];
  for (const k of Object.keys(s)) if (k !== "presets" && k !== "patterns") problems.push(`policy.deny_commands.${k} is not a known key (presets, patterns)`);
  if (s.presets !== undefined) {
    if (!Array.isArray(s.presets) || s.presets.some((p) => typeof p !== "string" || !Object.hasOwn(PRESETS, p))) problems.push(`policy.deny_commands.presets must be a list of: ${Object.keys(PRESETS).join(", ")}`);
  }
  if (s.patterns !== undefined) {
    if (!Array.isArray(s.patterns)) problems.push("policy.deny_commands.patterns must be an array");
    else
      s.patterns.forEach((p, i) => {
        const w = `policy.deny_commands.patterns[${i}]`;
        if (!p || typeof p.pattern !== "string" || !p.pattern || p.pattern.length > 500) return void problems.push(`${w}.pattern must be a regular expression string of at most 500 characters`);
        if (unsafeRegex(p.pattern)) return void problems.push(`${w}.pattern has a quantifier inside a quantified group, which can hang the guard (catastrophic backtracking); simplify it`);
        for (const k of Object.keys(p)) if (k !== "pattern" && k !== "message") problems.push(`${w}.${k} is not a known key (pattern, message)`);
        try {
          new RegExp(p.pattern, "i");
        } catch (e: any) {
          problems.push(`${w}.pattern is not a valid regular expression: ${e.message}`);
        }
        if (p.message !== undefined && typeof p.message !== "string") problems.push(`${w}.message must be a string`);
      });
  }
  return problems;
}

/** Union of several manifests' deny_commands: a working copy may add to what the default branch committed, never remove. */
export function unionDenyCommands(...mans: (ContextManifest | null | undefined)[]): DenyCommands | null {
  const presets = new Set<string>();
  const pats = new Map<string, { pattern: string; message?: string }>();
  let any = false;
  for (const m of mans) {
    const d = denyCommandsOf(m);
    if (!d) continue;
    any = true;
    for (const p of Array.isArray(d.presets) ? d.presets : []) if (typeof p === "string") presets.add(p);
    for (const p of Array.isArray(d.patterns) ? d.patterns : []) if (p && typeof p.pattern === "string") pats.set(p.pattern, p);
  }
  return any ? { presets: [...presets], patterns: [...pats.values()] } : null;
}

/** A quantifier inside a quantified group, `(a+)+`: the classic way to make a regex run for minutes. */
export function unsafeRegex(pattern: string): boolean {
  return /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(pattern);
}

const MAX_SEGMENT = 8000;

/** Why `cmd` is refused, or null. */
export function matchDenyCommand(spec: DenyCommands | null, cmd: string): string | null {
  if (!spec) return null;
  const segs = segmentsOf(cmd);
  const flat = segs.join(" ; ");
  for (const name of Array.isArray(spec.presets) ? spec.presets : []) {
    const preset = Object.hasOwn(PRESETS, name) ? PRESETS[name] : undefined;
    if (!preset) continue;
    if (segs.some((sg) => preset.segment.some((re) => re.test(sg))) || (preset.whole ?? []).some((group) => group.every((re) => re.test(cmd) || re.test(flat)))) {
      return `matches the "${name}" preset of policy.deny_commands (${preset.description})`;
    }
  }
  for (const p of Array.isArray(spec.patterns) ? spec.patterns : []) {
    if (!p || typeof p.pattern !== "string" || p.pattern.length > 500 || unsafeRegex(p.pattern)) continue;
    try {
      const re = new RegExp(p.pattern, "i");
      // Bounded input: a user regex can't be made to run long by padding a segment.
      if ([cmd.slice(0, MAX_SEGMENT), ...segs.map((x) => x.slice(0, MAX_SEGMENT))].some((x) => re.test(x))) return p.message ? p.message : `matches policy.deny_commands pattern /${p.pattern}/`;
    } catch {
      /* reported by validation */
    }
  }
  return null;
}
