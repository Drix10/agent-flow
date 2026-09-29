# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- **`git push origin HEAD` reached the default branch.** `HEAD`, `@`, an empty target and dynamic targets (`HEAD:$(…)`, `HEAD:refs/heads/$B`, globs) now get the same `explicit-refspec` block as a bare `git push`, because the guard can't see which branch is checked out. Name the branch: `git push origin agent/issue-N`.
- **Roles could spawn agents through the harness's own tool.** `Task`, `Agent`, `subagent` and similar tools are refused for every role except the orchestrator, matching the shell rule for `claude -p`.
- **Read-only roles: more write paths recognised.** Archive extraction (`tar x`, `unzip`, `7z x`, `gunzip`…), `awk` redirects and `system()`, `php -r` writes, `sqlite3` mutations and `python -c` with `os.system`/`subprocess`. Listing an archive (`tar t`, `unzip -l`) stays allowed.

### Fixed (docs)
- `HARNESS-MATRIX.md`: the "Protected paths" row showed ✅ for harnesses that only have the pre-commit hook; it now says so. The Codex reviewer cell no longer claims a live write-block probe that was not run. The Gemini reviewer cell and `.gemini/agents/reviewer.md` now match `launch.md` (default approval mode; Gemini has no `plan` mode in this version), and the matrix states that Gemini's Implementer and QA run under `yolo`.
- README: "separate processes" is qualified with "when the pipeline runs as documented" (FM-18).

## [1.1.4] - 2026-09-29

Two reviews of the guard (one on a repo with an append-only ledger, frozen specs and secrets; one on the fixes to that) closed 16 of 43 attack cases that used to pass, and made agent-flow safe to adopt in a repository that already has rules, a task file and paths that must not change. Every row has a regression test: [docs/AUDIT-v1.1.md](./docs/AUDIT-v1.1.md) #77–95.

### Added
- **Tamper-evident audit log.** Every `.agent-flow/audit.jsonl` line carries `prev` and `hash` (SHA-256 over the previous hash and the line), written under a lock. `agent-flow audit verify [--anchor <hash>]` reports the first edited, deleted, inserted or reordered line and exits 1; `audit head` prints the hash to record in a commit or CI; `audit summary` counts guard blocks per role and rule, escalations, rounds per issue and role-run cost. Logs written before 1.1.4 verify as "from before chaining". Tamper-evident is not tamper-proof: anchor the head somewhere the agent can't write.
- **Gates.** A manifest `gates` list (`name`, `command` as a string or an argv array, `cwd`, `timeout_seconds`, `expect_exit`, `required`) that the orchestrator runs with `agent-flow gates run [--name a,b] [--issue n]`. Each run leaves a log, its SHA-256, a JSON report and an audit line; exit 1 = a required gate failed, 2 = a gate couldn't run at all (fix the environment, don't spend a review round). The manifest is read from the main checkout, so a branch can't edit the gate that judges it, and `reviewer`/`qa` can't run `gates run`. The orchestrator skill runs gates before QA.
- **Manifest `policy` rules.** `max_changed_files`, `max_diff_lines`, `forbid_patterns` (a regex over added lines, optionally scoped to paths) and `require_tests` (changes under these paths need a change under those). `classify --fail-on-policy` checks the branch diff, including untracked files; the pre-commit hook checks the staged content. `classify --fail-on-heuristic` fails when no `risk_boundaries` exist, so CI can refuse to trust a path-name guess.
- **SARIF 2.1.0.** `doctor --sarif` and `audit-risk --sarif` for GitHub code scanning (file and line locations, no secret values).
- **`action.yml`.** A composite GitHub Action (`uses: Drix10/agent-flow@v1.1.4`) that runs `doctor`, `audit-risk --fail-on-new` and `classify --fail-on-protected --fail-on-policy`, and can upload SARIF. It has not run on GitHub yet: the commands it calls are covered by tests, the YAML wrapper is not.
- **Docs can't drift from the CLI.** `npm test` fails when a doc or skill names an `agent-flow` command or flag that doesn't exist, or a backticked repo path that isn't there.

### Security
- **Protected directories.** `dir/**` matches `dir` itself, and `rm`/`mv`/`find -delete` of a protected directory or any parent of one (up to `rm -rf .` and `rm -rf .git`) is blocked for every session. Brace expansion, `git -C dir`, and `tar -C`/`unzip -d` destinations are resolved like any other write. A directory too large to inspect is assumed to hold a protected path.
- **Whole-tree git rewrites** (`reset --hard`, `clean -f`, `stash`, `checkout .`/`-f`, `restore .`, and targeted `checkout`/`restore`/`rm`/`mv` that reach a protected path) are blocked while `protected_paths` is set.
- **Guard wiring, hooks and manifest are off limits** to every session: `.git/hooks/*`, `CONTEXT_MANIFEST.json`, `.claude/settings*.json` and the installed agent-flow can't be edited, deleted, moved or `chmod`-ed by an agent (a human overrides with `AGENT_FLOW_ALLOW_PROTECTED=1`). `chmod -x file` is parsed as a mode, not an option.
- **Protection is a floor.** `protected_paths` and `deny_read` committed to `HEAD` or to the default branch still apply if the manifest is deleted, emptied, or weakened on a feature branch.
- **The guard fails closed** on its own errors (unreadable input, a crash) whenever a manifest exists on disk or at `HEAD`, or `AGENT_FLOW_GUARD_STRICT=1`; the Pi hook does the same. Only an unconfigured session is left alone. The guard no longer throws on a command whose first word is `constructor`, which used to fail open.
- **Secrets stay out of context.** Real env files (`.env`, `.env.local`, `.env2`, `.env_prod`, `prod.env`, …) and manifest `deny_read` paths can't be read by an agent through the shell (`cat`, `grep`, `source`, `< .env`, `--env-file=`, `curl -F f=@.env`, `git show HEAD:.env`, `mv`/`ln`/`cp`) or a read tool; `AGENT_FLOW_ALLOW_SECRET_READ=1` (a human) lifts it. The installed hook matcher now includes `Read`, `NotebookRead`, `Grep` and `Glob`, so the rule actually runs in Claude Code.
- **Remote pushes.** Git-host MCP tools (`push_files`, `create_or_update_file`, `delete_file`) can't write to the default branch or with no branch named, are checked against protected paths, and pipeline roles can't `merge_pull_request`.
- A gitignore-style `protected_paths` entry with a leading slash (`/config/`) matches; it used to protect nothing. `bootstrap_write` refuses `AGENT_STATE.md` and manifest `protected_paths`, like every other write tool.
- The secret scanner finds credentials assigned to secret-named variables (`APCA_API_SECRET_KEY=…`, `FRED_API_KEY=…`, `password = "…"`) while skipping placeholders, config references and identifiers.

