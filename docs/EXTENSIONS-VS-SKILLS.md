# Extensions vs. Skills

Agent Flow has two kinds of components. They travel differently.

## Skills (`skills/`)

Instruction-only Markdown. They follow the Agent Skills open standard, so they copy into any compatible harness: Pi, Claude Code, Codex, Gemini CLI, Cursor, VS Code. Skills describe *process* — who does what, in which order, with which constraints.

## Extensions (`extensions/`)

TypeScript tools registered on Pi's `ExtensionAPI` (`bootstrap_scan`, `worktree_create`, `state_update`, `stale_detect`, `risk_audit`, `detect_harness`). They are **Pi-only**. Agent Plugins 1.0.0 standardizes exactly two component types — Agent Skills and MCP servers — so Pi extensions do not travel to other harnesses.

## What this means per harness

- **Pi:** skills + extensions. Full enforcement.
- **Everywhere else:** skills only. Wherever a skill says "call `state_update`" or "run `risk_audit`", that tool does not exist. The skill bodies tell the agent to fall back to editing `AGENT_STATE.md` and the context files directly — honest, but advisory.

## The path to real cross-harness enforcement

Ship the extensions as an **MCP server** (`mcp.json` at the plugin root) exposing the same tools. Agent Plugins carries MCP servers to every conforming client, so `state_update` and friends would exist everywhere. Until then, the README scopes the claim per harness instead of pretending.
