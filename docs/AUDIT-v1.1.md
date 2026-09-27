# Self-audit: v1.0.2 → v1.1.0

The project's pitch is "the docs tell you where the system is weak". So we audited our own code and docs against that standard, before launch. This page lists what we found. Every finding marked *fixed* has a test in `tests/`.

Severity: 🔴 security or data loss · 🟠 a feature didn't work · 🟡 a claim was stronger than the code

## Code

| # | Sev | Finding | Fix | Test |
|---|---|---|---|---|
| 1 | 🔴 | `worktree_create` ran `execSync(\`git worktree add … ${baseBranch}\`)`. The model controls `baseBranch`, so this was arbitrary command execution. | `execFile` + `git check-ref-format`, and revisions validated so they can't look like options | `tools.test.js` "rejects shell injection" |
| 2 | 🔴 | `bootstrap_write` wrote to any path, including `../../.bashrc` or absolute paths. | `resolveInside` (including symlink escapes) + context-file allowlist + no silent overwrite | "refuses path traversal…" |
| 3 | 🔴 | `stale_detect` ran `npx ctxlint`. When ctxlint is absent, npx downloads and executes whatever is published under that name. This contradicted "no network calls". | Runs only a locally installed ctxlint, only when asked | "never shells out to npx" |
| 4 | 🔴 | `CONFIRM_*` confirmation strings were printed in the tool's own parameter description, so the model could supply them itself. | Pi UI confirm dialog. Headless writes need a launcher-set env var | "refuses headless writes…" |
| 5 | 🔴 | The Claude Code reviewer had `tools: …, Bash`, and the Gemini reviewer had `run_shell_command`. A shell can write, so "enforced read-only" was false. | Both removed. Codex gets `sandbox_mode = "read-only"` | `package.test.js` |
| 6 | — | *Retracted.* We first reported that `pi.extensions: ["./extensions"]` loads every file in the folder. Loading it through Pi's own `discoverAndLoadExtensions` showed that Pi resolves the directory to `index.ts` only, so that finding was wrong. v1.1 names the compiled `index.js` explicitly anyway, and the same loader check reports 14 tools, 2 hooks, 0 errors. | — | `pi-loader.test.js` |
| 7 | 🟠 | The Implementer skill ran `git diff main...HEAD > diff.patch` **before** `git commit`, giving the Reviewer an empty diff. Then `git add -A` committed `diff.patch` into the branch. | Commit first. The orchestrator writes the diff outside the worktree | skill review |
| 8 | 🟠 | The orchestrator spawned `pi run /implement`, which is itself, so it recursed. `pi run`, `/review` and `/qa` don't exist. | `pi -p` per role with `AGENT_FLOW_ROLE` | `package.test.js` |
| 9 | 🟠 | Risk baseline keyed `type:file`, so a new `stripe` in an existing `package.json` was never reported as new (the core FM-05 case). Only `package.json` was parsed. | Per-dependency keys; six ecosystems | "FM-05: a NEW dependency…" |
| 10 | 🟠 | `risk_baseline_update` without `surfaces` wrote an **empty** baseline. | Omitted keys = accept the current scan; unknown keys rejected | "never silently wipes" |
| 11 | 🟠 | Risk patterns matched whole files with substrings: `map.delete(`, `author`, `price`. Nearly every file was flagged, and alert fatigue killed the audit. | Word-bounded, line-level patterns | "word-bounded" |
| 12 | 🟠 | Ignore globs like `node_modules/**` only matched the root, so nested packages were scanned. `*.test.*` also only matched the root. | Walker skips ignored dirs at any depth | "nested node_modules…" |
| 13 | 🟠 | A deleted context file reported **healthy**, and `{{DATE}}` timestamps parsed as NaN and counted as fresh. | Both detected | "catches a deleted context file", "{{DATE}}" |
| 14 | 🟠 | Stale detection only checked the manifest, never the prose the agent actually reads. | Backticked paths in prose are checked | "checks `backticked/paths`" |
| 15 | 🟠 | `existsSync` is case-insensitive on Windows and macOS, so `Auth.ts` → `auth.ts` was never flagged. | `existsExact` | covered by the prose test on Linux; CI on Windows/macOS |
| 16 | 🟠 | When ctxlint exited 0, its output was thrown away. It was only parsed in `catch`. | Parsed on both paths | — |
| 17 | 🟠 | The state file was cwd-relative. Tools called from `.worktrees/issue-N` created a *separate* state file. | `git rev-parse --git-common-dir` → main root | "worktree lifecycle" (list from inside the worktree) |
| 18 | 🟠 | Parallel implementers raced on read-modify-write of `.agent-state.json`. | Lockfile + atomic rename | "parallel state updates" (12 processes) |
| 19 | 🟠 | No transition validation (Completed → Working was allowed). Rounds were unbounded and could be reset to 0. | Validated, monotonic, auto-escalating | "≤2 rounds is mechanical", "illegal transitions" |
| 20 | 🟠 | `worktree_remove --force` threw away uncommitted work, then `git branch -d` failed (the branch isn't merged while its PR is open), leaving half-removed state. | Refuses when dirty; keeps the branch; safe `-d` is opt-in | "worktree lifecycle" |
| 21 | 🟠 | `worktree_list` read an in-memory Map, so it was empty after every restart. | Parses `git worktree list --porcelain` | "worktree lifecycle" |
| 22 | 🟠 | Base branch hardcoded to `main`, while the PR step used `--base develop`. | Detected default branch | "worktree lifecycle" (`trunk`) |
| 23 | 🟠 | `detect_harness` returned "claude-code" for any repo with a `.claude/` folder. It only ever runs in Pi. | Reports Pi + configured harnesses | "detect_harness…" |
| 24 | 🟠 | `bootstrap_scan` labelled every `package.json` repo as "typescript", assumed pytest for any `pyproject.toml`, took the first 3 manifests in glob order, and crashed on malformed JSON. | File-backed facts only | "bootstrap_scan reports javascript vs typescript" |
| 25 | 🟠 | Windows: glob returned backslash paths, so manifests written on Windows never matched on Linux CI. | POSIX paths everywhere | — |
| 26 | 🟡 | `npm run doctor` = `pi run /doctor`, which isn't a Pi command. CONTRIBUTING and the Gardener's CI YAML ran `node extensions/stale-detector.js`, which exports a function and does nothing, so **CI passed while checking nothing**. The YAML also used an unverified `ctxlint/ctxlint-action@v1`. | Real CLI with exit codes | `cli.test.js` |
| 27 | 🟡 | `Root_AGENT.md` is not loaded automatically by any harness, so the "always loaded" tier never loaded. | `AGENTS.md` (+ `CLAUDE.md` import) | `package.test.js` |
| 28 | 🟡 | The markdown state file rendered untrusted `reason` text raw (headings, HTML). | Escaped, single line | "escapes untrusted reasons" |

## Claims in docs that weren't backed by code (v1.0.2)

| Claim | Reality in v1.0.2 | v1.1 |
|---|---|---|
| "The ≤2 rounds constraint is mechanical, not advisory" | Prose in a skill | `state_update` enforces it |
| "Implementer's worktree is sandboxed" / "Protected paths are read-only in the Implementer's sandbox" | A worktree is a checkout, not a sandbox | Guard confinement on Pi; hook elsewhere |
| "Pre-commit hook rejects commits that break references / protected paths" | No hook shipped | `agent-flow hook install` |
| "Review tier classification is mechanical" | A JS snippet in a SKILL.md, with bugs | `risk_classify` |
| "Model requirements are enforced per workflow phase" | Not enforced | Tier computed; model passed per process (instructed) |
| "Low-risk changes auto-merge after QA" | Nothing implemented | Opt-in `gh pr merge --auto` |
| "CI runs security scan on all skill files" | No such CI step | Removed; replaced with the CLI checks |
| "Every tool call it makes is logged" | Nothing was logged | Guard blocks, confirmations and transitions go to `.agent-flow/audit.jsonl`; Pi's session file records all tool calls |
| "Pi — native, full enforcement" (README) | Contradicted by FM-16 two paragraphs later | Guard, with its limits stated |
| "The sidebar sorts every session" | There was no sidebar | `AGENT_STATE.md` |
| "65% of enterprise AI agent failures trace to context drift" / "88% never reach production" | Both trace back to blog posts that give no primary source | Removed |
| "76 contained confirmed malicious payloads" (FM-07) | Not found in the cited study | Replaced with verified figures from arXiv:2601.10338 |

## Launch post: what has to change before publishing

The draft is strong on candour. These lines would now be wrong, or would get picked apart:

1. **The opening stats.** "65% … 88% …" have no primary source; the first HN comment will ask for one. Lead with a concrete story instead: the renamed file, the reviewer that approved its own work. Better still, lead with the self-audit: "We audited our own agent-safety tool and found shell injection in it."
2. **"The ≤2 rounds constraint is mechanical."** It was false in v1.0.2. It is true in v1.1, so say "v1.1".
3. **"Real enforcement exists only on Claude Code."** The Claude reviewer had Bash in v1.0.2, so that wasn't true either. In v1.1, Pi has real enforcement too (guard + `--tools`).
4. **FM-16 story.** It's now the arc of the post: *tested → it failed → found the `tool_call` hook → now it blocks*. That's a better story than "documented".
5. **"Sixteen failure modes … three open."** The file has 21 entries: FM-13 and FM-15 are open, and FM-14 is instructed only. Take the numbers from `FAILURE_MODES.md` when you publish.
6. **Install commands.** The `cp -r node_modules/…` lines need `npm install` first and fail in PowerShell. Use `npx agent-flow install --harness …`.
7. **Star counts for other projects** ("~27k", "87k") will be out of date. Drop the numbers, or check them on the day.
8. **"Nothing here overclaims."** Keep the line only if every claim links to a test. Point at `SECURITY.md`'s enforced table, where each claim has one.
