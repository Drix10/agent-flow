# Roadmap

Where Agent Flow is going. Shipped items live in [CHANGELOG.md](./CHANGELOG.md), not here.

## Next: closing what command-text analysis cannot

The guard reads command text, so it has documented limits (`tests/redteam/corpus.json` lists them as `gap`). These remove classes of gap rather than adding patterns:

- **OS-level sandbox launcher** (`agent-flow sandbox -- <agent>`): bubblewrap, Landlock or `sandbox-exec`, with protected paths mounted read-only, `deny_read` paths masked and the environment scrubbed. The only hard guarantee for shell and interpreter writes.
- **Run-as-user gates:** `gates` run as the orchestrator's user today. A per-gate run-as user (the QA freeze rule, for repos where tests must run unprivileged) needs a launcher that can drop privileges.
- **Run supervision:** wall-clock, token and cost budgets per role (cost is recorded per run today, not capped), resumable runs, and a merge-conflict queue between parallel issues.
- **Policy beyond paths:** required reviewers per path, and signed exceptions with an expiry. Size, pattern and test-must-change rules ship in 1.1.3.
- **Anchoring the audit head automatically:** `audit head` prints the hash; committing it to a place the agent can't write (a signed tag, a CI artifact, a separate repo) is still the adopter's step.
- **Blast radius from a dependency graph:** `classify` from what a change reaches (an adapter over an existing code graph) instead of path names alone, and every classification reason tagged mechanical or heuristic. `--fail-on-heuristic` refuses the guess today; it doesn't replace it.
- **Alias tracking in the guard:** `ln -s .env x && cat x` and other two-step symlink or variable tricks. The corpus lists them as gaps; the OS sandbox closes them.
- **SARIF for `check-staged`**, and a first real run of `action.yml` on GitHub (it ships untested there).

## Also next

- Live containment probes for the two remaining unverified harness claims (Gemini reviewer, Claude Code reviewer allow-list path), promoted to ✅/❌ in the matrix.
- The Gardener consuming `audit summary` to propose `protected_paths` and lint rules (the report exists; the skill doesn't read it yet).
- Public demo repo with a recorded, unedited `/bootstrap` → `/implement` → `/garden` run.

## Later

- MCP server exposing state, classify, doctor, audit and worktrees to every MCP client.
- FM-13: multi-repo coordination.
- FM-15: model-provider fallback and resumable runs.

## Out of scope

- Hosting / SaaS. This is a local-first repo tool.
- Model training or fine-tuning.
- Framework scaffolding. Agent Flow bootstraps process and context, not code.
