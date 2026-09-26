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

Skills surface as `/bootstrap`, `/implementer`, etc. **The Reviewer subagent** is defined in `.claude/agents/reviewer.md` and enforces read-only via Claude Code's `tools` field. That file is a reference — Claude Code only loads subagents from `.claude/agents/`, so copy it into place:

```bash
mkdir -p .claude/agents
cp node_modules/@drix10/agent-flow/.claude/agents/reviewer.md .claude/agents/reviewer.md
```

## Codex CLI

```bash
mkdir -p .agents/skills
cp -r node_modules/@drix10/agent-flow/skills/* .agents/skills/
```

Skills auto-discover. Invoke with `/skills` or `$reviewer`. A Reviewer definition ships at `.codex/agents/reviewer.toml` in this repo — copy it to your project's `.codex/agents/` and declare it:

```bash
mkdir -p .codex/agents
cp node_modules/@drix10/agent-flow/.codex/agents/reviewer.toml .codex/agents/reviewer.toml
```

```toml
# .codex/config.toml (append)
[agents.reviewer]
description = "Read-only code reviewer"
config_file = "./.codex/agents/reviewer.toml"
```

**Verify before relying on it:** run `codex --help` or check the agent list for the `reviewer` role. The TOML format is verified; the `config_file` auto-discovery path is not. Until confirmed, treat Codex read-only as conventional.

## Gemini CLI

```bash
mkdir -p .gemini/skills
cp -r node_modules/@drix10/agent-flow/skills/* .gemini/skills/
```

**Important:** Gemini CLI requires workspace trust. Run `/trust` in the workspace, then restart the session. Verify with `/skills list`.

Subagents additionally require the experimental flag. Copy `.gemini/settings.json.example` to `.gemini/settings.json` (or merge the `experimental.enableAgents` key — older docs call it `enableSubagents`), and copy the reviewer definition into place:

```bash
mkdir -p .gemini/agents
cp node_modules/@drix10/agent-flow/.gemini/agents/reviewer.md .gemini/agents/reviewer.md
```

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
