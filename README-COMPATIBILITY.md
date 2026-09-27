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

The verified way to run the reviewer read-only is the `--sandbox` flag (checked against `codex exec --help`, Codex CLI v0.157.1 — OpenAI's own OS-level sandbox, same class of mechanism as a container):

```bash
codex exec --sandbox read-only "Use the reviewer skill. …"
```

or a profile (Codex's own per-user config layering — see [Codex config docs](https://developers.openai.com/codex/config-advanced#profiles)):

```toml
# ~/.codex/reviewer.config.toml
sandbox_mode = "read-only"
```
```bash
codex exec --profile reviewer "Use the reviewer skill. …"
```

`.codex/agents/reviewer.toml`, installed alongside the skills, is a subagent definition Codex can discover under `.codex/agents/` and spawn on its own. We have **not** verified the exact auto-discovery/declaration syntax against a live Codex session (no Codex account in our test environment) — don't take the `[agents.reviewer]` shape as confirmed. If you rely on it, run the "create TEST.md" probe from [docs/HARNESS-MATRIX.md](./docs/HARNESS-MATRIX.md#verify-it-yourself) first, and please report the result either way.

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
