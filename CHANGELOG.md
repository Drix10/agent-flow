# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.2] - 2026-10-03

Found by running `agent-flow run` unattended on a real repository (Hypothesis Arena, Windows):

- **Script files no longer bypass the guard.** The guard checked a command but not a script file the command ran, so an edit to a protected path could be put in a file and run from there. A script that differs from the default branch's copy (new, edited, committed only on the issue branch, or outside the repo) is now checked like the command it contains. The repo's unchanged scripts stay trusted, so gates and tests run as before.
- **Prose no longer looks like a protected path.** On Windows and macOS, a Python heredoc saying "the stage's rules" was blocked as a write to the protected file `STAGE`, which pushed agents toward the script-file workaround. In program text a protected name now counts only as a path in a string literal.
- **The rule files are guarded.** The Implementer can't edit `CONTEXT_MANIFEST.json`. A diff that changes it or `.risk-baseline.json` is classified critical, so it needs a person and is never auto-merged. `agent-flow codeowners` and `doctor` now cover both files.
- **Merged work can be marked done.** Once a pull request was merged and its branch deleted, `state update --state Completed` parked the issue in Needs Me (`unreviewed_commits`). The approved commit now counts as the tip when the default branch holds it, either as an ancestor or as a squash merge with the same patch. A different change merged under the issue still does not count.
- **Usage limits wait instead of parking the issue.** A role that hits "You've hit your session limit · resets 5:10pm (…)" used to go to Needs Me and stay there. `run` now waits for the reset and runs the role again, up to three times and only within `--limit-wait <hours>` (default 6, 0 never waits). Further away than that, it escalates as `usage_limit` with the time to re-run.
- **`doctor` names tests no gate runs.** Where a gate lists a directory's tests one by one (`for t in test_a test_b; do …`), a test file in that directory that no gate lists is reported. That is how a new test never ran and a deleted one stayed listed. A gate that hands the whole directory to a runner is not second-guessed.
- **The audit log is anchored off the machine.** `.agent-flow/audit.jsonl` exists only where the pipeline runs, so anyone who could write it could rewrite the whole chain consistently. A pull request opened by `run --pr` now carries the log's head hash, and `audit verify --anchor <hash>` proves the local log still contains it.

## [1.2.1] - 2026-10-02

- **`run` roles can read their issue folder and worktree.** An Implementer that `cd`s into its worktree lost Claude Code's permission to read `issue.md` (3 of 4 live runs on a real repository stopped with a permission error). `run` now passes `--add-dir` for the issue folder and the worktree to every role.

## [1.2.0] - 2026-10-02

