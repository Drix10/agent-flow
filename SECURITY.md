# Security

Agent Flow runs next to autonomous agents that can edit your repository. This page separates what is **enforced**, **checked** and merely **instructed**, and shows you how to verify each claim yourself.

## Enforced (code blocks it, and a test proves it)

| Claim | Where | Test |
|---|---|---|
| Reviewer and QA can't `write`/`edit` on Pi | `extensions/guard.ts` → `lib/guard.ts` (`tool_call` hook) | `tests/guard.test.js` |
| Reviewer launched by the orchestrator has no write, edit or shell tool | `pi --tools read,grep,find,ls` in `skills/invoking-agents` | Pi's own flag |
| Claude Code reviewer subagent can't write or run shell | `.claude/agents/reviewer.md` → `tools: Read, Grep, Glob` | `tests/package.test.js` (static) + live-verified: launched the real subagent via the Task tool in a scratch repo and told it to create `TEST.md` by any means; it reported it had no tool that could write and the file did not exist on disk. Reproduce with the probe in [docs/HARNESS-MATRIX.md](./docs/HARNESS-MATRIX.md#verify-it-yourself). |
| Protected paths can't be written by any agent on Pi | guard | `tests/guard.test.js` |
| Implementer can't write outside `AGENT_FLOW_WORKTREE` | guard | `tests/guard.test.js` |
| No `--no-verify`, force-push, push to the default branch, re-roling or nested agent launches from agent roles | guard | `tests/guard.test.js` |
| File-writing tools need a **human** (Pi UI dialog). Headless writes need `AGENT_FLOW_HEADLESS_WRITES=1`, set by the launcher | `lib/confirm.ts` | `tests/tools.test.js` |
| Writes stay inside the repo: no `..`, absolute paths or symlink escapes | `lib/fsutil.ts#resolveInside` | `tests/tools.test.js` |
| No shell-string execution; git revisions and branches are validated | `lib/git.ts` (`execFile` + `check-ref-format`) | `tests/tools.test.js` |
| Review round cap and legal state transitions | `lib/state.ts` | `tests/tools.test.js`, `tests/cli.test.js` |
| Secret values are never printed or written | `lib/risk.ts#findSecrets` (kind + line only) | `tests/tools.test.js`, `tests/cli.test.js` |

## Checked (detected and reported; someone still has to act)

- **Pre-commit hook** (`agent-flow hook install`) blocks commits that touch protected paths, contain secret-shaped strings, or *introduce* broken context references (older drift is a warning). It works in any harness. A human can bypass it with `git commit --no-verify`; the guard stops agents on Pi from doing so.
- **`agent-flow doctor` / `audit-risk --fail-on-new`** in CI.

## Instructed only (be clear-eyed about this)

- **Shell commands from read-only roles** are blocked by pattern analysis, which is best-effort. An interpreter trick we don't recognise can still write. For a hard guarantee, launch read-only roles without `bash` (`--tools read,grep,find,ls`) or inside a container.
- **Gemini reviewer definition** relies on its tool list having no write/shell entries. Verify with a "write TEST.md" probe before you rely on it.
- **Codex reviewer** should be launched with `codex exec --sandbox read-only` — a real, OS-level sandbox flag we checked against `codex exec --help` (v0.157.1), not a prompt-only restriction. We could not run the live write-block probe ourselves (no Codex account in our test environment), so it's listed here rather than in "Enforced" above; if you run the probe, please report the result. Don't rely on `.codex/agents/reviewer.toml` being auto-discovered — that path is unverified.
- **Cursor and Copilot:** skills only. Read-only is an instruction there.
- **`allowed-tools` in SKILL.md is not enforcement** on any harness we tested (FM-16).

## Audit this package in 10 minutes

1. **Dependencies:** `npm ls --omit=dev --all` shows nothing. There are zero runtime dependencies.
2. **Network:** `grep -rnE "fetch\(|https?\.request|net\.connect|npx " extensions/lib/*.ts bin` finds no network call. The only hits are the "never npx" comment in `lib/stale.ts` and `npx --no-install` in the pre-commit hook text, and `--no-install` forbids downloading.
3. **Process execution:** `grep -rn "execFileSync\|execSync\|spawn" extensions/lib/*.ts bin`. The real calls are `execFileSync("git", [...])` and a locally installed ctxlint run through `process.execPath` (opt-in). Every other hit is a comment, a detection regex, or guard text.
4. **Tests:** `npm test`. They run against real git repositories in temp directories.
5. **Package contents:** `npm pack --dry-run` lists exactly what ships (`bin/`, `extensions/`, `skills/`, `templates/`, `schemas/`, `prompts/`, `docs/`, the harness reviewer definitions, and the Markdown docs).

## Known risk data

A 2026 study of 31,132 public agent skills found 26.1% contain at least one vulnerability (data exfiltration 13.3%, privilege escalation 11.8%). Skills that bundle executable scripts were 2.12× more likely to be vulnerable than instruction-only skills ([Liu et al., arXiv:2601.10338](https://arxiv.org/abs/2601.10338)). Agent Flow does bundle code. That is why it has no dependencies, makes no network calls, and has a test for every security claim above.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** (Security → Report a vulnerability) on https://github.com/Drix10/agent-flow rather than a public issue. Include the steps to reproduce and the relevant `.agent-flow/audit.jsonl` lines. Scrub any tokens first.
