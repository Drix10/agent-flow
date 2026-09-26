# Harness Enforcement Matrix

Not all harnesses enforce tool restrictions the same way. This document tells you exactly what is enforced vs. advisory per harness.

| Feature | Pi | Claude Code | Codex | Gemini CLI | Cursor | VS Code |
|---|---|---|---|---|---|---|
| Skill discovery | ✅ `pi.skills` | ✅ `.claude/skills/` | ✅ `.agents/skills/` | ✅ `.gemini/skills/` | ✅ `.cursor/skills/` | ✅ `.github/skills/` |
| Frontmatter `name` required | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `allowed-tools` enforcement | ✅ (experimental) | ⚠️ Advisory only | ❌ | ❌ | ❌ | ❌ |
| Subagent tool restriction | ✅ (extension) | ✅ (`tools` field) | ⚠️ TOML ships, discovery unverified | ✅ (tool list, needs `enableAgents`) | ✅ (permission config) | ✅ (agent profile) |
| Workspace trust required | ❌ | ✅ (project skills) | ❌ | ✅ (`/trust`) | ❌ | ✅ |
| Auto-discovery | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Slash command from skill | ✅ `/skill:name` | ✅ `/name` (dir name) | ✅ `/skills` | ✅ `/skills list` | ✅ `/` menu | ✅ chat slash |
| Pi extensions available | ✅ native | ❌ | ❌ | ❌ | ❌ | ❌ |

## Key Takeaway

**`allowed-tools` in SKILL.md frontmatter is NOT enforced by Claude Code.** An experiment found that `allowed-tools: Read` did not prevent Grep or Glob from being used in an inline skill context. The field grants pre-approval, not restriction.

**For real enforcement, use harness-level subagent definitions.** Claude Code's `tools` field in a subagent definition (`skills/reviewer/agents/claude.md`) restricts which tools the subagent receives. If `Write` and `Edit` are not listed, the subagent physically cannot modify files.
