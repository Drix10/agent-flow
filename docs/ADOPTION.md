# Adopting Agent Flow in an existing repository

For a repo that already has its own rules, its own task tracking and things that must never change (a trial ledger, migrations, a frozen spec). Adopt in layers; stop at the layer you trust.

## What it writes, and when

Nothing is written until you run a command that says so. Every file it can create:

| File | Written by | Notes |
|---|---|---|
| `CONTEXT_MANIFEST.json`, `AGENTS.md` | `init`, `bootstrap_write` | Never overwrites. `init` skips `AGENTS.md` when a `CLAUDE.md`, `GEMINI.md` or `.cursorrules` already holds rules. An overwrite through `bootstrap_write` keeps line endings and indentation, saves a backup under `.agent-flow/backups/`, and refuses to drop `protected_paths`, `risk_boundaries` or any other key. |
| `.claude/settings.json` (guard hook, and the `SessionStart`/`SubagentStart` briefing hooks), `CLAUDE.md` (`@AGENTS.md`) | `install --harness claude` | Merged, not replaced: your other hooks and settings stay. `--no-brief` leaves the briefing out; `--statusline` also sets `statusLine` when none is set. |
| `.codex/hooks.json`, `.gemini/settings.json`, `.cursor/hooks.json` | `install --harness codex\|gemini\|cursor` | Same: our entries are added (the briefing too, for Codex and Cursor), yours kept, and a re-install replaces ours instead of adding another copy. |
| `.clinerules/agent-flow.md`, `.kiro/steering/agent-flow.md`, `.qoder/rules/agent-flow.md`, `.swival/skills/`, `.factory/skills/`, `.commandcode/skills/` | `install --harness cline\|kiro\|qoder\|swival\|factory\|commandcode` | Instruction-tier hosts: see [the harness matrix](HARNESS-MATRIX.md#more-hosts-skills-folders-and-rules-files). |
| `.git/hooks/pre-commit` | `hook install` | A hook that isn't ours is kept unless `--force`, and then backed up. |
| (all of the above) | `uninstall` | Takes out what `install` wrote and nothing else; previews until `--yes`. See "Taking it back out" below. |
| `.risk-baseline.json` | `baseline accept` | |
| `.agent-state.json`, `AGENT_STATE.md`, `.agent-flow/` | the pipeline (`state update`, `worktree create`, `report`) | **Only if you run the pipeline.** `doctor`, `classify`, `audit-risk`, `check-staged`, the guard and the hook write only the audit log. |

If you already track work in your own file (a `TODO.md`, an issues tracker), don't run the pipeline commands: `AGENT_STATE.md` would become a second source of truth. Layers 1 and 2 don't touch it.

## Keeping it current

How an install learns about a newer version depends on how it got there:

| Installed with | How you find out | How you update |
|---|---|---|
| `npm i -D @drix10/agent-flow` | `npm outdated`, Dependabot or Renovate; `doctor` prints one note when the registry has a newer version | `npm i -D @drix10/agent-flow@latest`, then `npx agent-flow update --yes` to refresh the skills and hook wiring |
| `npx @drix10/agent-flow …` | npx may reuse a cached copy; `@latest` always asks the registry | run `npx @drix10/agent-flow@latest …` |
| the vendored runtime (`.agent-flow-runtime/`, no npm) | `doctor` run by a newer CLI says the vendored copy is behind (no network needed); `update --check` exits 10 | `npx @drix10/agent-flow@latest update --yes`, review the diff, commit |

`update` is safe to run: without `--yes` it only shows what would change. It replaces a skill, a reviewer agent or the vendored runtime only if it still matches what `install` wrote (`.claude/agent-flow-install.json` records that), so a skill you edited is kept and listed; `--force` replaces it. It never downgrades. A repo installed before 1.1.7 has no record yet, so its first update asks for `--force` once (check the diff); every later one is automatic. The vendored copy cannot update itself; it prints the command above.

The version note is one dim line in `doctor`'s terminal output. It never appears in `--json` or SARIF output, in CI, in the guard or pre-commit hook, or with `NO_UPDATE_NOTIFIER=1`, `AGENT_FLOW_NO_UPDATE_CHECK=1` or `--offline`. The registry's answer is cached in `~/.agent-flow/` for a day.

To get a pull request when a new version ships, run `update --yes` on a schedule and let a pull-request action open one (it opens nothing when no file changed):

```yaml
# .github/workflows/agent-flow-update.yml
name: agent-flow update
on:
  schedule: [{ cron: "17 6 * * 1" }]
  workflow_dispatch:
permissions: { contents: write, pull-requests: write }
jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx --yes @drix10/agent-flow@latest update --yes
      - uses: peter-evans/create-pull-request@v7
        with:
          title: "chore: update agent-flow"
          branch: chore/agent-flow-update
          commit-message: "chore: update agent-flow"
```

## Layer 1: read-only checks (no risk)

```bash
npx @drix10/agent-flow doctor            # context files vs the filesystem
npx @drix10/agent-flow audit-risk        # review once, then `baseline accept --all --yes`
npx @drix10/agent-flow init              # preview a manifest; suggests protected_paths but writes none
```

Add `doctor` and `audit-risk --fail-on-new` to CI, or use the composite action (`uses: Drix10/agent-flow@v1.2.5`), which also runs `classify --fail-on-protected --fail-on-policy` and can upload SARIF to code scanning (`--sarif` on `doctor` and `audit-risk`). In a git repo the scans read git's file list, so untracked gitignored trees (data, caches, vendored code) are not walked. Files git tracks are always scanned, even under an ignored pattern, and outside git the scans fall back to a directory walk.

## Layer 2: protect what must not change

List it in `CONTEXT_MANIFEST.json`:

```json
{
  "protected_paths": ["research/ledger/**", "research/prereg/**", "**/STAGE", "migrations/"],
  "deny_read": ["secrets/**"],
  "secret_scan": { "ignore_paths": ["tests/fixtures/"] }
}
```

Then install the guard and the hook (`install --harness claude`, `hook install`). With `protected_paths` set, an agent session cannot:

- write to a protected path, **or delete or move it, or a directory containing it** (`rm -rf research`, `mv research /tmp`, `rm -rf .`);
- run `git reset --hard`, `git clean -f`, `git stash`, `git checkout .`/`-f`, `git restore .`, or a targeted `checkout`/`restore`/`rm`/`mv` that reaches a protected path;
- delete, move or `chmod` the git hooks or the manifest, `rm -rf .git`, or edit the guard's own wiring (`.claude/settings*.json`, the installed `node_modules/@drix10/agent-flow/`);
- push or write files to the default branch through a git-host MCP tool (`push_files`, `create_or_update_file`, `delete_file`), or, as a pipeline role, merge a pull request;
- skip hooks, force-push, or push to the default branch;
- read a real env file (`.env`, `.env.local`, `.env2`, `prod.env`, …) or a `deny_read` path, through the shell or a read tool.

Protection committed to `HEAD` or to the default branch outlives the working copy: deleting or emptying `CONTEXT_MANIFEST.json` on disk, or committing a weaker one on a feature branch, does not lower it. Lowering protection is a human act (`AGENT_FLOW_ALLOW_PROTECTED=1`, then merge), and worth a `CODEOWNERS` entry on the manifest. A hook or guard error refuses the call when a manifest exists (or `AGENT_FLOW_GUARD_STRICT=1`).

Human overrides, set by whoever launches the session (an agent cannot set them for itself): `AGENT_FLOW_ALLOW_PROTECTED=1` for a frozen-file exception, `AGENT_FLOW_ALLOW_SECRET_READ=1` to let an agent read a secrets file. Keep your exception record (why, who, when) in your own process; the manifest only encodes the default.

## Review-only paths: CI and test lists without stopping an unattended run

`protected_paths` are a wall: the agent stops, and a person makes the change. For CI that is the wrong trade. A new test has to be added to the CI list, and nobody should be called back for one line. List the file as review-only instead:

```json
{ "review_paths": [".github/workflows/"] }
```

- Agents may **add lines** there. The run goes on through review, gates and QA, and the pull request is a **draft that waits for you**, never auto-merged. `run` says which files to read.
- An edited or deleted line goes back to the Implementer as a finding. Loosening a check that judges the agent's own work (`|| true`, a removed job, a narrower `paths:`) is the thing to prevent, and it can add a new line instead.
- An added CI line goes back too when it reaches secrets (`secrets.X`, `secrets: inherit`), uses the job token, runs on `pull_request_target` or `workflow_run`, widens a permission (`contents: write`), uses a `self-hosted` runner, pipes a download into a shell, pulls in a third-party action (anything but `actions/…` and `./…`) or drops event text such as a PR title into a script. CI runs when the pull request opens, before anyone has read it, which is why these are checked. This is a pattern list, not a sandbox. Keep deploy secrets in environments that require approval, and keep `CODEOWNERS` on the workflows.
- Only `.github/workflows/` can be opened this way. Skills, hooks, harness settings (`.claude/`, `.agents/`, …), the guard's wiring, the trust files and `CONTEXT_MANIFEST.json` stay shut whatever this list says, and a path in both lists is protected.
- It is read from the default branch's manifest, like `gates` and `policy`: widening it takes a merge by a person, not an edit in a working copy.
- Also keeps the gate list from becoming a human task. Prefer gates that run a directory or glob (`pytest research/tests`) over a list of files: a new test then needs no CI or manifest edit at all (`doctor` names test files that no gate runs).

## Checking the claims yourself

`tests/redteam/corpus.json` is the list of commands and tool calls the guard is tested against: what must be blocked, what must keep working, and the documented limits (`gap`). Add your own attack or workflow to it and run `npm test`. A `gap` entry is asserted to still be allowed, so closing one, or regressing a `block`, fails the test.

## What this layer does not do

The guard reads command text. It cannot see through `x=.en; y=v; cat $x$y`, `$(echo .env)`, `base64 -d | sh`, an interpreter script run by path, a symlink made and used in one command, or a recursive `grep -r` that happens to descend into a secrets file. It also can't stop a human's own terminal. Treat it as a second layer and keep the real backstops outside the agent:

- `CODEOWNERS` on the protected paths (`agent-flow codeowners --yes` writes the lines), and, for teams, branch protection with "Require review from Code Owners". Alone it's optional: it blocks your own pull requests unless you allow admin bypass. `doctor` reports whether GitHub enforces it when a logged-in `gh` can say so;
- a secret scanner in CI (agent-flow's own is a pre-commit check, tuned for few false alarms);
- file permissions on append-only data (read-only mode or a separate user for the ledger);
- a container or sandbox for anything that must be a hard guarantee, and read-only roles launched without a shell tool.

## Layer 2b: rules the repo enforces on itself

Both are optional manifest keys.

```json
{
  "gates": [
    { "name": "test", "command": ["npm", "test"], "timeout_seconds": 900 },
    { "name": "lint", "command": ["npm", "run", "lint"], "required": false }
  ],
  "policy": {
    "max_changed_files": 40,
    "forbid_patterns": [{ "paths": ["src/**"], "pattern": "console\\.log", "message": "no console.log in src" }],
    "require_tests": [{ "paths": ["src/**"], "tests": ["tests/**"], "message": "source changes need a test change" }]
  }
}
```

- `agent-flow gates run` executes the gates and records exit codes, logs and hashes under `.agent-flow/gates/`. An array command runs without a shell; a string runs through one (POSIX `sh`; on Windows, Git Bash, or `AGENT_FLOW_SHELL`). Exit 2 means a gate couldn't start (a missing tool), which is an environment problem rather than a failing change. A gate with `"os": ["linux"]` is skipped on other platforms and reported as skipped, not passed, so CI judges it.
- `agent-flow manifest sync --yes` rebuilds `context_files` after you add, move or rewrite a context file; it never touches `protected_paths`, `risk_boundaries`, `gates` or `policy`.
- **Command policy (opt-in).** `"policy": {"deny_commands": {"presets": ["database", "infra"], "patterns": [{"pattern": "\\bshutdown\\b"}]}}` makes the guard refuse those shell commands in every agent session (`database`: DROP/TRUNCATE through psql, mysql, sqlite3; `infra`: `kubectl delete`, `terraform destroy`, `docker system prune`, `helm uninstall`, cloud-CLI deletes). It is deny, not ask: a headless pipeline has nobody to answer. A working copy can add rules but not remove committed ones; `AGENT_FLOW_ALLOW_PROTECTED=1` lets a human through. It reads the command text (each `;`/`|`/`&` segment, with quotes, backslashes, line continuations and comments removed, and the body of `sh -c '…'`, and pipes or heredocs into `psql`/`mysql`), so it can't see a variable (`K=kubectl; $K delete`), an alias, or SQL in a file (`psql -f drop.sql`).
- **Stop gate (Claude Code, opt-in).** Mark fast gates `"on_stop": true` and run `agent-flow install --harness claude --stop-gate`. When an interactive session tries to end its turn, `agent-flow gates stop` runs those gates if the working tree changed since the last pass, and keeps the session working while they fail — at most `pipeline.max_stop_blocks` times in a row (default 2, max 5), then the turn ends and `stop_gate_exhausted` is written to the audit log. The gates come from the default branch's manifest, so a session can't edit the gate that judges it. Keep them to lint, typecheck and unit tests.
- `agent-flow classify --fail-on-policy` (CI) and the pre-commit hook (staged content) enforce `policy`. `classify --fail-on-heuristic` fails while `risk_boundaries` is empty, for teams that don't want a path-name guess deciding review depth.
- `agent-flow audit verify` checks the audit log's hash chain; record `audit head` somewhere the agent can't write to anchor it. `audit summary` shows which rules block agents most often, which is a list of candidates for `protected_paths` or a lint rule.

## Running alongside other workflow packs

Most teams already run one of superpowers, GSD, gstack, spec-kit or openspec. Those are prompts and slash commands; agent-flow is the layer that enforces. Tests (`tests/coexist.test.js`) cover: `install` merges its guard and Stop hooks next to yours and keeps every hook and permission you have (running it twice changes nothing); the guard doesn't touch `.planning/`, `docs/superpowers/`, `.gstack/`, `.specify/`, `specs/` or `openspec/changes/`; and `doctor` reads only real context files (`AGENTS.md`, `CLAUDE.md`, …), so a pack's generated docs never raise drift findings unless a context file links to them. Two things to know: both hook sets run on each tool call, and a pack hook that exits 1 doesn't block in Claude Code (only exit 2 does), so a pack's "BLOCKED" message isn't protection. Put anything that must hold in `protected_paths`, `policy` or `gates`.

## Layer 2c: what an agent is told, and what you see

- **The briefing.** `install` wires `agent-flow brief` as a `SessionStart` hook (and `SubagentStart` on Claude Code, since a subagent never sees the parent's context; Codex and Cursor get `SessionStart`). A session starts knowing what is protected, what is review-only, what is always blocked, which checks must pass and how many issues wait on a person, instead of learning it from a blocked write. It is facts from the manifest and the state file, never the free text of an issue or a reason. It fails open: a briefing that errors prints nothing. `--no-brief` leaves it out; `agent-flow brief` prints it by hand.
- **The badge.** `agent-flow statusline` is one short line for Claude Code's `statusLine` (`agent-flow · guard on · 2 need you · 1 ready · 1 working`; `guard OFF` in red when the hook isn't wired). `install --harness claude --statusline` sets it only if you have none.
- **Hooks never hang.** A harness wrapper can swallow the JSON it was meant to pipe to a hook, and a hook that waits for it is killed by the harness's own timeout, which lets the tool call through. The guard waits a bounded time (10 s; `AGENT_FLOW_HOOK_STDIN_MS` changes it) and then refuses wherever protection is configured; a session with no manifest and no role is let through, as for any guard error.
- **A read-only MCP server.** `agent-flow mcp` speaks the Model Context Protocol on stdio and answers status, pipeline state, the risk of a diff, debt, doctor, the audit summary, the gates and the brief for any MCP client (Claude Desktop, Cursor, Windsurf, Zed, …). It changes nothing and is not where the guard lives: that is the harness's own hook. Register it as a command: `npx @drix10/agent-flow mcp` (`node .agent-flow-runtime/bin/agent-flow.js mcp` when vendored).

## Layer 2d: lean, and role isolation

`pipeline.lean` (`off`, `lite` by default, `full`) tells the Implementer and Reviewer to make the smallest correct change; `agent-flow debt` lists the shortcuts it leaves marked in the code. `pipeline.isolate_roles: true` keeps this machine's global Claude Code plugins and hooks out of each role. Both are explained, with what is and isn't claimed, in [LEAN.md](LEAN.md).

## Taking it back out

`agent-flow uninstall [--harness <name>] [--yes] [--keep-runtime] [--keep-hook]` removes what `install` wrote. It previews until `--yes`.

- A skill, agent definition, rules file or plugin file goes only if it is still exactly what install (or this version) writes; one you edited is **kept and named**, and a skill of your own beside ours is never touched.
- In the hook files install merged into, only agent-flow's entries go (the guard, the stop gate, the briefing, our `statusLine`); every other hook and setting stays, and a file that held nothing else is deleted. A hook file that isn't valid JSON is left exactly as it is, with a note.
- A skills folder several harnesses share (`.agents/skills`) stays until the last of them is uninstalled. The vendored runtime and the pre-commit gate go with the last harness, if unmodified (a patched runtime is kept and named).
- Never touched, because they are yours: `AGENTS.md`, `CLAUDE.md` and its `@AGENTS.md` import, `CONTEXT_MANIFEST.json`, `DOCS_INDEX.md`, `CODEOWNERS`, `.risk-baseline.json`, the pipeline's state and `.agent-flow/`, and the `.git/info/exclude` lines. A pipeline role can't run it.

## Layer 3: the pipeline (optional)

Implement → Review → QA with separate processes, a round cap and a state file. Adopt it only when you want it to own task state. The QA role runs the commands listed in `AGENTS.md`, so list your real build and test commands there (including any run-as-user requirement), and put your freeze rules in `AGENTS.md` and the reviewer's checklist. Risk classification is heuristic until you set `risk_boundaries` yourself.
