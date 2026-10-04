// Orchestration layer: strict schemas for Codex, harness envelopes, the audit line, and the
// background runner that skills/invoking-agents/references/launch.md tells the orchestrator to write.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkReport, extractReport, reportSchema, strictSchema, REPORT_ROLES } from "../extensions/lib/report.js";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const run = (cwd, args) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" } });
const tmp = (p) => mkdtempSync(join(tmpdir(), `af-orch-${p}-`));
const read = (rel) => readFileSync(join(ROOT, rel), "utf-8");

const review = { status: "approved", round: 1, summary: "ok", findings: [], criteria: [{ criterion: "c", met: true, evidence: "t" }] };
const impl = { status: "ready_for_review", issue: 7, branch: "agent/issue-7", commit: "abc123", files_changed: ["src/a.ts"], criteria: [{ criterion: "c", evidence: "a.test.ts" }], checks: { test: "passed", typecheck: "passed", lint: "not_defined" } };

/** Every object node of a schema, with its path. */
function objects(s, path = "$", out = []) {
  if (s.properties) {
    out.push([path, s]);
    for (const [k, v] of Object.entries(s.properties)) objects(v, `${path}.${k}`, out);
  }
  if (s.items) objects(s.items, `${path}[]`, out);
  return out;
}
const types = (s) => (Array.isArray(s.type) ? s.type : [s.type]);

// ---------------------------------------------------------------------------
// Strict (OpenAI structured outputs) schema variants
// ---------------------------------------------------------------------------

test("strict schemas: every object closed, required == keys, optional fields nullable", () => {
  for (const role of Object.keys(REPORT_ROLES)) {
    const canonical = reportSchema(role);
    const strict = strictSchema(canonical);
    assert.equal(strict.$schema, undefined, `${role}: $schema dropped`);
    assert.equal(strict.title, undefined, `${role}: title dropped`);
    assert.ok(!JSON.stringify(strict).includes('"minimum"'), `${role}: minimum dropped`);
    const canon = new Map(objects(canonical));
    for (const [path, node] of objects(strict)) {
      assert.equal(node.additionalProperties, false, `${role} ${path}: must be closed`);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), `${role} ${path}: required must list every key`);
      const orig = canon.get(path);
      for (const [k, v] of Object.entries(node.properties)) {
        const wasRequired = (orig.required ?? []).includes(k);
        const origNullable = types(orig.properties[k]).includes("null");
        assert.equal(types(v).includes("null"), !wasRequired || origNullable, `${role} ${path}.${k}: nullable iff optional`);
        if (v.enum && !wasRequired) assert.ok(v.enum.includes(null), `${role} ${path}.${k}: enum admits null`);
      }
    }
  }
});

test("strict schemas are derived, not copies: canonical files are unchanged by the transform", () => {
  const before = read("schemas/review.schema.json");
  strictSchema(reportSchema("reviewer"));
  assert.equal(read("schemas/review.schema.json"), before);
  assert.ok(reportSchema("reviewer").title, "canonical keeps its annotations");
});

test("schema CLI: --strict prints the strict variant, --dir writes both variants for all roles", () => {
  const dir = tmp("schema");
  try {
    for (const argv of [["schema", "qa", "--strict"], ["schema", "--strict", "qa"]]) {
      const r = run(dir, argv);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), strictSchema(reportSchema("qa")), argv.join(" "));
    }
    assert.equal(JSON.parse(run(dir, ["schema", "qa"]).stdout).title, "agent-flow QA report");
    assert.equal(run(dir, ["schema", "--dir", dir]).status, 0);
    for (const name of ["implementer", "review", "qa-report"]) {
      assert.ok(existsSync(join(dir, `${name}.schema.json`)), name);
      assert.equal(JSON.parse(readFileSync(join(dir, `${name}.strict.schema.json`), "utf-8")).additionalProperties, false, name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); // Windows keeps a killed child's directory busy for a moment
  }
});

