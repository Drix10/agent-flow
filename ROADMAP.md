# Roadmap

## v1.1 — Make the claims true (this release)
- [x] FM-16: real read-only enforcement on Pi (guard + `--tools`)
- [x] Mechanical round cap and state transitions
- [x] Mechanical risk classification from the real diff
- [x] Pre-commit hook: protected paths, secrets, broken context references
- [x] CLI for non-Pi harnesses and CI
- [x] Prose drift detection, case-exact paths
- [x] Security fixes from self-audit (injection, traversal, npx, confirmation)

## v1.2 — Prove it in the wild
- [ ] Public demo repo with a recorded, unedited `/bootstrap` → `/implement` → `/garden` run
- [x] Claude Code reviewer subagent: live-verified (Task tool launch, told to write `TEST.md`, blocked — see [SECURITY.md](./SECURITY.md))
- [ ] Codex: `--sandbox read-only` flag confirmed real (`codex exec --help`, v0.157.1); still need a live write-block probe against an authenticated session
- [ ] Probe result for the Gemini tool list (turn ⚠️ into ✅/❌ in the matrix)
- [ ] `agent-flow report`: summarize `.agent-flow/audit.jsonl` into trust signals (guard blocks per role, escalation reasons, rounds per issue)
- [ ] Gardener consumes that report to propose `protected_paths` and lint rules automatically
- [ ] GitHub Action wrapper (`uses: Drix10/agent-flow@v1`)

## v2.0 — Everywhere
- [ ] MCP server exposing the same tools (state, classify, doctor, audit, worktrees) to every MCP client
- [ ] Claude Code `PreToolUse` hook shipping the guard policy (same `lib/guard.ts`)
- [ ] FM-13: multi-repo coordination
- [ ] FM-15: model-provider fallback and resumable runs

## Out of scope
- Hosting / SaaS. This is a local-first repo tool.
- Model training or fine-tuning.
- Framework scaffolding. Agent Flow bootstraps process and context, not code.
