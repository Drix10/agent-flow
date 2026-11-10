# Whale-loop learnings (machine-local knowledge base: 12 units, 82 files)

Curated principles from the full session-evidence loop (see TODO Phase 7).
Full per-whale digests + 11 patterns + verdict matrix live machine-local;
evidence by `skl view <id>#n` reference.

- R01-intent-hierarchy.md — explicit user instruction outranks guard defaults
  via a logged override channel (enablement AND disablement).
- R02-deny-handling.md — halt vs reroute per action class; enumerated
  alternates; rewrite-counts-as-edit.
- R03-cost-as-guard.md
- R04-noise-floor.md

## Full-text round (Nov 10)
- 62/62 continuations + 779 handbacks read on the flagship whale.
- New: harness disclaimer hardening (subagent-output distrust → P12
  equivalent: trust-boundary marking for agent-produced content),
  critic ±3 noise invalidating ±0.5 ratchet (R04), native over-breadth
  cases (dry-run denied at read-only lookup), lemo-wake license
  refusal vs explicit order (strongest guard-wins), cutaway
  capability-gap admission, $65-vs-$145 metering bug, --safe-mode
  hole via bare Bash allow. — budgets, tier routing, churn metrics, fan-out
  governor; spend needs preventive control.

## Raw-transcript round (Nov 10)
- Nov 9 ladder resolved from raw pi transcript (01a1ba9a 08:10-08:35):
  user-ordered push → 4 blocks held → compliant path (branch+PR #594)
  taken unprompted → guard removed by user → post-removal direct push.
  Fate: worked x4 + by-design + BYPASS. Phase 2 "orphan" for Nov 9
  retracted.
- Nov 6 blocks resolved (new unit 01a1af0d): all worked + by-design.
- New rework items: deny-UX reference episode; removal via override
  channel only; audit-only verdicts marked as such.

## Raw-transcript rounds 2-3 (Nov 10)
- Every unit now raw-covered (transcripts or full stream-scan).
- Withdrawn: a8c1e208 tracekit sudo-block (word-filter, not priv-esc).
- Rewritten: 01a0b5f7 env-read (value-ingest w/ discipline) + Sep 24 live
  PATs in chat (P10 precursor); 6666fa97 fully grounded; e519a401 pushes
  joined (55 commits); codex-oct18 170k lines, 0 live guards.
- New: warn-on-paste (MAP-18), human-armed env-gates (MAP-19),
  presence-check reroute (MAP-20), word-match intent rule (MAP-17).
