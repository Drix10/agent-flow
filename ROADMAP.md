# Roadmap

Where Agent Flow is going. Shipped items live in [CHANGELOG.md](./CHANGELOG.md), not here.

## Next

- Live containment probes for the two remaining unverified harness claims (Gemini reviewer, Claude Code reviewer allow-list path), promoted to ✅/❌ in the matrix.
- `agent-flow report`: summarize `.agent-flow/audit.jsonl` into trust signals (guard blocks per role, escalation reasons, rounds per issue). The Gardener consumes that report to propose `protected_paths` and lint rules.
- Public demo repo with a recorded, unedited `/bootstrap` → `/implement` → `/garden` run.
- GitHub Action wrapper (`uses: Drix10/agent-flow@v1`).

## Later

- MCP server exposing state, classify, doctor, audit and worktrees to every MCP client.
- Claude Code `PreToolUse` hook shipping the guard policy (same `lib/guard.ts`).
- FM-13: multi-repo coordination.
- FM-15: model-provider fallback and resumable runs.

## Out of scope

- Hosting / SaaS. This is a local-first repo tool.
- Model training or fine-tuning.
- Framework scaffolding. Agent Flow bootstraps process and context, not code.
