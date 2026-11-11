# Guard rebuild: handoff

Read this first, then [PLAN.md](PLAN.md) (the design and the reasons) and [evidence/](evidence/) (the audits and critiques behind it).
Nothing here is released: `package.json` is still 1.2.7 and the changes sit under `[Unreleased]` in `CHANGELOG.md`.

## Where it stands

Stage 1 and Stage 2 of the plan are mostly built, test-first, on `main`. The full suite passed at the last run
(`npm test`: 548 pass, 0 fail, 2 skipped; `npm run lint` clean). What is missing is the context layer (turn record and
initiator), the harness adapters, the honest `status` tiers, the docs, the groundwork and the release gates.

| Plan step | State | Notes |
|---|---|---|
| Groundwork 1 baseline (live-only) | not done | exclude the 584 role-probe rows and test cwds |
| Groundwork 2 eval record corrections, `initiator` per ledger row | not done | corrections are listed in PLAN 2b |
| Groundwork 3 key hygiene | human action | see "Human actions" below |
| Groundwork 4 fixtures | mostly done | `tests/redteam/corpus.json` has `rule`; about 120 sanitized entries added; `cwd`, `manifest`, stub `probe` and `turn` fields not all added |
| Groundwork 5 owner-trace corpus | not done | raw traces stay machine-local; only sanitized shapes belong in the repo |
| Groundwork 6 flip gate (both directions) | partly | the corpus asserts the rule name; the listed-flip report is not built |
| Stage 1.1 grants, pauses, revoke, store protection | done | `extensions/lib/grants.ts`; session-brief and `status` lines not done |
| Stage 1.2 argv-based git parsing, CRLF | done | the word pass is authoritative for `push` and `fetch` |
| Stage 1.3 manifest floor on parse error | done | `committedFloor` in `manifest.ts` |
| Stage 1.4 guard-run core and audit | done | `guardrun.ts`; harness inferred or `--harness`; `source`; Pi blocks logged |
| Stage 1.5 turn record and initiator context | **not built** | design in PLAN 4c; never changes a decision |
| Stage 1.6 git config semantics | done | |
| Stage 1.7 secret-read search | done | time-boxed walk; walk time on real repos not measured |
| Stage 1.8 remote-tracking fetch | done | |
| Stage 1.9 unconditional wiring protection | partly | wiring is protected always; the per-rule override names are not split (only `ALLOW_PROTECTED` and `ALLOW_SECRET_READ` exist) |
| Stage 1.10 honest `status` tiers | not built | |
| Stage 1.11 adapter hardening | not built | OpenCode and Pi event shapes carry `harness` and `session_id`; nothing else |
| Stage 1.12 honest docs | not done | README, SECURITY.md:42, HARNESS-MATRIX, FAILURE_MODES, ADOPTION; only the CHANGELOG is current |
| Stage 2.1 landing model | done | own-branch resolution, merged-branch delete, lease, `update-ref` namespaces, `push-default` grant |
| Stage 2.2 remote-write rule | done | `gh api`, `curl`, `gh pr merge --admin\|--auto`, `gh repo delete\|edit` |
| Stage 2.3 credential stores, env-check | done | always on (the plan said an opt-out preset); `agent-flow env-check` |
| Stage 2.4 self-protection | mostly | uninstall and kill switches, default-ref moves, remote edits, history destruction, `.agent-flow` tamper, harness user config; deleting or moving the package path or `node_modules` is not covered |
| Stage 2.5 unattended runs | not built | absolute `--until` exists; needs-me dedupe and the brief landing line do not |
| Stage 2.6 first-run messages | not built | `install` and `init` |
| Stage 2.7 owner-trace benchmark | not re-run | re-run after the context layer, with `cd` following in |
| Later items | designed only | PLAN section 6, "Later" |

## Do next, in this order

1. Groundwork 1, 2, 5, 6: baseline on the published release, correct the eval records, build the sanitized owner-trace corpus, add the flip report. Everything after is measured against these.
2. Stage 1.5: prompt-hook handlers per adapter, the user-scope ring store, `attended` / `initiator` / `why` on audit lines, the ledger `initiator` column. Context only; it must not change a verdict.
3. Stage 1.10 and 1.11: honest `status`, the fail-closed wrapper, the `code-exec` tool kind, the Pi project-scope warning, the Codex hook-trust note.
4. Stage 2.5 and 2.6: needs-me dedupe, the brief landing line, first-run messages.
5. Stage 1.12: the docs, so they claim only what the code does. Do this last of the code work, then re-read every claim against the tests.
6. Re-run the owner-trace replay; targets are in PLAN section 6 (Stage 2.7) and section 7.
7. Arena gates (PLAN section 7) before any release. Release is a GitHub release that triggers `npm-publish.yml`; it needs the owner's explicit go.

## Decisions already made (do not reopen without the reversal condition in PLAN section 8)

- Prompt text is context, never authority. The only thing that widens the guard is a grant or pause a human creates.
- A human runs `grant`, `pause`, `revoke` with `!` (which bypasses hooks) or from another terminal; the hook denies an agent running them. No TTY requirement.
- A grant lifts only a plain landing push to the default branch, never force, delete, `:main` or `--all`. Pipeline roles are never relaxed.
- Relief by provable ownership (own branch, merged-branch delete, lease on a tracked branch) needs no grant.
- Decisions are taken with the advisor model; the owner does not want numbered or versioned plan labels, only one final plan.
- Dig for the full context of a block (did the user ask, why did the agent do it) from the transcripts before changing a rule; do not just do what was typed.
- Keep subagents to a minimum; do the work directly where possible.

## How to work on it

- Source is `extensions/**/*.ts` and `bin/agent-flow.js`; `extensions/**/*.js` is build output (`npm run build`). `skills/` and `templates/opencode/` are the sources for their copies; `tests/dogfood.test.js` fails on drift.
- Before finishing: `npm run lint` and `npm test`. Every guard change needs a regression test and a CHANGELOG line. No machine paths, keys or tokens in tracked files.
- Windows: write files containing backslashes with the Write or Edit tools, not shell heredocs. `node --test --test-name-pattern` silently runs nothing when the pattern misses. The full suite is slow on a shared machine.
- Prove changes on a real repo (the hypothesis-arena sibling) from a no-origin clone before any release.

## Human actions (not code)

- Rotate every key exposed in the raw session store: PLAN 2b "Hygiene" lists where they sit (an OpenRouter key, personal access tokens, and a test API key pasted into a chat turn). Values are never written in this repository and must not be.
- The key-shaped tokens in the local knowledge files (session 01a1af30) are outside the repository; redact them there if you keep that store.
- Decide when to cut a release; nothing here has been published.

## Known gaps and unmeasured things

- The owner-trace replay was last measured before `cd` following; push-default was fully relieved under a grant, explicit-refspec partly, ref-rewrite mostly, secret-read partly (the rest are genuine env reads; `env-check` is the alternative).
- Secret-read walk timing on large real repos is unmeasured.
- The corpus is one author on Windows; no frontier model has run under the guard. Treat friction numbers as indicative.
- The local `plan/` folder (gitignored) also holds the competitor deep-dives and the roadmap notes; they were deliberately not published.
