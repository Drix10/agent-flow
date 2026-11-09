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
- [x] 1.4 **Checkpoint C1.** SIGNED OFF by maintainer with all other
      sign-offs pre-Phase-5. Attribution rule + baselines accepted.

## Phase 2 — Signal sweep (scripts first, no reading yet)

- [x] 2.1 Sweep each harness index with **canonical tool syntax** (stable
      across prose styles), not English: `--force`, `--no-verify`,
      `push origin main`, `push --force`, secret filenames, CI workflow
      paths, `agent-flow` + skill/guard terms. (`query` is literal-only on
      Windows; smart `search` is unavailable.)
      DONE 2026-11-10: 14 patterns swept; hit lists machine-local in
      `sweep/q-*.txt`. Fixes learned: literal `--flag` needs `skl query --`;
      `push origin main` hits are dominated by the owner's non-flow factory
      workflow (direct main pushes are the norm there). `--since/--until`
      verified working; Oct 3 + Nov 9 return zero sessions in EVERY harness
      despite audit blocks on those dates = orphan-block phenomenon.
- [x] 2.2 Cross-check audit-log blocks against session outcomes: block logged
      + harm absent + task completed = candidate `worked`; block logged +
      harm done anyway = candidate `missed` (guard logged but ineffective —
      the most important subclass).
      DONE 2026-11-10: all 13 push-family blocks joined or marked orphan
      (arena Oct 3 x3, tgmvp Nov 9 x4, agentflow Oct 7 x1: no sessions).
      skl times are UTC (view-header vs wall clock), audit `at` compares
      directly. Join rule hardened: audit+time+repo+cwd, verdict ONLY on
      session-content confirmation.
- [x] 2.3 FP pre-filter: block followed within the session by retry loop,
      user performing the same action manually, override language, or
      session death shortly after the block (silent abandonment proxy).
      DONE 2026-11-10: sequences ID'd — 110fe80e user-ordered main pushes;
      f1c432dc manual-push instruction; 01a1ba9a policy deliberation +
      hooksPath probe; tgmvp Nov 9 block->force-push escalation.
- [x] 2.4 **Checkpoint C2.** SELF-PASSED 2026-11-10 (autonomous mode):
      hit lists + orphan caveat + standing query set (14 patterns, saved
      machine-local). No maintainer input needed; deviations recorded above.

## Phase 3 — Labeling (verdicts from full fidelity)

- [x] 3.1 Seed the ledger with the free pilot: the 5-day dogfood corpus
      behind the README stats (294 role runs, 150 blocks, 16 known Windows
      false alarms). Annotate each with the flow version live at the time
      (date x CHANGELOG) — stale-version bugs must not drive the rebuild.
      DONE (partial) 2026-11-10: d93fc171 labeled test-context; version map
      built (1.2.0-1.2.7 across Oct 1-12; Nov blocks = 1.2.7+). Dogfood
      transcripts largely pruned; arena Oct 1-6 blocks are orphans.
- [x] 3.2 Write the labeling rubric with edge cases (e.g. what counts as a
      "normal" vs "dangerous" push to main) and calibrate: two passes over
      the same ~15 sessions; disagreements refine the rubric, not the labels.
      DONE: `evals/rubric.md` frozen. Adds missed-unwired vs missed-bypass,
      N=5 deletion floor with narrowing-below-N clause. Calibration on ~5
      sessions (small sample noted as limitation).
- [x] 3.3 Label a stratified sample: signal-hits from 2.1–2.3 PLUS a random
      baseline (~20%) to estimate base rates and catch silent misses.
      Label from `skl export` (full-fidelity Simple docs), never from the
      compact `view` projection.
      DONE 2026-11-10: 10 verdicts in `evals/session-verdicts.jsonl` + 2
      random baselines (bf9dba09 flow-quiet, 01a0f005 non-flow). All from
      export; `view` used for triage only.
- [x] 3.4 Budget/stop rule: cap reading time per session (triage minutes,
      not hours); stop expanding the sample when verdict distribution per
      rule stabilizes across consecutive batches (saturation). FP counts are
      a lower bound — record that caveat with the numbers.
      DONE: triage via query/export-grep, deep reads only on joined hits.
- [x] 3.5 `could-have-helped` requires BOTH: harm in a non-flow session AND
      (flow installed or installable in that repo) AND (harness enforces hard
      blocks, or the catch would realistically come from hook/CI). Otherwise
      label `fine-without` with a note.
      DONE: zero sessions met the bar — recorded explicitly, not left open.
- [x] 3.6 **Checkpoint C3.** SELF-PASSED 2026-11-10 (autonomous mode).
      N=5 set (deletion floor; narrowing allowed below N per rubric rule 7).
      Limitation: random baseline = 2 sessions; full random deferred to
      Phase 6.

## Phase 4 — Scorecard (per rule x harness, never pooled)

- [x] 4.1 For each guardrail (push-to-main, `--no-verify`, secret paths,
      CI-edit limits, every protected path): `worked` vs `false-block`
      counts, `missed`/`could-have-helped` demand, split by harness.
      Enforcement differs per host (hard block on Claude Code/Pi, hook/CI
      elsewhere) — pooling harnesses invalidates the comparison.
      DONE: `evals/scorecard.md`, joined verdicts only, orphans counted.
- [x] 4.2 Work the push-to-main template: separate labeled pushes into
      fine vs dangerous along observable lines (repo type, branch, PR flow);
      the replacement rule is drawn exactly there, with the `false-block`
      sessions as its regression tests.
      DONE: line drawn at per-repo config-aware policy; 01a1ba9a (missed)
      + 110fe80e (fine-without) are the regression tests.