### Changed
- **Existing files are preserved.** `bootstrap_write` on an existing file keeps its line endings, BOM and manifest indentation, saves a backup under `.agent-flow/backups/`, shows the human what is removed, and refuses a manifest that drops `protected_paths`, `risk_boundaries` or any other existing key. `repair` keeps the manifest's indentation and line endings and takes a lock. `install --harness claude` keeps a user's other hooks in a shared matcher group, won't import a symlinked `CLAUDE.md` into itself, and refuses a malformed `hooks` shape. `hook install` treats only its own header as "ours" and backs up a foreign hook on `--force`. `init` no longer generates an `AGENTS.md` beside a `CLAUDE.md`/`GEMINI.md`/`.cursorrules` that already holds rules, and suggests `protected_paths` from directories that exist (it writes none).
- **Secret scanner allowlist.** `agent-flow:allow-secret` on or above a line, or `secret_scan.ignore_paths` in the manifest, exempts a known fake (agents writing files can't use the marker). The pre-commit check reads staged files through one `git cat-file --batch` instead of a process per file.
- **Scans use git's file list** when it is available (tracked plus untracked-not-ignored files), so untracked gitignored trees are not walked: a scan of a repo with a 7 GB ignored `data/` directory no longer takes minutes. Outside git, or when the root isn't the repository's top level, they fall back to a directory walk. Tracked files are always scanned. Ignored env files are no longer reported as "present in the working tree".
- **CI checkouts.** `classify` falls back to `origin/<default>` when a detached PR checkout has no local default branch; `doctor` finds context files that are symlinks to a file in the repo (links out of the repo are ignored).
- `scan` recognises C/C++ (CMake, ctest, GoogleTest, Catch2), PHP, Swift, Elixir and Dart.
- `state_update` bounds `phase` (80) and `reason` (2000) for the CLI too; `reopen` can't target `Completed`.
- `tests/redteam/corpus.json`: a table of blocked, allowed and documented-gap cases that `npm test` runs, and `.pre-commit-hooks.yaml` for pre-commit.com users.
- GitHub Packages publish runs the test suite first, like the npm publish.

### Fixed
- Paths inside the repo that begin with `..` (`..data/`) are no longer treated as outside it.
- `schema`/`report` with a prototype-named role (`toString`) and a bare `state update --round` are usage errors instead of a crash / a silent round 1.
- `pyproject.toml` dependencies after an extras bracket (`requests[security]`) and `[project.optional-dependencies]` are audited.
- Repeated `git -C a -C b` accumulates; the git file list keeps literal backslashes in POSIX names and drops paths that leave the repo through a symlinked directory.

### Docs
- New [docs/ADOPTION.md](./docs/ADOPTION.md): what agent-flow writes and when, layered adoption, what the guard does not do, and which backstops belong outside the agent. README, SECURITY, FAILURE_MODES, HARNESS-MATRIX and TRUST_LOOP describe the Claude Code `agent-flow guard` hook, what the audit log records and the real install targets; ROADMAP lists what command-text analysis cannot close (OS sandbox, orchestrator-run gates, tamper-evident audit log, run budgets, richer policy, SARIF/Action) instead of implying it.

### Upgrading from 1.1.2
- **Re-run `npx @drix10/agent-flow install --harness claude`** to widen the hook matcher (reads and MCP tools) in an existing `.claude/settings.json`; your other hooks are kept.
- Agents can no longer read env files by default. If a workflow needs it, launch with `AGENT_FLOW_ALLOW_SECRET_READ=1`, or keep the file out of the guard's path list by design (`deny_read` is opt-in for other paths).
- While `protected_paths` is set, `git reset --hard`, `git stash`, `git clean -f` and friends are refused for agents; name the files, or use the human override.
- Committing a weaker `CONTEXT_MANIFEST.json` no longer lowers protection; lowering it takes `AGENT_FLOW_ALLOW_PROTECTED=1` and a merge to the default branch.
- `init` and `scan` skip untracked gitignored trees; tracked files are still scanned.
- New manifest keys (`gates`, `policy`) are optional; a manifest without them behaves as before. `doctor` now reports a malformed `gates` or `policy` as a schema problem.

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