- **`agent-flow run` is the short path from task to checked work.** Give it a testable task or issue number. Claude Code runs implementation, mechanical risk classification, review, required gates and QA in separate processes. By default the result stays in a local worktree; `--pr` pushes and opens a PR, while `--auto-merge` is an additional opt-in gated by `pipeline.auto_merge_low_risk`. `--dry-run` shows the plan and setup gaps without launching roles. Invalid manifests, missing GitHub auth and invalid timeout values are caught before role calls.
- **`agent-flow status` summarizes repository readiness** across protection, context, checks and work waiting on the user.
- Task text is XML-escaped before it is placed inside the untrusted issue boundary. Auto-merge defaults off in the CLI, even when the repository allows it.
- Updated Quickstart, README and orchestration skill to make the CLI the first path on Claude Code and keep the harness-specific skill procedure for other agents.
- Added end-to-end fake-agent coverage for the run loop, resumptions, report correction, risk escalation, gate failures, protected paths, QA tree mutation and PR creation.
- **Resume is trustworthy.** A saved report is reused only if its role finished before the phase the issue stopped in, so sending an escalated issue back to `implement` runs every role again instead of replaying a rejected result. A resumed round gets the report that ended the previous round as its findings (it used to get `none`). Once QA passes the issue is checkpointed as `publish`, so `run N --pr` after a local run publishes without paying for another review or QA.
- **One run per issue.** A lock in the artifacts folder refuses a second `run` for the same issue and takes over a lock left by a dead process.
- **Ctrl-C is safe.** An interrupted `run` stops the agent and everything it started (the whole process tree, on Windows and POSIX), releases the lock, and says how to continue. A timeout now stops the tree too, not just the agent.
- **Checks on what the Implementer hands over.** Uncommitted work is sent back as findings (it would be reviewed here but missing from the pushed branch), and a branch with no changes escalates as `no_changes` instead of opening an empty pull request.
- **QA mutation check no longer holds files in memory.** Modified and untracked files are hashed in 1 MiB pieces; the staged blobs and `git status` are included. The manual skill's shell snippet uses the same fingerprint (with `git hash-object`, so it works on macOS).
- **Windows launch fixes.** A line break in a prompt ended the `cmd.exe` command line and silently dropped the rest; it is now a space. Validator text is flattened and bounded, a session id is used only if it is a plain token, and QA command lists over 800 characters are passed in a file (a command line is limited to about 8,000 characters).
- **Task and state fixes.** New task text replaces files left by an earlier attempt that never started (it used to inherit the old task), issue numbers skip any with saved artifacts or a worktree, a budget stop is reported as `budget_exceeded` instead of a round cap, and the pull request targets the base branch by name (not `origin/main`).
- **Found by running it live on a real repository** (Hypothesis Arena, a C++/Python repo with 12 protected paths and 7 critical areas, on Windows):
  - On Windows, Claude has a separate `PowerShell` tool. The roles allowed only `Bash`, so the first command was denied and a turn wasted, and the read-only Reviewer's deny-list named only `Bash`, so it still had a working shell (a live call confirmed it ran a PowerShell command under plan mode). PowerShell is now allowed for the Implementer and QA and denied to the Reviewer, in `run` and in the manual launch recipe.
  - A Node `DEP0190` deprecation warning printed at the start of every real run on Windows (the preflight `claude --version` check passed arguments alongside `shell: true`).
  - Preflight now names the manifest problem ("missing `context_files` array") instead of only counting it.
  - Resuming an issue whose work is already reviewed, gated and tested takes seconds and costs nothing: it no longer re-runs the gates (2.5 minutes there) or announces "implementing" for work it isn't doing.
  - A critical change used to finish with the same line as a trivial one. It now prints the risk and says to read the diff before publishing. When `pipeline.models.high_reasoning` is not set, `run` and `status` say the critical review runs on the same model as everything else instead of implying a stronger one (a configured tier is passed as `--model`, verified live: Sonnet for the Implementer, Opus for the critical review).
  - `status` calls an issue that passed review, gates and QA "ready" (with the command to publish), not "in progress".
  - **`agent-flow state dismiss --issue N --reason "…"`** lets a person drop an issue they handled by hand, or no longer want, from the list. Its files and the audit trail stay; it is refused while a run is working on it and is a person-only action (every role is refused, the orchestrator too). Before, such an issue stayed in "needs you" forever.
  - The guard's message for a command that edits files and also names a protected path now says to run the read or the run of that path as a separate command, instead of only "escalate". The Implementer in the trial recovered on its own, but a model told to escalate may not.
- **Found by independent review of the above:** Ctrl-C during a blocking git, gate or push call now stops the run at once (it used to read as a failed gate and use up a round). The run lock is created already holding its content, so a second process can't mistake it for a leftover, and it is refreshed every 30 seconds, so a long run is never taken for a dead one (a lock nobody has refreshed for six hours is stale; a taken-over lock is never deleted by its former holder). Files a gate or QA writes are no longer blamed on the next round's Implementer. Files from an abandoned attempt at a round are set aside as `*.prev` instead of outranking the new attempt's findings. A later `run N --pr` keeps `Closes #N` for a GitHub issue. `%NAME%` in a prompt is no longer expanded by `cmd.exe` on Windows, and QA commands containing `%`, quotes or line breaks travel in a file. A late error from a role that is already running no longer discards its result.
- **Output.** `--json` keeps stdout a single JSON document (progress goes to stderr, and a missing-setup error is JSON too). `status` prints the full command to send an escalated issue back, and describes auto-merge as the opt-in it is. Cost is shown with its `$`.

