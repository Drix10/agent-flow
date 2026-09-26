# Agent Flow — 5-Minute Quickstart

## Install

```bash
# Pi
pi install npm:@drix10/agent-flow

# Claude Code
mkdir -p .claude/skills && cp -r node_modules/@drix10/agent-flow/skills/* .claude/skills/

# Codex
mkdir -p .agents/skills && cp -r node_modules/@drix10/agent-flow/skills/* .agents/skills/

# Gemini CLI
mkdir -p .gemini/skills && cp -r node_modules/@drix10/agent-flow/skills/* .gemini/skills/
# Then run /trust in the workspace
```

## Bootstrap

```text
/bootstrap
```

The agent scans your repo, proposes tiered context files with confidence markers, and asks you to confirm risk boundaries. Nothing is written until you confirm.

## Run the Pipeline

```text
/implement 42
```

This creates a worktree, runs the Implementer, sends the diff to the Reviewer, runs QA, and opens a PR. If the Reviewer requests changes, the Implementer gets up to 2 rounds.

## Maintain

```text
/garden
```

Full maintenance cycle: sync docs, audit risk, detect stale context, repair affected files.

## Check State

Open `AGENT_STATE.md`. Sessions are sorted by **Needs Me**, **Working**, and **Completed**.