test("null means absent for optional fields (what a strict-mode Codex report looks like)", () => {
  const codexLastMessage = JSON.stringify({
    ...impl,
    new_dependencies: null,
    context_stale: null,
    disputes: null,
    category: null,
    what_i_tried: null,
    what_failed: null,
    suggested_next_step: null,
    checks: { test: "passed", typecheck: null, lint: null },
  });
  const r = checkReport("implementer", codexLastMessage);
  assert.ok(r.ok, r.problems.join("; "));
  assert.equal(r.source, "raw JSON");
  assert.ok(!("category" in r.report) && !("typecheck" in r.report.checks), "nulls dropped from the normalised report");
  const reviewNulls = { ...review, withdrawn: null, context_stale_flags: null, risk_review_flags: null, permission_violations: null, findings: [{ severity: "nit", category: "IMPL_ERROR", file: null, line: null, issue: "x", evidence: "y", suggestion: null }] };
  const rr = checkReport("reviewer", JSON.stringify(reviewNulls));
  assert.ok(rr.ok, rr.problems.join("; "));
  assert.deepEqual(Object.keys(rr.report.findings[0]).sort(), ["category", "evidence", "issue", "severity"]);
  // null where the field is required is still an error, and a schema-level null (qa.reason) is kept.
  assert.match(checkReport("reviewer", JSON.stringify({ ...review, summary: null })).problems.join(), /\$\.summary: expected string/);
  const qa = checkReport("qa", JSON.stringify({ status: "failed", issue: 1, commands: [{ name: "t", command: "npm test", exit_code: 1, rerun_exit_code: 1, raw_output: "x", duration_seconds: null }], flaky: null, reason: null }));
  assert.ok(qa.ok, qa.problems.join("; "));
  assert.equal(qa.report.reason, null);
});

// ---------------------------------------------------------------------------
// Real-world harness envelopes
// ---------------------------------------------------------------------------

const claudeEnvelope = (extra) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 81234,
    duration_api_ms: 60210,
    num_turns: 23,
    result: "Done — report below.",
    session_id: "3f2a1c9e-0000-4000-8000-000000000001",
    total_cost_usd: 0.4213,
    usage: { input_tokens: 1200, cache_read_input_tokens: 90000, output_tokens: 3400 },
    ...extra,
  });

test("Claude --output-format json with --json-schema: structured_output wins, cost/turns surfaced", () => {
  const r = checkReport("implementer", claudeEnvelope({ structured_output: impl }));
  assert.ok(r.ok, r.problems.join("; "));
  assert.equal(r.source, "claude structured_output");
  assert.equal(r.harness.harness, "claude");
  assert.equal(r.harness.cost_usd, 0.4213);
  assert.equal(r.harness.num_turns, 23);
  assert.equal(r.harness.session_id, "3f2a1c9e-0000-4000-8000-000000000001");
});

test("Claude result with the report as text (no structured_output)", () => {
  const r = checkReport("reviewer", claudeEnvelope({ result: `Reviewed the diff.\n\n\`\`\`json\n${JSON.stringify(review, null, 2)}\n\`\`\`\n` }));
  assert.ok(r.ok, r.problems.join("; "));
  assert.equal(r.source, "claude result → fenced block");
});

test("Claude error results never count, even with JSON in them", () => {
  const maxTurns = checkReport("implementer", claudeEnvelope({ subtype: "error_max_turns", is_error: true, result: undefined }));
  assert.equal(maxTurns.ok, false);
  assert.match(maxTurns.problems[0], /^harness error: error_max_turns/);
  const withJson = checkReport("reviewer", claudeEnvelope({ subtype: "error_during_execution", is_error: true, result: JSON.stringify(review) }));
  assert.equal(withJson.ok, false);
  assert.match(withJson.problems.join(), /harness error: error_during_execution/);
});

test("Gemini -p … -o json envelope is unwrapped; stats surfaced; errors reported", () => {
  const stats = { models: { "gemini-2.5-pro": { tokens: { prompt: 5120, candidates: 812, total: 5932 } } }, tools: { totalCalls: 4 } };
  const fenced = JSON.stringify({ session_id: "g-1", response: `Here is my review:\n\`\`\`json\n${JSON.stringify(review)}\n\`\`\``, stats });
  const r = checkReport("reviewer", fenced);
  assert.ok(r.ok, r.problems.join("; "));
  assert.equal(r.source, "gemini response → fenced block");
  assert.deepEqual(r.harness.usage, stats);
  assert.equal(extractReport(JSON.stringify({ response: JSON.stringify(review), stats })).source, "gemini response → raw JSON");
  const err = checkReport("reviewer", JSON.stringify({ error: { type: "FatalAuthenticationError", message: "auth failed", code: 41 }, stats: {} }));
  assert.equal(err.ok, false);
  assert.match(err.problems[0], /harness error: auth failed/);
});

