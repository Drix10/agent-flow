# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-09-27

A self-audit found that several documented guarantees were prose rather than code, and that the code had security bugs. This release fixes them. A second, adversarial pass before the first tag found five more (round-cap bypass, a glob-matching gap in the guard, a lock-staleness race, and two minor path/regex bugs) plus a deploy gap where two GitHub-native files had silently reverted to their v1.0.2 content, and a Windows-only CI failure traced to a missing `.gitattributes`. Full list: [docs/AUDIT-v1.1.md](./docs/AUDIT-v1.1.md).

### Security
- **Fixed shell injection** in `worktree_create`. `baseBranch` was interpolated into a shell string. All git calls now use `execFile` with validated refs.
- **Fixed path traversal** in `bootstrap_write`. Writes are confined to the repo, can't escape through symlinks, and are limited to context-file types.
- **Removed `npx ctxlint`**, which could download and execute a package. A locally installed ctxlint runs only on request.
- **Confirmation is real.** `CONFIRM_*` strings (which the model could read and supply itself) are replaced by a Pi UI dialog. Headless writes need `AGENT_FLOW_HEADLESS_WRITES=1`.
- **Claude Code and Gemini reviewer definitions no longer grant a shell.** A shell can write files, so "read-only" wasn't true. Codex reviewer uses `sandbox_mode = "read-only"` via `codex exec --sandbox read-only` or a `--profile` (see below — the initial `[agents.reviewer]` config.toml syntax was corrected before release).
- **Secret detection** in the risk audit, bootstrap and pre-commit hook. Values are never printed.
- **`state_update`'s round cap could be bypassed.** `reopen: true` rewound the round counter on any session, not just a `Completed` one — a way to dodge the auto-escalation to `Needs Me` that rounds are supposed to guarantee. Now gated on the session actually being `Completed`.
- **The guard's shell check missed leading-wildcard `protected_paths`** (`*.env`, a globbed `secrets` pattern) because it only matched a pattern's literal *prefix*, which is empty for those. Now matches any literal chunk of the pattern.
- **`withLock` could break a live holder's lock**, not just a crashed one's — it only checked file age, with no way to tell the two apart. The lock now carries its holder's PID and is broken the moment that PID is confirmed dead, with age kept only as a fallback.

### Added
- **Guard** (`extensions/guard.ts`). Pi `tool_call` hook with role-based enforcement via `AGENT_FLOW_ROLE`:
  - reviewer/qa read-only;
  - implementer worktree confinement;
  - protected paths;
  - tamper-proof state files;
  - no `--no-verify`, force-push, push to the default branch, re-roling or nested agents.
  Closes FM-16 on Pi.
- **`risk_classify`** tool and `agent-flow classify`. Mechanical risk from the real diff (replaces a JS snippet the model was asked to "run").
- **`agent-flow` CLI** (zero dependencies): `doctor`, `audit-risk`, `baseline accept`, `classify`, `check-staged`, `state`, `worktree`, `scan`, `install --harness`, `hook install`.
- **Pre-commit hook**: protected paths, secrets, broken context references.
- **Prose drift detection**: every `backticked/path` in context files is checked. Checks are case-exact on Windows and macOS.
- `schemas/context-manifest.schema.json`. The manifest is validated on write (FM-17).
- `.agent-flow/audit.jsonl`: guard blocks, confirmations, state transitions.
- FM-19 (prompt injection), FM-20 (unattended writes), FM-21 (parallel state corruption).

### Changed
- **Context files are now `AGENTS.md`** (root + per module). No harness auto-loads `Root_AGENT.md`. Claude Code imports it through `CLAUDE.md`.
- **State machine** validates transitions, keeps rounds monotonic, auto-escalates above `pipeline.max_review_rounds`, requires a reason for Needs Me, and records history. Writes are locked and atomic, at the main repo root.
- **Risk audit**:
  - every dependency is a surface, so new dependencies are detected (v1.0 missed them in existing manifests);
  - parses npm, pip, pyproject, Go, Cargo and Bundler manifests;
  - word-bounded, line-level patterns;
  - nested `node_modules` and tests are ignored;
  - the baseline is never silently wiped.
- **Worktrees**:
  - the default branch is detected (not hardcoded `main`/`develop`);
  - leftover branches are reused;
  - removal refuses to discard uncommitted work and keeps the branch;
  - the list comes from git;
  - `.worktrees/` is excluded locally.
- **Orchestrator skill**:
  - separate process per role, with the concrete launch command for Claude Code (`claude -p`), Codex CLI (`codex exec`) and Pi (`pi -p`) shown side by side, not just documented for Pi;
  - artifact packets;
  - the Reviewer is launched read-only: `--tools read,grep,find,ls` (Pi), the `reviewer` subagent (Claude Code, `tools: Read, Grep, Glob`), `--sandbox read-only` (Codex CLI);
  - QA flake re-run and a tree-mutation check;
  - draft PRs for critical changes;
  - opt-in auto-merge;
  - untrusted-issue handling.
- **`install --harness`** now also targets `windsurf`, and is tested for every target (`claude`, `codex`, `gemini`, `cursor`, `copilot`, `windsurf`, `agents`), not just `claude`: `--dry-run` writes nothing, `--force` overwrites, re-running is a no-op. Claude Code and Codex CLI are the primary, most-tested targets; Pi remains fully supported but is no longer the lead example in the docs. Any other [AGENTS.md](https://agents.md)-reading tool (Aider, Zed, Warp, JetBrains Junie, RooCode, Amp, opencode, goose, and more) already gets drift detection and risk classification from the CLI unmodified — see [docs/HARNESS-MATRIX.md](./docs/HARNESS-MATRIX.md).
- **Implementer skill**: commits *before* diffing. v1.0 diffed first (an empty diff) and committed `diff.patch` into the branch.
- `detect_harness` reports Pi as the runtime and lists configured harnesses, instead of guessing from folder names.
- `pi.extensions` names the compiled `extensions/index.js` explicitly. Verified with Pi's own loader: 14 tools, 2 hooks, no errors.
- Zero runtime dependencies (removed `glob`, `yaml`, `zod`; `typebox` is supplied by Pi).
- CI runs on Linux, macOS and Windows. Added `.gitattributes` (`* text=auto eol=lf`) — its absence was letting `actions/checkout` on `windows-latest` rewrite every text file to CRLF, which broke an exact `\n`-anchored regex in the skill-frontmatter test. Windows-only, deterministic, and unrelated to any of this release's actual code; see [docs/AUDIT-v1.1.md](./docs/AUDIT-v1.1.md).
- Added a demo GIF and two short screen recordings under `demo/`, linked from the README.

### Removed
- `pi run …` npm scripts and skill references. `pi run` is not a Pi command.
- Unsourced statistics from the README and docs.

### Migration
See "Upgrading from 1.0.x" in [README-COMPATIBILITY.md](./README-COMPATIBILITY.md).

## [1.0.2] - 2026-09-26
- Publish to npm and GitHub Packages. FM-16/17/18 documented.

## [1.0.0] - 2026-09-26
- Initial release: bootstrap, worktree, state machine, stale detector, risk auditor extensions; six skills; templates; FAILURE_MODES.md.
