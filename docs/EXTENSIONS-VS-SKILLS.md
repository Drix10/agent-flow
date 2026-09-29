# Skills, extensions, the CLI and the hook

Agent Flow ships five kinds of component. They reach different places.

| Component | Where it runs | What it can enforce |
|---|---|---|
| **Skills** (`skills/*/SKILL.md`) | Any Agent Skills harness | Nothing. They are instructions. |
| **Pi extensions** (`extensions/`) | Pi only | Blocks tool calls *before* they execute (`tool_call` guard), and validates state transitions and risk classification |
| **Claude Code hook** (`agent-flow guard`, wired by `install --harness claude`) | Claude Code | The same guard policy as Pi, as a `PreToolUse` hook: blocks file writes and recognised shell writes before they run |
| **CLI** (`bin/agent-flow.js`) | Anywhere Node ≥ 20 runs: every harness and CI | The same state machine, classifier, drift and risk checks, called from a shell |
| **Pre-commit hook** (`agent-flow hook install`) | Any git client | Blocks commits that touch protected paths, contain secrets, or break context references |

The extensions, the hook and the CLI share one library (`extensions/lib/`, zero dependencies), so their behaviour can't drift apart.

## Subagent definitions

Harnesses discover subagents in their own directories, not in `skills/`. A file under `skills/<name>/agents/` does nothing in every harness. The reviewer definitions ship at `.claude/agents/`, `.codex/agents/` and `.gemini/agents/`, and `agent-flow install` copies them into place.

## The road to tool-call enforcement everywhere

An **MCP server** exposing the same tools would carry the state machine, classifier and checks to every MCP client. It still wouldn't intercept the harness's *built-in* write tools; only the harness can do that (Pi's `tool_call`, Claude Code's `tools` field and `PreToolUse` hook, the Codex sandbox). So the plan is MCP for the tools, and each harness's native mechanism for blocking. See ROADMAP.
