# Agent Flow: per-harness setup

The skills follow the [Agent Skills](https://agentskills.io) format and work in any compatible harness. **Enforcement depends on the harness.** See [docs/HARNESS-MATRIX.md](./docs/HARNESS-MATRIX.md).

Every harness except Pi installs the same way, and the command is identical on Windows, macOS and Linux:

```bash
npm install -D @drix10/agent-flow
npx agent-flow install --harness <name>      # --dry-run to preview; never overwrites your edits without --force
npx agent-flow hook install                   # pre-commit gate (recommended everywhere)
```

v1.0.x told you to use `cp -r` and `ln -s`. Those don't work in PowerShell, and the documented relative symlink resolved to the wrong place. Use `install` instead.

## Pi (full: skills, prompts, tools, guard)

```bash
pi install npm:@drix10/agent-flow
```

- Slash commands: `/bootstrap`, `/implement <n>`, `/doctor`, `/garden`, …
- Tools: `bootstrap_scan`, `bootstrap_write`, `stale_detect`, `stale_repair`, `risk_audit`, `risk_baseline_update`, `risk_classify`, `worktree_*`, `state_*`, `detect_harness`, `guard_status`.
- Guard: active in every session. It blocks protected paths and direct writes to state files. Setting `AGENT_FLOW_ROLE` when you launch `pi` turns on role limits (the orchestrator does this for you).

Run a role by hand:

```bash
AGENT_FLOW_ROLE=reviewer pi --tools read,grep,find,ls          # bash/zsh
$env:AGENT_FLOW_ROLE="reviewer"; pi --tools read,grep,find,ls  # PowerShell
```

## Claude Code

```bash
npx agent-flow install --harness claude
```

- Copies the skills to `.claude/skills/<name>/` and the reviewer subagent to `.claude/agents/reviewer.md` (`tools: Read, Grep, Glob`, so it really is read-only).
- Add `@AGENTS.md` to `CLAUDE.md` so the root context loads.
- There are no Pi tools here. The skills call `npx agent-flow state|worktree|classify|doctor|audit-risk` instead.

## Codex CLI

```bash
npx agent-flow install --harness codex
```

Declare the reviewer in `.codex/config.toml`:

```toml
[agents.reviewer]
description = "Read-only code reviewer"
config_file = "./.codex/agents/reviewer.toml"
```

The reviewer uses `sandbox_mode = "read-only"`. **Verify it** with a "create TEST.md" probe before you rely on it, and please report the result.

## Gemini CLI

```bash
npx agent-flow install --harness gemini
```

- Run `/trust` in the workspace, then restart.
- In `.gemini/settings.json`, set `"experimental": {"enableAgents": true}` for the reviewer subagent, and `"context": {"fileName": ["AGENTS.md", "GEMINI.md"]}` so `AGENTS.md` loads. `.gemini/settings.json.example` has both.
- The reviewer's tool list has no write or shell tools. Verify it with the probe.

## Cursor

```bash
npx agent-flow install --harness cursor
```

Cursor reads `AGENTS.md` natively. Read-only review is an instruction only here, so rely on the pre-commit hook.

## VS Code / GitHub Copilot

```bash
npx agent-flow install --harness copilot     # → .github/skills/
```

VS Code also reads `.claude/skills/` and `.agents/skills/`.

## Upgrading from 1.0.x

1. Rename `Root_AGENT.md` to `AGENTS.md`, and each `Per-app_AGENT.md` to `<module>/AGENTS.md`. Update the `path` entries in `CONTEXT_MANIFEST.json` to match. Or run `/bootstrap`, which offers to do this.
2. A legacy `contexts`/`covers` manifest is migrated automatically by `/repair-docs` (`stale_repair`).
3. `CONFIRM_*` strings are ignored now. Writes ask you through the Pi UI. For unattended runs, set `AGENT_FLOW_HEADLESS_WRITES=1`.
4. Re-accept the risk baseline once. The format changed to per-dependency keys, so the first audit will list dependencies as new: `npx agent-flow baseline accept --all --yes`.
