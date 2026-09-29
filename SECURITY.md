# Security

Agent Flow runs next to autonomous agents that can edit your repository. This page separates what is **enforced**, **checked** and merely **instructed**, and shows you how to verify each claim yourself.

## Enforced (code blocks it, and a test proves it)

| Claim | Where | Test |
|---|---|---|
| Reviewer and QA can't `write`/`edit` on Pi | `extensions/guard.ts` → `extensions/lib/guard.ts` (`tool_call` hook) | `tests/guard.test.js` |
| Reviewer launched by the orchestrator has no write, edit or shell tool | `pi --tools read,grep,find,ls` in `skills/invoking-agents` | Pi's own flag |
| Claude Code reviewer subagent can't write or run shell | `.claude/agents/reviewer.md` → `tools: Read, Grep, Glob` | `tests/package.test.js` (static) + live-verified: launched the real subagent via the Task tool in a scratch repo and told it to create `TEST.md` by any means; it reported it had no tool that could write and the file did not exist on disk. Reproduce with the probe in [docs/HARNESS-MATRIX.md](./docs/HARNESS-MATRIX.md#verify-it-yourself). |
| Protected paths can't be written by any agent's file tools (Pi, and Claude Code with the `agent-flow guard` hook) | guard | `tests/guard.test.js` |
| Implementer's **file tools** can't write outside `AGENT_FLOW_WORKTREE`, including through symlinks. Its shell is only best-effort confined — see below | guard (`decideWrite`) | `tests/guard.test.js`, `tests/hardening.test.js` |
| Trust files (`.agent-state.json`, `AGENT_STATE.md`, `.agent-flow/audit.jsonl`, `.risk-baseline.json`, `.git/`) can't be written by file tools (or by `bootstrap_write`); only agent-flow's own tools and CLI change them | guard | `tests/guard.test.js`, `tests/hardening.test.js` |
| File-writing tools need a **human** (Pi UI dialog). Headless writes need `AGENT_FLOW_HEADLESS_WRITES=1`, set by the launcher | `extensions/lib/confirm.ts` | `tests/tools.test.js` |
| Writes stay inside the repo: no `..`, absolute paths or symlink escapes. `bootstrap_write` also refuses trust files and manifest `protected_paths` | `extensions/lib/fsutil.ts#resolveInside` | `tests/tools.test.js` |
| No shell-string execution; git revisions and branches are validated | `extensions/lib/git.ts` (`execFile` + `check-ref-format`) | `tests/tools.test.js` |
| Review round cap and legal state transitions | `extensions/lib/state.ts` | `tests/tools.test.js`, `tests/cli.test.js` |
| Secret values are never printed or written | `extensions/lib/risk.ts#findSecrets` (kind + line only) | `tests/tools.test.js`, `tests/cli.test.js` |

## Your files stay yours

Anything agent-flow rewrites was probably edited by a person first. `bootstrap_write` keeps line endings, BOM and manifest indentation, backs the old file up under `.agent-flow/backups/`, and refuses a manifest that drops `protected_paths`, `risk_boundaries` or any other key the current one has. `install --harness claude` merges into `.claude/settings.json` without touching other hooks (they keep their matcher group), does not import a symlinked `CLAUDE.md` into itself, and `hook install` keeps a pre-commit hook it didn't write unless `--force` (then it is saved as `pre-commit.bak-<time>`). `init` never overwrites and does not generate an `AGENTS.md` beside a `CLAUDE.md` that already holds rules. Tests: `tests/hardening.test.js`.

## Checked (detected and reported; someone still has to act)

- **Pre-commit hook** (`agent-flow hook install`) blocks commits that touch protected paths, contain secret-shaped strings (a known fake is allowed with an `agent-flow:allow-secret` comment on or above the line, or `secret_scan.ignore_paths` in the manifest), or *introduce* broken context references (older drift is a warning). It works in any harness. A human can bypass it with `git commit --no-verify`; the guard stops agent sessions on Pi and Claude Code (with the hook) from doing so, as far as shell analysis can see (below).
- **`agent-flow doctor` / `audit-risk --fail-on-new`** in CI (`--sarif` for code scanning; `action.yml` wraps them).
- **Audit log is tamper-evident:** each line of `.agent-flow/audit.jsonl` carries the hash of the line before it, so `agent-flow audit verify` finds an edited, deleted, inserted or reordered line. An agent that can write the file can also rewrite the whole chain, so anchor `agent-flow audit head` where it can't (a commit made by a human, a CI artifact) and check with `audit verify --anchor <hash>`.
- **Gates are observed, not claimed:** manifest `gates` are run by the orchestrator (`agent-flow gates run`), from the main checkout's manifest, with the exit code, log and SHA-256 recorded; `reviewer` and `qa` are blocked from running them. A command that runs a gate can still be a weak test: this proves it ran and what it returned, not that it tests the right thing.
- **Manifest `policy`** (`max_changed_files`, `max_diff_lines`, `forbid_patterns`, `require_tests`) is checked by `classify --fail-on-policy` and the pre-commit hook. A human can `--no-verify` past the hook; CI running `classify --fail-on-policy` is the backstop.

## Best-effort (shell pattern analysis — blocks the obvious, not a determined model)

The guard can only read a shell command's text. It lexes it (quotes, redirections, `cd`, `sh -c '…'`) and pattern-matches it; anything that happens inside an interpreter (`python -c`, `node -e`, a script file) or behind a variable is invisible to it. For a hard guarantee, remove the shell tool or run the agent in a container/sandbox — and protect `main` on the remote.

