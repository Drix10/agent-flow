/**
 * Role reports: the JSON each pipeline role prints for the orchestrator.
 *
 * The orchestrator routes on these fields, so a report that is wrapped in a
 * markdown fence, surrounded by prose, or missing a field must be caught here —
 * not discovered three steps later as a wrong routing decision. Zero-dependency
 * validator for the JSON-schema subset the schemas in ../../schemas use.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPORT_ROLES = { implementer: "implementer-report", reviewer: "review", qa: "qa-report" } as const;
export type ReportRole = keyof typeof REPORT_ROLES;

const schemaDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../schemas");

export function reportSchema(role: ReportRole): Record<string, unknown> {
  return JSON.parse(readFileSync(join(schemaDir, `${REPORT_ROLES[role]}.schema.json`), "utf-8"));
}

export type Schema = {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  minimum?: number;
  additionalProperties?: boolean;
  [keyword: string]: unknown;
};

function allowsNull(s: Schema): boolean {
  return Array.isArray(s.type) ? s.type.includes("null") : s.type === "null";
}

function nullable(s: Schema): Schema {
  if (s.type === undefined || allowsNull(s)) return s;
  const out: Schema = { ...s, type: [...(Array.isArray(s.type) ? s.type : [s.type]), "null"] };
  if (out.enum && !out.enum.includes(null)) out.enum = [...out.enum, null];
  return out;
}

/** Annotations and checks strict mode may reject. `validate` still enforces them locally. */
const STRICT_DROP = new Set(["$schema", "$id", "title", "minimum"]);

/**
 * The strict-mode variant of a canonical schema, for `codex exec --output-schema`.
 * OpenAI Structured Outputs requires every object to be closed
 * (`additionalProperties: false`) with every property listed in `required`, so a
 * field that is optional in the canonical schema becomes nullable instead.
 * Derived, never hand-maintained: the canonical schema stays the single source of
 * truth, and `checkReport` reads `null` in an optional field as "absent".
 */
export function strictSchema(schema: Schema): Schema {
  const out: Schema = {};
  for (const [k, v] of Object.entries(schema)) if (!STRICT_DROP.has(k)) out[k] = v;
  if (schema.items) out.items = strictSchema(schema.items);
  if (schema.properties) {
    const required = new Set(schema.required ?? []);
    const props: Record<string, Schema> = {};
    for (const [k, v] of Object.entries(schema.properties)) props[k] = required.has(k) ? strictSchema(v) : nullable(strictSchema(v));
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

/** Problems with `value` against `schema`, as `path: message` strings. Empty = valid. */
export function validate(value: unknown, schema: Schema, path = "$"): string[] {
  const out: string[] = [];
  if (schema.type) {
    const want = Array.isArray(schema.type) ? schema.type : [schema.type];
    const got = typeOf(value);
    if (!want.includes(got) && !(got === "integer" && want.includes("number"))) {
      return [`${path}: expected ${want.join(" | ")}, got ${got}`];
    }
  }
  if (schema.enum && !schema.enum.includes(value)) out.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  if (typeof schema.minimum === "number" && typeof value === "number" && value < schema.minimum) out.push(`${path}: must be ≥ ${schema.minimum}`);
  if (schema.properties && value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in obj)) out.push(`${path}.${k}: required`);
    for (const [k, s] of Object.entries(schema.properties)) {
      if (!(k in obj)) continue;
      // `null` in an optional field means "absent": strict-mode harnesses (Codex) must emit every key.
      if (obj[k] === null && !schema.required?.includes(k) && !allowsNull(s)) continue;
      out.push(...validate(obj[k], s, `${path}.${k}`));
    }
  }
  if (schema.items && Array.isArray(value)) value.forEach((v, i) => out.push(...validate(v, schema.items!, `${path}[${i}]`)));
  return out;
}

/** Drop optional fields set to `null` (unless the schema itself allows null), recursively. */
export function dropNullOptionals(value: unknown, schema: Schema): unknown {
  if (Array.isArray(value)) return schema.items ? value.map((v) => dropNullOptionals(v, schema.items!)) : value;
  if (!value || typeof value !== "object" || !schema.properties) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const s = schema.properties[k];
    if (v === null && s && !schema.required?.includes(k) && !allowsNull(s)) continue;
    out[k] = s ? dropNullOptionals(v, s) : v;
  }
  return out;
}

/** Last top-level `{…}` in free text, respecting strings. */
function lastJsonObject(input: string): unknown {
  // The report is the last thing a role prints. A role's output is untrusted and can be huge, or open braces it never
  // closes: every `{` rescans to the end, which is quadratic. Look only at the tail, and stop after a fixed amount of work.
  const text = input.length > 2_000_000 ? input.slice(-2_000_000) : input;
  let budget = 20_000_000;
  let found: unknown;
  for (let start = text.indexOf("{"); start !== -1 && budget > 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < text.length; i++) {
      if (--budget <= 0) break;
      const ch = text[i];
      if (inStr) {
        if (ch === "\\") i++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          found = JSON.parse(text.slice(start, i + 1));
          start = i; // skip nested objects of the one we just took
        } catch {
          /* not JSON — keep scanning */
        }
        break;
      }
    }
  }
  return found;
}

/** What the harness said about the run itself: cost, tokens, turns, and whether it failed. */
export interface HarnessInfo {
  harness: "claude" | "gemini";
  error?: string;
  session_id?: string;
  cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  usage?: unknown;
}

export interface Extracted {
  value?: unknown;
  source: string;
  harness?: HarnessInfo;
}