test("an envelope-less report that happens to have a `response` string field is not mistaken for Gemini", () => {
  // Only objects that *are* a report go down the raw path; a Gemini envelope has no report keys at the top.
  const r = extractReport(JSON.stringify({ ...review }));
  assert.equal(r.source, "raw JSON");
});

// ---------------------------------------------------------------------------
// Audit line per launch
// ---------------------------------------------------------------------------

test("report --harness appends a role_run line to .agent-flow/audit.jsonl", () => {
  const dir = tmp("audit");
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    const raw = join(dir, "implementer-r1.raw");
    writeFileSync(raw, claudeEnvelope({ structured_output: impl }));
    const argv = join(dir, "implementer-r1.argv");
    writeFileSync(argv, JSON.stringify(["claude", "-p", "--max-turns", "150"]));
    const r = run(dir, ["report", "implementer", raw, "--out", join(dir, "implementer-r1.json"), "--harness", "claude", "--model", "sonnet", "--issue", "7", "--round", "1", "--exit", "0", "--seconds", "81", "--argv-file", argv]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const lines = readFileSync(join(dir, ".agent-flow", "audit.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    const e = lines.find((l) => l.event === "role_run");
    assert.ok(e, "role_run line written");
    assert.equal(e.role, "implementer");
    assert.equal(e.harness, "claude");
    assert.equal(e.issue, 7);
    assert.equal(e.exit_code, 0);
    assert.equal(e.duration_s, 81);
    assert.equal(e.cost_usd, 0.4213);
    assert.equal(e.ok, true);
    assert.match(e.argv, /max-turns/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); // Windows keeps a killed child's directory busy for a moment
  }
});

// ---------------------------------------------------------------------------
// The skill text: the runner it tells the orchestrator to write, and the commands it gives
// ---------------------------------------------------------------------------

const launch = read("skills/invoking-agents/references/launch.md");
const skill = read("skills/invoking-agents/SKILL.md");
const runnerSource = () => launch.match(/cat > "\$A\/run-role\.mjs" <<'EOF'\n([\s\S]*?)\nEOF/)[1];

function waitFor(path, ms = 15000) {
  const until = Date.now() + ms;
  while (!existsSync(path) && Date.now() < until) spawnSync(process.execPath, ["-e", "setTimeout(()=>{},100)"]);
  return existsSync(path);
}

test("launch.md runner: detaches, passes KEY=VALUE env, records exit and duration", () => {
  const dir = tmp("runner");
  try {
    const runner = join(dir, "run-role.mjs");
    writeFileSync(runner, runnerSource());
    const base = join(dir, "qa-r1");
    const started = spawnSync(process.execPath, [runner, base, "30", "--", "AGENT_FLOW_ROLE=qa", process.execPath, "-e", "console.log(process.env.AGENT_FLOW_ROLE); process.exit(3)"], { encoding: "utf-8" });
    assert.equal(started.status, 0, started.stderr);
    assert.ok(waitFor(`${base}.exit`), "exit file written");
    assert.equal(readFileSync(`${base}.exit`, "utf-8"), "3");
    assert.equal(readFileSync(`${base}.raw`, "utf-8").trim(), "qa");
    assert.ok(existsSync(`${base}.pid`) && existsSync(`${base}.secs`) && existsSync(`${base}.argv`));
    assert.ok(!JSON.parse(readFileSync(`${base}.argv`, "utf-8")).includes("AGENT_FLOW_ROLE=qa"), "env assignments aren't part of argv");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); // Windows keeps a killed child's directory busy for a moment
  }
});

test("launch.md runner: a role past its wall-clock limit exits 124", () => {
  const dir = tmp("runner-to");
  try {
    const runner = join(dir, "run-role.mjs");
    writeFileSync(runner, runnerSource());
    const base = join(dir, "implementer-r1");
    spawnSync(process.execPath, [runner, base, "1", "--", process.execPath, "-e", "setTimeout(()=>{}, 60000)"]);
    assert.ok(waitFor(`${base}.exit`), "exit file written");
    assert.equal(readFileSync(`${base}.exit`, "utf-8"), "124");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); // Windows keeps a killed child's directory busy for a moment
  }
});

