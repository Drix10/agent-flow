# Roadmap

## v1.0.x — Prove it works (now)

- [ ] Verify `allowed-tools` enforcement: instruct the Reviewer to write a file, confirm it refuses (FM-16)
- [ ] End-to-end dry run: `/bootstrap` → `/implement` → `/garden` on a real repo, twice, on two different repos
- [ ] Real unit tests for each extension `execute()` handler (fake repo in, asserted shape out)
- [ ] Demo repo: `github.com/Drix10/agent-flow-demo` with full lifecycle walkthrough
- [ ] Publish `v1.0.0` quietly to npm; announce `v1.0.1` after the dry run passes

## v1.1 — Harden the loop

- [ ] FM-14: flaky-test detection in QA (re-run failures once before reporting)
- [ ] Pre-commit hook template that rejects protected-path changes and broken context references
- [ ] `ctxlint` wired into CI once the action is verified
- [ ] `pi.image` gallery preview (1200×630)

## v2.0 — Scale the team

- [ ] Ship extensions as an MCP server (`mcp.json` at plugin root) so `state_update`, `risk_audit`, etc. exist on every harness, not just Pi. This is the only path to genuine cross-harness enforcement. See `docs/EXTENSIONS-VS-SKILLS.md`.

- [ ] FM-13: multi-repo coordination (cross-repo dependencies)
- [ ] FM-15: model provider fallback configuration
- [ ] Claude Code native support (verified permission mapping, not just copied skills)
- [ ] VS Code extension integration

## Out of scope

- Multi-tenant / SaaS hosting. This is a local-first repo tool.
- Custom model training or fine-tuning. The Trust Loop is model-agnostic by design.
- Framework-specific scaffolding. The package bootstraps process, not code.
