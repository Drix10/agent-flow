# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- The guard no longer throws on a command whose first word is `constructor`; an ordinary session used to fail open on that error and skip the protected-path check.
- A gitignore-style `protected_paths` entry with a leading slash (`/config/`) now matches; it used to protect nothing.
- `bootstrap_write` refuses `AGENT_STATE.md` and manifest `protected_paths`, like every other write tool.
- The Pi `tool_call` hook fails closed for a confined role when the guard errors, matching `agent-flow guard`.

### Fixed
- Paths inside the repo that begin with `..` (`..data/`) are no longer treated as outside it.
- `schema`/`report` with a prototype-named role (`toString`) and a bare `state update --round` are usage errors instead of a crash / a silent round 1.
- `pyproject.toml` dependencies after an extras bracket (`requests[security]`) and `[project.optional-dependencies]` are audited.
- `state_update` bounds `phase` (80) and `reason` (2000) for the CLI too; `reopen` can't target `Completed`.
- The CLI sets `process.exitCode` instead of calling `process.exit()`, so large piped output isn't truncated on macOS and Windows.
- GitHub Packages publish runs the test suite first, like the npm publish.

### Docs
- README, SECURITY, FAILURE_MODES, HARNESS docs and TRUST_LOOP now describe the Claude Code `agent-flow guard` hook, what the audit log records, and the real install targets; the roadmap no longer lists shipped work.

Rows #77–83 in [docs/AUDIT-v1.1.md](./docs/AUDIT-v1.1.md).

## [1.1.2] - 2026-09-28

### Security
- Bare `git push` (no refspec) is blocked: git would have pushed the checked-out branch, default branch included. Dry runs and tag-only pushes are unaffected.
- `git fetch` with a `<src>:<dst>` refspec is blocked: it rewrites local branches while looking like a read. Plain fetches only move remote-tracking refs and stay allowed.
- `git update-ref` and non-list `git replace` are blocked: direct ref and object rewrites outside every branch protection here.

### Fixed
- `state show` / `state update` with a bare `--issue` no longer silently target issue 1; a missing `--manifest` value no longer leaks a `TypeError`; `--reason` keeps values containing `=`.
- `repairStale` types extensionless paths by the filesystem instead of the name.
- Launch commands use only flags the supported CLIs offer; Codex's strict-schema output and read-only sandbox, and Pi's read-only tool list, verified against live sessions.
- Root `plugin.json` version corrected to 1.1.1; removed a README badge pointing at a directory the package was never listed in.

Full list with a regression test per row: [docs/AUDIT-v1.1.md](./docs/AUDIT-v1.1.md) rows #67–76.

## [1.1.1] - 2026-09-28

A pre-integration review (three independent reviewers plus a QA sweep of ~200 everyday commands) found and fixed audit rows #37–66: guard bypasses and false positives, a fail-open on an unparseable manifest, a lock race, and a Codex/Gemini pipeline that would not have run. Details and a regression test per row: [docs/AUDIT-v1.1.md](./docs/AUDIT-v1.1.md).

### Added
- **Zero-setup `doctor`.** With no manifest it finds every context file (AGENTS.md, CLAUDE.md, GEMINI.md, `.cursorrules`, Copilot and Windsurf rules), checks every path they mention, and suggests the likely rename ("did you mean …?").
- **`agent-flow init`** writes a starter manifest (and an honest AGENTS.md skeleton if there is none) without an LLM.
- **Runnable pipeline on four harnesses:** strict JSON schemas for Codex (`schema --strict`), Gemini envelope unwrapping, background role runs with timeouts, crash resume, idempotent PRs, per-launch budgets and an audit line per role run (`report --harness`).
- Unknown commands, flags and harness names get a "did you mean" instead of a help dump.

### Security
- No agent session, pipeline role or not, may skip hooks (incl. abbreviated `--no-verif`), force-push, delete remote branches or push to the default branch.
- Read-only roles can't mutate pipeline state through the CLI twins; one allow list serves the shell guard and the CLI.
- A present-but-unparseable manifest fails closed for writes instead of disabling protection.
- Non-ASCII filenames no longer skip the pre-commit hook; `.risk-baseline.json` is tamper-proof; implementer shell writes are checked against the worktree (best-effort).

### Fixed
- Guard false positives: commit messages, echo text and grep patterns naming a protected path; `git config`; read-only git/tee/curl forms for reviewer and QA.
- `withLock` race and crash-left empty locks; prose drift false positives; typed manifest validation; `max_review_rounds` must be 1–5.

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

### Removed
- `pi run …` npm scripts and skill references. `pi run` is not a Pi command.
- Unsourced statistics from the README and docs.

### Migration
See "Upgrading from 1.0.x" in [README-COMPATIBILITY.md](./README-COMPATIBILITY.md).

## [1.0.2] - 2026-09-26
- Publish to npm and GitHub Packages. FM-16/17/18 documented.

## [1.0.0] - 2026-09-26
- Initial release: bootstrap, worktree, state machine, stale detector, risk auditor extensions; six skills; templates; FAILURE_MODES.md.
