/**
 * Opt-in command policy: `policy.deny_commands` names presets (`database`, `infra`) and custom regexes that the guard
 * refuses in every agent session. A headless pipeline has nobody to answer an "ask", so the answer is deny; a human
 * overrides with the same variable as protected paths (AGENT_FLOW_ALLOW_PROTECTED=1).
 *
 * Best-effort like all shell analysis: it reads the command text (and the text of `sh -c '…'`), it can't see a command
 * built at run time. Presets are conservative: destructive verbs on a named CLI, not "any use of the CLI".
 */

import type { ContextManifest } from "./manifest.js";

export const PRESETS: Record<string, { description: string; patterns: RegExp[] }> = {
  database: {
    description: "DROP / TRUNCATE through the psql, mysql, mariadb, sqlite3, sqlcmd and redis-cli/mongosh shells",
    patterns: [
      /\b(?:psql|mysql|mariadb|sqlite3|sqlcmd|mongosh|redis-cli)\b[^\n]*\b(?:drop\s+(?:table|database|schema|index|view)|truncate(?:\s+table)?|flushall|flushdb|dropdatabase|\.drop\s*\()/i,
      /\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b[^\n]*\|\s*(?:psql|mysql|mariadb|sqlite3|sqlcmd)\b/i,
      /\b(?:dropdb|mysqladmin\s+(?:-\S+\s+)*drop)\b/i,
    ],
  },
  infra: {
    description: "kubectl delete, terraform/pulumi destroy, docker prune, helm uninstall, cloud CLI deletes",
    patterns: [
      /\bkubectl\b[^|;&\n]*\bdelete\b/i,
      /\b(?:terraform|tofu|terragrunt)\b[^|;&\n]*\b(?:destroy|apply\s+[^|;&\n]*-destroy)\b/i,
      /\bpulumi\s+destroy\b/i,
      /\bdocker\s+(?:system|volume|image|container|network|builder)\s+prune\b/i,
      /\bhelm\s+(?:uninstall|delete)\b/i,
      /\baws\s+s3\s+(?:rb\b|rm\b[^|;&\n]*--recursive)/i,
      /\b(?:gcloud|az)\b[^|;&\n]*\bdelete\b/i,
    ],
  },
};

export interface DenyCommands {
  presets?: string[];
  patterns?: { pattern: string; message?: string }[];
}

export function denyCommandsOf(man: ContextManifest | null | undefined): DenyCommands | null {
  const d = (man as { policy?: { deny_commands?: unknown } } | null | undefined)?.policy?.deny_commands;
  return d && typeof d === "object" && !Array.isArray(d) ? (d as DenyCommands) : null;
}

export function validateDenyCommands(d: unknown): string[] {
  if (d === undefined) return [];
  if (!d || typeof d !== "object" || Array.isArray(d)) return ["policy.deny_commands must be an object like {\"presets\": [\"database\"], \"patterns\": []}"];
  const s = d as DenyCommands;
  const problems: string[] = [];
  if (s.presets !== undefined) {
    if (!Array.isArray(s.presets) || s.presets.some((p) => typeof p !== "string" || !Object.hasOwn(PRESETS, p))) problems.push(`policy.deny_commands.presets must be a list of: ${Object.keys(PRESETS).join(", ")}`);
  }
  if (s.patterns !== undefined) {
    if (!Array.isArray(s.patterns)) problems.push("policy.deny_commands.patterns must be an array");
    else
      s.patterns.forEach((p, i) => {
        const w = `policy.deny_commands.patterns[${i}]`;
        if (!p || typeof p.pattern !== "string" || !p.pattern || p.pattern.length > 500) return void problems.push(`${w}.pattern must be a regular expression string of at most 500 characters`);
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

/** Why `cmd` is refused, or null. */
export function matchDenyCommand(spec: DenyCommands | null, cmd: string): string | null {
  if (!spec) return null;
  for (const name of Array.isArray(spec.presets) ? spec.presets : []) {
    const preset = Object.hasOwn(PRESETS, name) ? PRESETS[name] : undefined;
    if (preset?.patterns.some((re) => re.test(cmd))) return `matches the "${name}" preset of policy.deny_commands (${preset.description})`;
  }
  for (const p of Array.isArray(spec.patterns) ? spec.patterns : []) {
    if (!p || typeof p.pattern !== "string" || p.pattern.length > 500) continue;
    try {
      if (new RegExp(p.pattern, "i").test(cmd)) return p.message ? p.message : `matches policy.deny_commands pattern /${p.pattern}/`;
    } catch {
      /* reported by validation */
    }
  }
  return null;
}