- **Protected paths are directories too.** `research/ledger/**` also protects `research/ledger`; `rm`/`mv` of a protected directory or a parent of one (up to `rm -rf .`) is blocked, as are whole-tree git rewrites (`reset --hard`, `clean -f`, `stash`, `checkout .`, `restore .`, targeted forms that reach a protected path) while `protected_paths` is set. Protection committed to `HEAD` survives deleting or emptying the manifest on disk, and a broken guard refuses the call when a manifest exists. Tests: `tests/hardening.test.js`.
- **The guard protects its own wiring:** while `protected_paths` is set, no session edits `.claude/settings*.json` or the installed `node_modules/@drix10/agent-flow/`, or removes `.git` (a human overrides with `AGENT_FLOW_ALLOW_PROTECTED=1`). The installed hook matcher covers every tool the guard has rules for (writes, shell, `Read`/`Grep`/`Glob`, MCP); a test keeps the two in step. Git-host MCP writes (`push_files`, `create_or_update_file`, `delete_file`) to the default branch, or with no branch named, are blocked, and pipeline roles can't `merge_pull_request`. The committed floor is the union of `HEAD` and the default branch, so a weaker manifest committed on a branch lowers nothing. Evidence: `tests/redteam/corpus.json` (blocked, allowed and documented-gap cases, run by `npm test`).
- **Secrets stay out of context:** reading an env file (`.env`, `.env.local`, `.env2`, …) or a manifest `deny_read` path is blocked through the shell (`cat`, `grep`, `source`, `< .env`, `--env-file=`) and through read tools, for every session; `AGENT_FLOW_ALLOW_SECRET_READ=1` (a human) lifts it. It also catches `curl -F f=@.env`, `git show HEAD:.env` and `git diff .env`. A recursive `grep -r` over a directory that happens to hold one is not detected.
- **Git safety, for every agent session, role or not** (the guard only sees agent tool calls, never your own terminal): no `--no-verify` or `-n` on commit (in any abbreviation git accepts, e.g. `--no-verif`), no `core.hooksPath` changes, no force-push (`-f`, `--forc…`, `+ref`, `--mirror`, `--prune`), no remote-branch deletion (`-d`, `--delete`, `:branch`), no push to the default branch. Tests: `tests/guard.test.js`, `tests/hardening.test.js`.
- **Implementer shell confinement:** redirect targets (`>`, `>>`, `>|`, `&>`, `2>`) and the destination/target paths of common write verbs (`cp`, `mv`, `tee`, `install`, `ln`, `touch`, `rm`, `rmdir`, `mkdir`, `truncate`, `sed -i`, `perl -i`, `dd of=`) are resolved against the command's working directory (following `cd`), through symlinks, and blocked outside `AGENT_FLOW_WORKTREE`. A target the guard can't resolve (a variable, `$(…)`, brace expansion, a glob that could match `..`) is refused. The same resolution applies protected paths to shell writes for every role.
- **Read-only roles (reviewer, QA)** can't run mutating shell commands we recognise: redirections, write verbs (also behind `sudo`/`env`/`nice`/`timeout`/`xargs` or quoted as `"rm"`), in-place editors, formatters in write mode, `find -delete`/`-exec rm`, mutating git/gh/package-manager calls, downloads to disk.
- **Pipeline roles can't re-role themselves, launch nested agents, or use the CLI twins of tools their role may not call** (`agent-flow state update`, `baseline accept`, `repair`, `worktree create|remove`; `install` and `hook install` for any role).

## Instructed only (be clear-eyed about this)

- **Gemini reviewer definition** relies on its tool list having no write/shell entries. Verify with a "write TEST.md" probe before you rely on it.
- **Codex reviewer** should be launched with `codex exec --sandbox read-only` — a real, OS-level sandbox flag we checked against `codex exec --help` (v0.157.1), not a prompt-only restriction. We could not run the live write-block probe ourselves (no Codex account in our test environment), so it's listed here rather than in "Enforced" above; if you run the probe, please report the result. `.codex/agents/reviewer.toml` is for interactive delegation only; the pipeline never relies on it.
- **Cursor, Copilot and Windsurf:** skills only. Read-only is an instruction there.
- **`allowed-tools` in SKILL.md is not enforcement** on any harness we tested (FM-16).

## Audit this package in 10 minutes

1. **Dependencies:** `npm ls --omit=dev --all` shows nothing. There are zero runtime dependencies.
2. **Network:** `grep -rnE "fetch\(|https?\.request|net\.connect|npx " extensions/lib/*.ts bin` finds no network call. The only hits are the "never npx" comment in `extensions/lib/stale.ts` and `npx --no-install` in the pre-commit hook text, and `--no-install` forbids downloading.
3. **Process execution:** `grep -rn "execFileSync\|execSync\|spawn" extensions/lib/*.ts bin`. The real calls are `execFileSync("git", [...])` and a locally installed ctxlint run through `process.execPath` (opt-in). Every other hit is a comment, a detection regex, or guard text.
4. **Tests:** `npm test`. They run against real git repositories in temp directories.
5. **Package contents:** `npm pack --dry-run` lists exactly what ships (`bin/`, `extensions/`, `skills/`, `templates/`, `schemas/`, `prompts/`, `docs/`, the harness reviewer definitions, and the Markdown docs).

## Known risk data

A 2026 study of 31,132 public agent skills found 26.1% contain at least one vulnerability (data exfiltration 13.3%, privilege escalation 11.8%). Skills that bundle executable scripts were 2.12× more likely to be vulnerable than instruction-only skills ([Liu et al., arXiv:2601.10338](https://arxiv.org/abs/2601.10338)). Agent Flow does bundle code. That is why it has no dependencies, makes no network calls, and has a test for every security claim above.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** (Security → Report a vulnerability) on https://github.com/Drix10/agent-flow rather than a public issue. Include the steps to reproduce and the relevant `.agent-flow/audit.jsonl` lines. Scrub any tokens first.
