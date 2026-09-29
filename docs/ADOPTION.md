# Adopting Agent Flow in an existing repository

For a repo that already has its own rules, its own task tracking and things that must never change (a trial ledger, migrations, a frozen spec). Adopt in layers; stop at the layer you trust.

## What it writes, and when

Nothing is written until you run a command that says so. Every file it can create:

| File | Written by | Notes |
|---|---|---|
| `CONTEXT_MANIFEST.json`, `AGENTS.md` | `init`, `bootstrap_write` | Never overwrites. `init` skips `AGENTS.md` when a `CLAUDE.md`, `GEMINI.md` or `.cursorrules` already holds rules. An overwrite through `bootstrap_write` keeps line endings and indentation, saves a backup under `.agent-flow/backups/`, and refuses to drop `protected_paths`, `risk_boundaries` or any other key. |
| `.claude/settings.json` (hook), `CLAUDE.md` (`@AGENTS.md`) | `install --harness claude` | Merged, not replaced: your other hooks and settings stay. |
| `.git/hooks/pre-commit` | `hook install` | A hook that isn't ours is kept unless `--force`, and then backed up. |
| `.risk-baseline.json` | `baseline accept` | |
| `.agent-state.json`, `AGENT_STATE.md`, `.agent-flow/` | the pipeline (`state update`, `worktree create`, `report`) | **Only if you run the pipeline.** `doctor`, `classify`, `audit-risk`, `check-staged`, the guard and the hook write only the audit log. |

If you already track work in your own file (a `TODO.md`, an issues tracker), don't run the pipeline commands: `AGENT_STATE.md` would become a second source of truth. Layers 1 and 2 don't touch it.

## Layer 1: read-only checks (no risk)

```bash
npx @drix10/agent-flow doctor            # context files vs the filesystem
npx @drix10/agent-flow audit-risk        # review once, then `baseline accept --all --yes`
npx @drix10/agent-flow init              # preview a manifest; suggests protected_paths but writes none
```

Add `doctor` and `audit-risk --fail-on-new` to CI, or use the composite action (`uses: Drix10/agent-flow@v1.1.4`), which also runs `classify --fail-on-protected --fail-on-policy` and can upload SARIF to code scanning (`--sarif` on `doctor` and `audit-risk`). In a git repo the scans read git's file list, so untracked gitignored trees (data, caches, vendored code) are not walked. Files git tracks are always scanned, even under an ignored pattern, and outside git the scans fall back to a directory walk.

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

## Checking the claims yourself

`tests/redteam/corpus.json` is the list of commands and tool calls the guard is tested against: what must be blocked, what must keep working, and the documented limits (`gap`). Add your own attack or workflow to it and run `npm test`. A `gap` entry is asserted to still be allowed, so closing one, or regressing a `block`, fails the test.

## What this layer does not do

The guard reads command text. It cannot see through `x=.en; y=v; cat $x$y`, `$(echo .env)`, `base64 -d | sh`, an interpreter script run by path, a symlink made and used in one command, or a recursive `grep -r` that happens to descend into a secrets file. It also can't stop a human's own terminal. Treat it as a second layer and keep the real backstops outside the agent:

- branch protection and `CODEOWNERS` on the protected paths;
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

- `agent-flow gates run` executes the gates and records exit codes, logs and hashes under `.agent-flow/gates/`. An array command runs without a shell; a string runs through one. Exit 2 means a gate couldn't start (a missing tool), which is an environment problem rather than a failing change.
- `agent-flow classify --fail-on-policy` (CI) and the pre-commit hook (staged content) enforce `policy`. `classify --fail-on-heuristic` fails while `risk_boundaries` is empty, for teams that don't want a path-name guess deciding review depth.
- `agent-flow audit verify` checks the audit log's hash chain; record `audit head` somewhere the agent can't write to anchor it. `audit summary` shows which rules block agents most often, which is a list of candidates for `protected_paths` or a lint rule.

## Layer 3: the pipeline (optional)

Implement → Review → QA with separate processes, a round cap and a state file. Adopt it only when you want it to own task state. The QA role runs the commands listed in `AGENTS.md`, so list your real build and test commands there (including any run-as-user requirement), and put your freeze rules in `AGENTS.md` and the reviewer's checklist. Risk classification is heuristic until you set `risk_boundaries` yourself.