test("launch commands: Codex uses the strict schemas, Gemini shell roles can run, QA is not read-only", () => {
  const codex = launch.slice(launch.indexOf("## Codex CLI"), launch.indexOf("## Gemini CLI"));
  const outputSchemas = [...codex.matchAll(/--output-schema "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(outputSchemas.length, 3);
  for (const s of outputSchemas) assert.match(s, /\.strict\.schema\.json$/);
  const qaCodex = codex.slice(codex.indexOf("# QA"));
  assert.match(qaCodex, /--sandbox workspace-write/);
  const gemini = launch.slice(launch.indexOf("## Gemini CLI"), launch.indexOf("## Pi"));
  assert.match(gemini, /AGENT_FLOW_ROLE=implementer[\s\S]*?--approval-mode yolo/);
  assert.match(gemini, /AGENT_FLOW_ROLE=qa[\s\S]*?--approval-mode yolo/);
  // No read-only `plan` approval mode exists: the reviewer runs at the default mode,
  // where reads work and writes/shell need a confirmation nobody is there to grant.
  const reviewerGemini = gemini.slice(gemini.indexOf("AGENT_FLOW_ROLE=reviewer"), gemini.indexOf("AGENT_FLOW_ROLE=qa"));
  assert.ok(!reviewerGemini.includes("--approval-mode"), "reviewer runs at the default approval mode");
  // Every harness model flag is conditional: an empty --model would be an error. (`report --model` is
  // agent-flow's own audit field, where an empty value is fine.)
  const harnessLines = launch
    .split("\n")
    .filter((l) => !l.includes("--harness"))
    .join("\n")
    .replace(/\$\{[A-Z_]+:\+[^}]*\}/g, "");
  assert.ok(!/--model "\$/.test(harnessLines), "no unconditional --model");
  assert.ok(!/-m "\$/.test(harnessLines), "no unconditional -m");
});

test("orchestrator skill: resume path, HEAD check, QA environment routing, idempotent PR, size", () => {
  // The procedure lives in references/manual.md so a session that uses the CLI never loads it.
  const procedure = `${skill}
${read("skills/invoking-agents/references/manual.md")}`;
  assert.match(procedure, /`Working` → .*Resuming/);
  assert.match(procedure, /rev-parse HEAD/);
  assert.match(procedure, /qa_environment/);
  assert.match(procedure, /gh pr list --head agent\/issue-N --state open/);
  assert.match(procedure, /role_timeout/);
  assert.ok(!/classify both first/.test(procedure), "classify can't run before implementation");
  assert.ok(skill.split("\n").length <= 80, `SKILL.md is ${skill.split("\n").length} lines`);
  assert.ok(!/enableAgents/.test(read(".gemini/agents/reviewer.md")), "subagents are on by default in Gemini CLI");
  assert.match(read(".claude/agents/reviewer.md"), /^skills:\n\s+- reviewer$/m);
});

test("manifest: a round cap below 1 is rejected (0 would escalate before any work), models must be non-empty strings", async () => {
  const { validateManifest, maxReviewRounds } = await import("../extensions/lib/manifest.js");
  const base = { version: "2", staleness_threshold_days: 30, context_files: [{ path: "AGENTS.md", references: [] }] };
  assert.ok(validateManifest({ ...base, pipeline: { max_review_rounds: 0 } }).some((p) => /max_review_rounds must be an integer 1–5/.test(p)));
  assert.equal(maxReviewRounds({ ...base, pipeline: { max_review_rounds: 0 } }), maxReviewRounds(null), "0 falls back to the default");
  assert.deepEqual(validateManifest({ ...base, pipeline: { max_review_rounds: 2, models: { fast: "claude-haiku-4-5", high_reasoning: "claude-opus-5-5" } } }), []);
  assert.ok(validateManifest({ ...base, pipeline: { models: { fast: "" } } }).some((p) => /pipeline\.models\.fast/.test(p)));
});
