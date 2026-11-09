# Session-mining eval: rebuild guardrails from real agent logs

## Goal

Learn from local agent sessions (pi / claude_code / codex) to rebuild
agent-flow's guardrails from evidence: keep rules that catch real harm,
fix or delete rules that only produce friction, add rules for harm classes
nothing catches. The labeled session set becomes the permanent regression
corpus for the new system.

## Non-goals

- Reading all sessions (GBs). Sample + signal sweeps only.
- Uploading anything. No session goes to Skillsync (`sync` is out of scope).
- Hardcoding one user's habits. Output is configurable strictness, not a
  personal allowlist (agent-flow is a published tool).

## Verdict taxonomy (one label per sampled session)

Flow sessions: `worked` (harm attempted, blocked, task completed right) /
`missed` (harm happened despite flow) / `false-block` (legit action blocked).
Non-flow sessions: `could-have-helped` (harm occurred that an *installed,
enforcing* flow setup would have caught) / `fine-without`.
`unclear` is always allowed over guessing.

## Conventions (repo rules apply)

- No machine paths, keys, tokens, or secret contents in tracked files.
  Evidence is cited as `skl view <id>#n`, never pasted.
- Ledger lives at `evals/session-verdicts.jsonl`, one JSON object per line:
  `session_id, harness, flow_evidence, flow_version, verdict, harm_class,
  rule_involved, friction_cost, evidence_refs[], notes`.
- Every guard change from this work needs a regression test + CHANGELOG entry
  (per AGENTS.md).

---

## Phase 1 — Inventory and baselines

- [x] 1.1 Export session index per harness (`pi`, `claude_code`, `codex`):
      counts, date ranges, cwds. Prefer structured output (MCP
      `list_sessions`) over parsing CLI tables; paginate with
      `--since/--until` windows. Save index outside the repo (untracked).
- [x] 1.2 Establish current baselines from `.agent-flow/audit.jsonl`
      (all checkouts, not just this repo): blocks/day, block reasons,
      distinct rules firing. Same methodology as the README dogfood stats.
      DONE 2026-11-10: 234 sessions (pi 42 / claude_code 190 / codex 2);
      7 audit logs, 2,307 events, 756 guard_blocks; full numbers in
      `baseline.md` (untracked, machine-local). push family = 13 blocks total.
- [x] 1.3 Write the **flow-attribution decision rule**: a session counts as
      a flow session iff >=1 of: (a) cwd inside a flow-managed repo
      **including its worktrees** (`git worktree list` per repo — worktree
      cwds do NOT match the repo path); (b) flow skill/guard/audit terms in
      content; (c) audit-log run overlapping session time+repo. Record
      which signal fired per session.
- [ ] 1.4 **Checkpoint C1.** Attribution rule + baselines reviewed. Do not
      label until C1 passes — bad attribution poisons everything downstream.

## Phase 2 — Signal sweep (scripts first, no reading yet)

- [ ] 2.1 Sweep each harness index with **canonical tool syntax** (stable
      across prose styles), not English: `--force`, `--no-verify`,
      `push origin main`, `push --force`, secret filenames, CI workflow
      paths, `agent-flow` + skill/guard terms. (`query` is literal-only on
      Windows; smart `search` is unavailable.)
- [ ] 2.2 Cross-check audit-log blocks against session outcomes: block logged
      + harm absent + task completed = candidate `worked`; block logged +
      harm done anyway = candidate `missed` (guard logged but ineffective —
      the most important subclass).
- [ ] 2.3 FP pre-filter: block followed within the session by retry loop,
      user performing the same action manually, override language, or
      session death shortly after the block (silent abandonment proxy).
- [ ] 2.4 **Checkpoint C2.** Signal-hit lists per harness reviewed; queries
      saved as the standing sweep set for Phase 6.

## Phase 3 — Labeling (verdicts from full fidelity)

- [ ] 3.1 Seed the ledger with the free pilot: the 5-day dogfood corpus
      behind the README stats (294 role runs, 150 blocks, 16 known Windows
      false alarms). Annotate each with the flow version live at the time
      (date x CHANGELOG) — stale-version bugs must not drive the rebuild.
- [ ] 3.2 Write the labeling rubric with edge cases (e.g. what counts as a
      "normal" vs "dangerous" push to main) and calibrate: two passes over
      the same ~15 sessions; disagreements refine the rubric, not the labels.
- [ ] 3.3 Label a stratified sample: signal-hits from 2.1–2.3 PLUS a random
      baseline (~20%) to estimate base rates and catch silent misses.
      Label from `skl export` (full-fidelity Simple docs), never from the
      compact `view` projection.
- [ ] 3.4 Budget/stop rule: cap reading time per session (triage minutes,
      not hours); stop expanding the sample when verdict distribution per
      rule stabilizes across consecutive batches (saturation). FP counts are
      a lower bound — record that caveat with the numbers.
- [ ] 3.5 `could-have-helped` requires BOTH: harm in a non-flow session AND
      (flow installed or installable in that repo) AND (harness enforces hard
      blocks, or the catch would realistically come from hook/CI). Otherwise
      label `fine-without` with a note.
- [ ] 3.6 **Checkpoint C3.** Ledger + rubric + per-rule observation counts
      reviewed. No rule is changed on fewer than N observations (set N at
      C3; suggestion: N=5).

## Phase 4 — Scorecard (per rule x harness, never pooled)

- [ ] 4.1 For each guardrail (push-to-main, `--no-verify`, secret paths,
      CI-edit limits, every protected path): `worked` vs `false-block`
      counts, `missed`/`could-have-helped` demand, split by harness.
      Enforcement differs per host (hard block on Claude Code/Pi, hook/CI
      elsewhere) — pooling harnesses invalidates the comparison.
- [ ] 4.2 Work the push-to-main template: separate labeled pushes into
      fine vs dangerous along observable lines (repo type, branch, PR flow);
      the replacement rule is drawn exactly there, with the `false-block`
      sessions as its regression tests.
- [ ] 4.3 New-rule candidates from recurring `missed`/`could-have-helped`
      classes, admitted only if the same data shows acceptable FP cost.
- [ ] 4.4 **Checkpoint C4.** Scorecard + rule fates (keep / narrow / delete /
      add) approved by maintainer. Destructive changes need explicit sign-off
      per rule.

## Phase 5 — Rebuild

- [ ] 5.1 Implement the approved rule set as configurable strictness levels
      (thresholds), not hardcoded allows — see 4.2 template.
- [ ] 5.2 Every new/changed rule gets a regression test built from ledger
      sessions + CHANGELOG entry (AGENTS.md).
- [ ] 5.3 New guardrails must score clean on the full ledger corpus before
      release. Ledger stays in-repo as the permanent eval set.

## Phase 6 — Standing loop

- [ ] 6.1 Monthly: re-run the Phase 2 query set on new sessions, label hits,
      append to ledger, re-score the scorecard.
- [ ] 6.2 Track FP-complaint rate and blocks/day against Phase 1 baselines —
      that delta is the rebuild's success metric.

## Status

- [x] Repo and checkout synced (`origin/main`).
- [ ] C1 attribution + baselines — PENDING REVIEW (see C1 notes below)
- [ ] C2 signal sweep
- [ ] C3 ledger + rubric
- [ ] C4 scorecard approval
- [ ] Rebuild implemented, ledger-green