- [x] 4.3 New-rule candidates from recurring `missed`/`could-have-helped`
      classes, admitted only if the same data shows acceptable FP cost.
      DONE: 1 admitted (escalation telemetry); secret-read narrowing + 4
      rebuild requirements instead of new blocks.
- [ ] 4.4 **Checkpoint C4.** PENDING YOUR REVIEW (autonomous run ends here):
      `evals/scorecard.md` + rule fates (keep / narrow / delete / add) +
      4 rebuild requirements. Destructive changes need explicit sign-off
      per rule. Phase 5 starts only on your approval.

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

## Phase 7 — Whale learning loop (holy grail; pre-Phase-5 input to rework)

Goal: squeeze the biggest sessions dry for powers, weaknesses, and guard
verdicts, and turn them into the reworked agent-flow. Budget 10-30M input
tokens (~10M planned, 30M hard ceiling); log everything; never re-read what
is already filed.

- [ ] 7.1 Normalization: `skl export` every whale to Simple docs
      (machine-local). txcript is the cross-harness normalizer — no custom
      parsers for claude/pi/codex stores. Disk budget ~5-10GB, untracked.
- [ ] 7.2 Deterministic extraction ($0 tokens): per whale, script-build
      intent spine (user prompts verbatim), template-collapsed command
      ledger (template x count x outcomes), guard strip (each enforcement
      + 5-command neighborhood), human-intervention log, cost autopsy
      (burn-over-time, cache-churn ratio, subagent fan-out), outcome record.
- [ ] 7.3 Knowledge tree (machine-local `knowledge/`, Markdown only):
      `whales/<id>/` holds 8 files (`00-README`, `01-INTENT`,
      `02-COMMANDS`, `03-GUARD`, `04-HUMAN`, `05-COST`, `06-VERDICTS`,
      `07-POWERS-WEAKNESSES`); `patterns/Pnn-*.md` one file per pattern
      with frequency table + whale evidence links; `principles/Rnn-*.md`
      one file per principle with claim/evidence/confidence/generality;
      `rework/MAP.md` maps principle -> scorecard fate -> build item;
      `00-INDEX.md` master map, `01-LOOP-STATE.md` resume tracker +
      per-whale token-spent ledger (learning ROI).
- [ ] 7.4 Classification headers: every pattern/principle file carries a
      fixed grep-able header (`class:`, `harness:`, `severity:`,
      `confidence:`, `generality:`, `evidence:`). Placement + headers do
      the classifying — no JSON stores, no tooling needed to browse.
- [ ] 7.5 Fifth verdict `by-design`: prompt explicitly required the flagged
      action (e.g. user-ordered main push). Feeds the intent-hierarchy
      requirement: explicit user instruction outranks guard defaults, with
      the override logged. Event-level labels (worked / missed /
      false-block / could-have / by-design) on every guard-relevant moment.
- [ ] 7.6 Loop protocol (compact-safe): one whale per cycle — extract,
      read (spine + ledger + guard/human threads fully; full-text dives on
      budget), label + inventory into whale files, mint/extend patterns
      then principles, append ~20-line carry-forward brief to
      `01-LOOP-STATE.md`, compact, continue. State on disk; chat holds
      nothing irreplaceable.
- [ ] 7.7 Order: pilot `01a1b7ed` (validates scripts; already exported) ->
      `110fe80e` whale (token autopsy first) -> `6666fa97` (same-repo
      contrast) -> `01a1b54f` (GPT cross-model) -> Sep-18 arena pi pair
      (natural experiment + secret handling) -> rest by size -> Oct-18
      codex cluster last (zst handling + skl-coverage gap).
- [ ] 7.8 Repo mirror (tracked, small): `evals/learnings/` gets principles
      + index only. Whale-sized material stays machine-local. No secrets,
      keys, tokens, or machine paths in tracked files — evidence by
      `skl view <id>#n` reference.
- [ ] 7.9 **Checkpoint C5.** Synthesis + rework map reviewed before any
      code changes. Phase 5 rebuild consumes principles in rework/MAP.md
      order; new guardrails must score clean on ledger + whale events.
- [ ] 7.10 Standing rule: every whale posts a 10-line summary (verdicts,
      new patterns, tokens spent vs tokens it burned) before the next
      starts.

## Status

- [x] Repo and checkout synced (`origin/main`).
- [x] C1 attribution + baselines — SIGNED OFF
- [x] C2 signal sweep — self-passed, autonomous mode
- [x] C3 ledger + rubric — self-passed, autonomous mode (N=5)
- [x] C4 scorecard approval — SIGNED OFF (all sign-offs granted pre-Phase-5)
- [ ] Rebuild implemented, ledger-green (Phase 5, awaiting kickoff)
- [ ] C5 whale-loop synthesis approval (Phase 7 end; build starts after)

## C1 notes (from Phase 1 review)

Baselines: 234 sessions (pi 42 / claude_code 190 / codex 2); 7 audit logs,
2,307 events, 756 guard_blocks. Attribution split (cwd-substring,
case-normalized): 111 flow-candidates vs 123 non-flow. Push family = 13
blocks, fully reviewable. Two flags: (1) 584 role-tool blocks look like a
block-retry loop (now explained in scorecard: mechanism unclear, likely
automated probing — rebuild item 1); (2) hypothesis-arena is the prime
corpus (only full-lifecycle log). All checkpoints signed off pre-Phase-5.
