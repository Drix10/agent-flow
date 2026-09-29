// pipeline.max_cost_usd: a new phase or round is refused once the issue's role runs have cost the cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAudit, issueCost, readState, updateState } from "../extensions/lib/state.js";
import { maxCostUsd, validateManifest } from "../extensions/lib/manifest.js";

function root(fn) {
  const dir = mkdtempSync(join(tmpdir(), "af-budget-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const run = (dir, round, cost) => appendAudit(dir, { event: "role_run", issue: 1, role: "implementer", round, ok: true, cost_usd: cost });

test("under the cap, phases and rounds proceed; at the cap, the next one escalates with a per-round breakdown", () => {
  root((dir) => {
    updateState(dir, { issue: 1, state: "Working", phase: "implement", round: 1 }, 2, 5);
    run(dir, 1, 2);
    assert.equal(updateState(dir, { issue: 1, state: "Working", phase: "review", round: 1 }, 2, 5).state, "Working");
    run(dir, 1, 3.5);
    const r = updateState(dir, { issue: 1, state: "Working", phase: "fix", round: 2 }, 2, 5);
    assert.equal(r.state, "Needs Me");
    assert.equal(r.escalated, true);
    assert.match(r.reason, /budget_exceeded: \$5\.5 spent, cap \$5 \(round 1: \$5\.5\)/);
    assert.equal(readState(dir).sessions[0].state, "Needs Me");
  });
});

test("staying in the same phase and round isn't a new spend; no cap means no check; unreported cost doesn't count", () => {
  root((dir) => {
    updateState(dir, { issue: 1, state: "Working", phase: "implement", round: 1 }, 2, 1);
    run(dir, 1, 9);
    assert.equal(updateState(dir, { issue: 1, state: "Working", phase: "implement", round: 1 }, 2, 1).state, "Working");
    assert.equal(updateState(dir, { issue: 1, state: "Working", phase: "review", round: 1 }, 2, undefined).state, "Working");
  });
  root((dir) => {
    updateState(dir, { issue: 1, state: "Working", phase: "implement", round: 1 }, 2, 1);
    appendAudit(dir, { event: "role_run", issue: 1, role: "qa", round: 1, ok: true });
    assert.equal(issueCost(dir, 1).unreported_runs, 1);
    assert.equal(updateState(dir, { issue: 1, state: "Working", phase: "qa", round: 1 }, 2, 1).state, "Working");
  });
});

test("the cost is per issue, and the manifest value is validated", () => {
  root((dir) => {
    appendAudit(dir, { event: "role_run", issue: 2, role: "implementer", round: 1, ok: true, cost_usd: 99 });
    assert.equal(issueCost(dir, 1).total, 0);
  });
  assert.equal(maxCostUsd({ pipeline: { max_cost_usd: 3 } }), 3);
  assert.equal(maxCostUsd({ pipeline: { max_cost_usd: -1 } }), undefined);
  assert.ok(validateManifest({ pipeline: { max_cost_usd: 0 } }).some((p) => /max_cost_usd/.test(p)));
});
