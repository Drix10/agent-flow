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

type Schema = {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  minimum?: number;
};

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
    for (const [k, s] of Object.entries(schema.properties)) if (k in obj) out.push(...validate(obj[k], s, `${path}.${k}`));
  }
  if (schema.items && Array.isArray(value)) value.forEach((v, i) => out.push(...validate(v, schema.items!, `${path}[${i}]`)));
  return out;
}

/** Last top-level `{…}` in free text, respecting strings. */
function lastJsonObject(text: string): unknown {
  let found: unknown;
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < text.length; i++) {
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

/**
 * The report inside whatever a harness printed: a `claude -p --output-format json`
 * envelope (`structured_output`, else `result`), a Codex `-o` last message,
 * raw JSON, or prose with a fenced ```json block.
 */
export function extractReport(raw: string): { value?: unknown; source: string } {
  const text = raw.replace(/^﻿/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const env = parsed as Record<string, unknown>;
    if (env.type === "result" && ("structured_output" in env || "result" in env)) {
      if (env.structured_output && typeof env.structured_output === "object") return { value: env.structured_output, source: "claude structured_output" };
      if (typeof env.result === "string") {
        const inner = extractReport(env.result);
        return { value: inner.value, source: `claude result → ${inner.source}` };
      }
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
}

export function checkReport(role: ReportRole, raw: string): ReportCheck {
  const { value, source } = extractReport(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, role, source, problems: ["no JSON object found in the output"] };
  }
  const report = value as Record<string, unknown>;
  const problems = [...validate(report, reportSchema(role) as Schema), ...semantic(role, report)];
  return { ok: problems.length === 0, role, source, problems, report };
}