## [1.1.7] - 2026-10-02

Found by asking how a vendored install ever learns about a newer version (it didn't).

- **`agent-flow update [--yes] [--check] [--force]`.** Brings the skills, reviewer agents, hook wiring and the vendored runtime up to the running version. `install` now records what it wrote (`<harness dir>/agent-flow-install.json`); `update` replaces only files that still match that record, keeps and lists anything you edited, never downgrades, and previews unless given `--yes`. `--check` exits 10 when an update is available, for a scheduled CI job (a ready workflow is in `docs/ADOPTION.md`). The vendored copy can't update itself and prints the `npx @drix10/agent-flow@latest update --yes` command. A repo installed before this release has no record, so its first update needs `--force` once.
- **`doctor` tells you when agent-flow is behind**, as one dim line for humans at a terminal: when a newer CLI finds an older vendored runtime (no network), or when the npm registry has a newer version (one GET, 2.2 s cap, cached for a day in `~/.agent-flow/`). Never in `--json`/SARIF output, CI, the guard or the pre-commit hook; `NO_UPDATE_NOTIFIER=1`, `AGENT_FLOW_NO_UPDATE_CHECK=1`, `AGENT_FLOW_OFFLINE=1` and `--offline` turn it off. The GitHub Code Owner lookup added in 1.1.6 now also skips itself in CI.
- **Docs now say what the network does.** `README.md` and `SECURITY.md` claimed "no network calls"; both are corrected to name the two optional, read-only lookups in `doctor` (npm registry version, `gh` branch-protection).
- `update` is a setup action like `install`: no pipeline role may run it. It leaves a customized guard hook alone (with a note) unless `--force`, treats hook wiring that is out of date as an update on its own, and compares the OpenCode plugin with the same hash format `install` records. Fixed on the way: a dry run of the vendoring step no longer stops the real copy.
- Install-style table in `docs/ADOPTION.md` ("Keeping it current"): npm, npx and vendored, and how each is told about and applies an update.

## [1.1.6] - 2026-10-02

Found by running bootstrap on a real C++/Python repo with no `package.json`, on Windows.

- **Any language, no npm.** `install` copies a ~0.5 MB runtime to `.agent-flow-runtime/` for the guard hooks (Claude, Gemini, Codex, Cursor) when agent-flow isn't in the project's `node_modules`, or with `--vendor`. It used to refuse and tell you to `npm install -D`. Commit the folder; the pre-commit hook finds it too. The guard treats it as hook wiring, and `audit-risk`, `scan` and `classify` ignore it. The skills no longer claim a devDependency.
- `install` keeps `.agent-flow/` (audit log, gate logs, backups) out of git through `.git/info/exclude`, and its next steps say what to commit.
- **Behavior change on Windows: string gates run in Git Bash, not `cmd.exe`.** Gate commands come from CI files and READMEs, which are POSIX; under `cmd.exe` they failed and looked like test failures. A gate written for `cmd.exe` (`.\scripts\check.bat`, `set X=1 && …`) now needs `AGENT_FLOW_SHELL=cmd.exe`, or an `os`-specific rewrite. Details: String gates went through `cmd.exe`, so every POSIX command (`./build.sh`, a `for` loop, the commands `scan` reads from CI) failed and looked like a test failure. `AGENT_FLOW_SHELL` overrides. A command the shell itself can't start is now an environment error (exit 2); a 126/127 from inside a script is still that script's failure.
- **`os` on a gate** (`["linux"]`): elsewhere the gate is reported as skipped, never as a pass, and CI judges it. For builds that need a Linux toolchain or a POSIX filesystem.
- **`agent-flow manifest sync [--yes]`** rebuilds `context_files` from the context files on disk (new `AGENTS.md` files, install's `CLAUDE.md`, the paths their prose names) and keeps `protected_paths`, `risk_boundaries`, `gates` and every other key. Bootstrap and the gardener use it instead of editing references by hand. Roles without `bootstrap_write` can't run it.
- `scan` finds commands in CI workflow steps, including each plain line of a `run: |` block (loops, continuations and lines with variables are left out), and in `build.sh`/`test.sh`, so a repo with no `package.json` or Makefile no longer reports none. Three or more sibling commands collapse into one `…/<name>.py (N files)` line.
- **CODEOWNERS without the friction.** A missing or partial `CODEOWNERS` is now one quiet note, not a warning: the guard and pre-commit hook already protect against local agents, and CODEOWNERS only matters for pull requests pushed from elsewhere. `agent-flow codeowners [--yes] [--owner @x]` previews, then appends the lines (owner from `origin`); an existing file is appended to, never replaced. When the lines are in place and a logged-in `gh` is available, `doctor` also reports whether GitHub really requires Code Owner review (rulesets and classic protection); with no `gh`, no login or no network it says nothing, never asks for a token, and `--offline` / `AGENT_FLOW_OFFLINE=1` skips the call. Solo repos are told that requiring it blocks their own PRs.
- `doctor --allow-stale` reports stale context without failing, and `doctor --allow-stale` reports stale context without failing (for CI on every push; broken paths, schema problems and placeholders still fail). Without it, a repo's CI went red 30 days after setup with no change.
- The OpenCode plugin finds the CLI relative to itself (the vendored runtime or `node_modules`) instead of the absolute path of whichever copy ran `install`, so it works in every clone.
- Bootstrap skill: the secrets gate offers fake / real / keep-flagged instead of only stopping; a new gates step (where each can run, timeouts, `on_stop`); glob and highest-level-wins rules spelled out; `manifest sync` for `context_files`; Phase 6 runs the gates and sorts every failure; CODEOWNERS and CI steps without Node in the project; the repo's own rules bind bootstrap.
- Guard: an unquoted glob that expands to an env file or a `deny_read` path (`cat .e*`) is a secret read, like naming the file.
- Guard: a recursive search (`grep -r`, `rg --hidden`) over a directory that holds an env file or a `deny_read` path is a secret read; `rg` without `--hidden` skips dotfiles as it does itself.

## [1.1.5] - 2026-10-01

- Read each vendor's hook docs and source and fixed what they contradicted: Gemini's hook now matches every tool (the allow-list named a tool that doesn't exist and missed others); Cursor's Windows BOM on stdin no longer makes the guard fail open, and Cursor's Delete tool counts as a write; the OpenCode plugin is one flat file with no SDK import (v1 and v2 load it; it no longer writes `.opencode/package.json` or depends on `@opencode/plugin`). `docs/HARNESS-MATRIX.md` says, per harness, what is live-verified and what is docs-verified only, with the caveats each vendor's docs give (untrusted folders, fail-open exits, headless modes).

- Codex guard hook live-verified on Linux/WSL (protected write, `--no-verify` commit and hook-config write all blocked); docs note that Codex's bypass-hook-trust / full-access options disable enforcement.
- Guard: PowerShell writes are judged like their POSIX twins — named parameters in any order (`-LiteralPath`, `-Destination`, …), Windows `\` paths, `Copy-Item` writes only its destination, and .NET `[IO.File]::Write*` calls count as writes. A live Codex-on-Windows probe found `Set-Content -LiteralPath .codex/hooks.json …` slipped through.
- Guard blocks also print a JSON deny (`permissionDecision`) on stdout besides exit 2 + stderr; set `AGENT_FLOW_GUARD_JSON_ONLY=1` to deny by JSON with exit 0 (experiment for a harness that ignores exit 2).
- `agent-flow sandbox [--ro] [--no-net] [--hide-home] [--allow <dir>] -- <cmd>` runs a command under bubblewrap (read-only filesystem except the worktree), an OS-level boundary the hook cannot give. Linux/WSL only.

- `doctor` warns (never fails) when `protected_paths` have no CODEOWNERS entry, since only the host can stop a pull request editing them.
- Guard: recognises Codex/OpenCode patch payloads, Gemini `replace`, argv-form shells, `workdir`/`dir_path`, and protects the Gemini/Codex/Cursor/OpenCode hook wiring from edits.

- `install --harness gemini|codex|cursor` also installs the guard as a pre-tool hook; the guard understands Cursor's tool-less `beforeShellExecution`/`beforeReadFile` payloads. Live verification pending.
- `policy.deny_commands: ["infra"]` shorthand accepted (it used to load no rule at all).

- `install --harness opencode`: OpenCode guard plugin (`tool.execute.before`), fails closed. Live verification pending.
- Guard: `mv x ~/` no longer flagged when the repo lives under the home directory (found by a live OpenCode run).

### Added
- **Cross-vendor roles.** `pipeline.harness_by_role` (`{"reviewer": "codex"}`) runs a role on another harness than the orchestrator's; the orchestrator skill reads it into `env.sh`, the verdict still goes through the schema, round cap and audit chain, and a missing CLI is Needs Me, not a silent fallback. On the last allowed round the Implementer uses `pipeline.models.high_reasoning`.
- **`policy.deny_commands`** (opt-in): presets `database` and `infra` plus custom regexes that the guard refuses in every agent session, with an additive floor from the default branch and the usual human override.
- **Bounded stop gate for interactive Claude Code sessions.** Gates marked `on_stop: true` run from a Stop hook (`agent-flow gates stop`, installed with `install --harness claude --stop-gate`) when the tree changed since the last pass. It holds a session back at most `pipeline.max_stop_blocks` (default 2, max 5) times per turn, then lets it stop and records `stop_gate_exhausted`. Gates come from the default branch's manifest; `.agent-flow/stop-gate.json` and `.agent-flow/gates/` are tamper-proof.
- **Per-issue cost cap.** `pipeline.max_cost_usd`: once an issue's role runs have cost that much, `state update` (and the Pi `state_update` tool) escalates the next new phase or round to Needs Me `budget_exceeded` with the cost per round (exit 3 in the CLI). Counts only harnesses that report cost; `audit summary` now shows how many runs reported none.
- **`doctor` checks commands, links and commits, not just paths.** `npm|pnpm run <script>` and `npm test` against the nearest `package.json`, `make <target>` against the Makefile, `just <recipe>` against the justfile (each with a did-you-mean), relative markdown links (case-exact) and commits cited as `commit <sha>`. Skips what it can't resolve: workspace/`-C` flags, `cd`, variables, yarn/bun binaries, shallow clones, fixture directories. New SARIF rules `broken-link` and `unknown-commit`.
- **Verdicts are bound to the commit they judged.** `role_run` and `gate_run` audit lines record the tip of `agent/issue-N`. `state update --state Completed` exits 3 and records Needs Me `unreviewed_commits` unless the round's approved review, passed QA and every required gate name the current tip. No skip flag. Runs recorded before this version carry no `head` and aren't compared.

### Changed
- **`gates`, `policy`, `secret_scan` and `pipeline` are read from the default branch's manifest** (falling back to the last committed copy), not the working copy an agent can edit; `risk_boundaries` may be added to but not removed. `gates list` and `check-staged` say when the working copy differs. A human iterating locally can set `AGENT_FLOW_TRUST_WORKING_MANIFEST=1`. This corrects 1.1.4's "a branch can't edit the gate that judges it", which held for gates only on the main checkout.

### Security
- **The guard now refuses `rm -rf ~`, `$HOME`, `/` wherever the repository is** (`catastrophic-delete`) and commands that build words from `${IFS}` (`obfuscated-command`). The red-team corpus grew by 30 cases drawn from gstack's `careful`, block-dangerous-git and the new presets, and a test asserts blocks exit 2 through the real hook, never 1.
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
