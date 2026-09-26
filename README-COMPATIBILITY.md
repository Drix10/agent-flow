# Agent Flow — Cross-Harness Installation

Agent Flow follows the [Agent Skills open standard](https://agentskills.io). The same `skills/` directory works across all major harnesses.

## Pi (native)

```bash
pi install npm:@drix10/agent-flow
```

Skills auto-surface as `/skill:name`. Prompts in `prompts/` become `/name` commands.

## Claude Code

```bash
mkdir -p .claude/skills
cp -r node_modules/@drix10/agent-flow/skills/* .claude/skills/
```

Or symlink:

```bash
ln -s node_modules/@drix10/agent-flow/skills .claude/skills/agent-flow
```

Skills surface as `/bootstrap`, `/implementer`, etc. **The Reviewer subagent** is defined in `skills/reviewer/agents/claude.md` and enforces read-only via Claude Code's `tools` field.

## Codex CLI

```bash
mkdir -p .agents/skills
cp -r node_modules/@drix10/agent-flow/skills/* .agents/skills/
```

Skills auto-discover. Invoke with `/skills` or `$reviewer`.

## Gemini CLI

```bash
mkdir -p .gemini/skills
cp -r node_modules/@drix10/agent-flow/skills/* .gemini/skills/
```

**Important:** Gemini CLI requires workspace trust. Run `/trust` in the workspace, then restart the session. Verify with `/skills list`.

## Cursor

```bash
mkdir -p .cursor/skills
cp -r node_modules/@drix10/agent-flow/skills/* .cursor/skills/
```

Skills auto-discover. Invoke from the `/` menu or let the agent match the description.

## VS Code / GitHub Copilot

```bash
mkdir -p .github/skills
cp -r node_modules/@drix10/agent-flow/skills/* .github/skills/
```

VS Code also reads `.claude/skills/` and `.agents/skills/`. Skills surface as slash commands in chat.

## Agent Plugins 1.0

Agent Flow ships a `plugin.json` manifest. The plugin format expects:

```text
agent-flow-plugin/
├── plugin.json
├── skills/
│   └── bootstrap/
│       └── SKILL.md
└── mcp.json (optional)
```
