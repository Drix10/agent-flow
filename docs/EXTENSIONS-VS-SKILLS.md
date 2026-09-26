# Extensions vs. Skills

Agent Flow has two kinds of components. They travel differently.

## Skills (`skills/`)

Instruction-only Markdown. They follow the Agent Skills open standard, so they copy into any compatible harness: Pi, Claude Code, Codex, Gemini CLI, Cursor, VS Code. Skills describe *process* — who does what, in which order, with which constraints.

## Extensions (`extensions/`)

TypeScript tools registered on Pi's `ExtensionAPI` (`bootstrap_scan`, `worktree_create`, `state_update`, `stale_detect`, `risk_audit`, `detect_harness`). They are **Pi-only**. Agent Plugins 1.0.0 standardizes exactly two component types — Agent Skills and MCP servers — so Pi extensions do not travel to other harnesses.

## The rule

**Skills travel through `skills/`; subagents travel through each harness's `agents/` directory.** They are two different discovery mechanisms, and Agent Plugins 1.0.0 only standardizes the first one. Extensions and subagents do not travel — a file under `skills/<name>/agents/` is inert documentation in every harness, no matter how correct its frontmatter is. Every subagent this repo ships lives at its harness-canonical path (`.claude/agents/`, `.codex/agents/`, `.gemini/agents/`) and is copied from there.

- **Pi:** skills + extensions. Full enforcement.
- **Claude Code:** skills + a Reviewer subagent definition copied to the harness `agents/` dir — the only hard read-only enforcement in the project. State machine and risk-audit tools do not exist there. - **Codex / Gemini CLI:** skills + a Reviewer subagent definition (conventional read-only; Codex TOML discovery itself unverified). Wherever a skill says "call `state_update`" or "run `risk_audit`", the agent falls back to editing `AGENT_STATE.md` and the context files directly — honest, but advisory.
- **Cursor / VS Code:** skills only.

## The path to real cross-harness enforcement

Ship the extensions as an **MCP server** (`mcp.json` at the plugin root) exposing the same tools. Agent Plugins carries MCP servers to every conforming client, so `state_update` and friends would exist everywhere. Until then, the README scopes the claim per harness instead of pretending.
