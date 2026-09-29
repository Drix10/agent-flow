# Roadmap

Where Agent Flow is going. Shipped items live in [CHANGELOG.md](./CHANGELOG.md), not here.

## Next: closing what command-text analysis cannot

The guard reads command text, so it has documented limits (`tests/redteam/corpus.json` lists them as `gap`). These remove classes of gap rather than adding patterns:

- **OS-level sandbox launcher** (`agent-flow sandbox -- <agent>`): bubblewrap, Landlock or `sandbox-exec`, with protected paths mounted read-only, `deny_read` paths masked and the environment scrubbed. The only hard guarantee for shell and interpreter writes.
- **Gates run by the orchestrator, not the model:** a manifest `gates` list (command, cwd, run-as user, timeout, expected exit code) that the pipeline executes itself, hashing the logs, with the QA role only interpreting them.
- **Tamper-evident audit log:** a hash chain in `.agent-flow/audit.jsonl`, `audit verify`, and periodic anchoring in git.
- **Run supervision:** wall-clock, token and cost budgets per role, resumable runs, and a merge-conflict queue between parallel issues.
- **Policy beyond paths:** required gates or reviewers per path, diff-pattern rules, test-must-change rules, size caps, and signed exceptions with an expiry.
- **Distribution:** a GitHub Action, SARIF output for `doctor` / `audit-risk` / `check-staged`, and versioned JSON schemas.
- **Blast radius from a dependency graph:** `classify` from what a change reaches (an adapter over an existing code graph) instead of path names alone, and every classification reason tagged mechanical or heuristic.

## Also next

- Live containment probes for the two remaining unverified harness claims (Gemini reviewer, Claude Code reviewer allow-list path), promoted to ✅/❌ in the matrix.
- A command that summarizes `.agent-flow/audit.jsonl` into trust signals (guard blocks per role, escalation reasons, rounds per issue). The Gardener consumes that report to propose `protected_paths` and lint rules.
- Public demo repo with a recorded, unedited `/bootstrap` → `/implement` → `/garden` run.
- GitHub Action wrapper (`uses: Drix10/agent-flow@v1`).

## Later

- MCP server exposing state, classify, doctor, audit and worktrees to every MCP client.
- FM-13: multi-repo coordination.
- FM-15: model-provider fallback and resumable runs.

## Out of scope

- Hosting / SaaS. This is a local-first repo tool.
- Model training or fine-tuning.
- Framework scaffolding. Agent Flow bootstraps process and context, not code.