const num = (v: unknown) => (typeof v === "number" ? v : undefined);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const compact = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/**
 * The report inside whatever a harness printed:
 * - `claude -p --output-format json`: `{"type":"result", "structured_output"?, "result", "total_cost_usd", …}`
 * - `gemini -p … -o json`: `{"response": "<text>", "stats": {…}, "error"?: {…}}`
 * - a Codex `-o` last message, raw JSON, or prose with a fenced ```json block.
 */
export function extractReport(raw: string): Extracted {
  const text = raw.replace(/^﻿/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const env = parsed as Record<string, unknown>;
    if (env.type === "result" && ("structured_output" in env || "result" in env || "subtype" in env)) {
      const failed = env.is_error === true || (typeof env.subtype === "string" && env.subtype !== "success");
      const detail = typeof env.result === "string" && env.result ? `: ${env.result.slice(0, 300)}` : "";
      const harness = compact<HarnessInfo>({
        harness: "claude",
        error: failed ? `${str(env.subtype) ?? "error"}${detail}` : undefined,
        session_id: str(env.session_id),
        cost_usd: num(env.total_cost_usd),
        num_turns: num(env.num_turns),
        duration_ms: num(env.duration_ms),
        usage: env.usage,
      });
      if (env.structured_output && typeof env.structured_output === "object") return { value: env.structured_output, source: "claude structured_output", harness };
      if (typeof env.result === "string") {
        const inner = extractReport(env.result);
        return { value: inner.value, source: `claude result → ${inner.source}`, harness };
      }
      return { source: "claude envelope without a result", harness };
    }
    const geminiError = env.error && typeof env.error === "object" ? (env.error as Record<string, unknown>) : undefined;
    if (typeof env.response === "string" || (geminiError && ("stats" in env || "session_id" in env))) {
      const harness = compact<HarnessInfo>({
        harness: "gemini",
        error: geminiError ? (str(geminiError.message) ?? JSON.stringify(geminiError).slice(0, 300)) : undefined,
        session_id: str(env.session_id),
        usage: env.stats,
      });
      if (typeof env.response !== "string") return { source: "gemini envelope without a response", harness };
      const inner = extractReport(env.response);
      return { value: inner.value, source: `gemini response → ${inner.source}`, harness };
    }
    return { value: parsed, source: "raw JSON" };
  }
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)];
  for (const f of fences.reverse()) {
    try {
      return { value: JSON.parse(f[1]), source: "fenced block" };
    } catch {
      /* try the next one */
    }
  }
  const obj = lastJsonObject(text);
  return obj === undefined ? { source: "none" } : { value: obj, source: "last JSON object in text" };
}

/** Contradictions the schema can't express, but the orchestrator would route wrongly on. */
function semantic(role: ReportRole, r: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (role === "implementer") {
    if (r.status === "needs_me") {
      for (const k of ["category", "what_failed", "suggested_next_step"]) if (!r[k]) out.push(`$.${k}: required when status is needs_me`);
    } else if (!r.commit) out.push("$.commit: required when status is ready_for_review");
  }
  if (role === "reviewer" && r.status === "approved") {
    const findings = Array.isArray(r.findings) ? (r.findings as Record<string, unknown>[]) : [];
    if (findings.some((f) => f.severity === "blocking")) out.push("$.status: approved but a finding is blocking");
    if (findings.some((f) => f.category === "SPEC_ERROR" || f.category === "ARCH_ERROR")) out.push("$.status: approved but a finding is SPEC_ERROR/ARCH_ERROR (those always escalate)");
    if (Array.isArray(r.criteria) && (r.criteria as Record<string, unknown>[]).some((c) => c.met === false)) out.push("$.status: approved but a criterion is not met");
    if (Array.isArray(r.permission_violations) && r.permission_violations.length) out.push("$.status: approved despite permission_violations");
  }
  if (role === "qa" && Array.isArray(r.commands)) {
    const cmds = r.commands as Record<string, unknown>[];
    const firstFail = cmds.some((c) => c.exit_code !== 0);
    const rerunFail = cmds.some((c) => c.exit_code !== 0 && c.rerun_exit_code !== 0);
    if (r.status === "passed" && firstFail) out.push("$.status: passed but a command exited non-zero on its first run");
    if (r.status === "passed_with_flaky" && rerunFail) out.push("$.status: passed_with_flaky but a command also failed its re-run");
    if (r.status === "failed" && !firstFail && !r.reason) out.push("$.status: failed but every command exited 0 and no reason is given");
  }
  return out;
}

export interface ReportCheck {
  ok: boolean;
  role: ReportRole;
  source: string;
  problems: string[];
  report?: Record<string, unknown>;
  harness?: HarnessInfo;
}

export function checkReport(role: ReportRole, raw: string): ReportCheck {
  const { value, source, harness } = extractReport(raw);
  const base = { role, source, ...(harness ? { harness } : {}) };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const problems = harness?.error ? [`harness error: ${harness.error}`] : ["no JSON object found in the output"];
    return { ok: false, ...base, problems };
  }
  const schema = reportSchema(role) as Schema;
  const report = dropNullOptionals(value, schema) as Record<string, unknown>;
  // A run the harness itself flagged as failed (turn cap, budget, crash) never counts, even if JSON came out.
  const problems = [...(harness?.error ? [`harness error: ${harness.error}`] : []), ...validate(report, schema), ...semantic(role, report)];
  return { ok: problems.length === 0, ...base, problems, report };
}
