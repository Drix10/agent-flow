<div align="center">

# Agent Flow

**Keep agent context accurate. Run code changes through separate implementation, review and QA steps.**

[![npm version](https://img.shields.io/npm/v/@drix10/agent-flow?style=flat-square&logo=npm)](https://www.npmjs.com/package/@drix10/agent-flow)
[![CI](https://img.shields.io/github/actions/workflow/status/Drix10/agent-flow/ci.yml?branch=main&style=flat-square&logo=github&label=CI)](https://github.com/Drix10/agent-flow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](./LICENSE)
[![Node](https://img.shields.io/node/v/@drix10/agent-flow?style=flat-square&logo=node.js&logoColor=white&label=node)](https://nodejs.org/)

</div>

Agent Flow is a Node.js CLI and skills package for Claude Code, Codex CLI, Gemini CLI, Cursor, Copilot, Windsurf, Pi and other tools that read `AGENTS.md`. It checks agent context against the repository, classifies code changes against repository policy, and provides a bounded implement-review-QA workflow.

It has no runtime dependencies and does not require a `package.json` in the repository being set up. Node.js 20 or later is required to run it.

## Quick start

Install the harness files, then ask your coding agent to bootstrap the repository:

```bash
npx @drix10/agent-flow install --harness claude
```

Use `codex`, `gemini`, `cursor`, `copilot`, `windsurf` or `agents` instead of `claude` for those tools. Pi users can install the package with `pi install npm:@drix10/agent-flow`.

In repositories without `package.json`, `install` vendors the small runtime needed by local hooks into `.agent-flow-runtime/`. Commit that directory so the hooks work for other clones; Agent Flow adds no package files or dependencies to the project.

To have your coding agent do the whole setup for you, give it the prompt in [SETUP.md](SETUP.md).

Bootstrap scans the code read-only and proposes `AGENTS.md`, `CONTEXT_MANIFEST.json` and related context files. It asks about protected paths and risk boundaries before writing. Review every proposal before accepting it.

For Claude Code, run a task with observable acceptance criteria:

```bash
npx @drix10/agent-flow run "Add a --json flag so CI can parse the output"
```

The command runs in a worktree and leaves checked work local by default. Add `--dry-run` to see setup gaps without launching roles. Add `--pr` to push the branch and open a pull request. Add `--auto-merge` only when you want eligible low-risk PRs queued for merge and the repository also sets `pipeline.auto_merge_low_risk: true`.

On other harnesses, ask the agent to use the `invoking-agents` skill for an issue or task. It applies the same state, risk, review and QA checks using that harness's launch procedure. Pi also provides `/implement <issue>`.

## Keep the setup current

```bash
npx @drix10/agent-flow@latest update --yes
npx @drix10/agent-flow doctor
npx @drix10/agent-flow audit-risk --fail-on-new
```

`update` refreshes unedited skills, hooks and the vendored runtime; it preserves files you customized. `doctor` checks context paths, commands, links and manifest freshness. `audit-risk` compares dependencies, secrets and other risk surfaces with `.risk-baseline.json`. See [Adoption](docs/ADOPTION.md) for update behavior by install type.

## Add CI checks

The CLI works in Python, Go, C++, Rust and other repositories without adding `package.json` or `node_modules`. Node.js is needed in the CI job to run it.

```yaml
name: agent-context
on: [push, pull_request]
jobs:
  context:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npx @drix10/agent-flow doctor
      # Create and review .risk-baseline.json before enabling this gate.
      - run: npx @drix10/agent-flow audit-risk --fail-on-new
```

Or use the [composite GitHub Action](action.yml), which also classifies pull request changes and can upload SARIF:

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- uses: Drix10/agent-flow@v1.2.0
```

## What it does

| Area | Behavior | Command or enforcement |
|---|---|---|
| Context drift | Checks referenced paths, commands, relative links, cited commits and manifest timestamps. | `agent-flow doctor` |
| Setup | Scans the repository and proposes context files with confidence markers. | `bootstrap` skill; `agent-flow scan` and `init` |
| Risk | Classifies the actual diff using protected paths and risk boundaries. | `agent-flow classify` |
| Pipeline | Runs implementation, mechanical classification, review, required gates and QA with a round cap. | `agent-flow run` on Claude Code; `invoking-agents` skill elsewhere |
| Risk changes | Compares new dependencies, credentials, payment/auth code and other risk signals with a reviewed baseline. | `agent-flow audit-risk --fail-on-new` |
| Audit trail | Records state changes, guard blocks, gate results and role runs in a hash-chained log. | `agent-flow audit verify` and `summary` |

Useful commands:

```bash
npx @drix10/agent-flow status       # protection, checks, context and pending work
npx @drix10/agent-flow doctor       # read-only context report
npx @drix10/agent-flow scan         # read-only repository reconnaissance
npx @drix10/agent-flow hook install # install the pre-commit gate
npx @drix10/agent-flow state dismiss --issue 100000 --reason "did it by hand"   # drop an issue from the list
```

## Pipeline behavior

```text
task -> worktree -> implement -> classify -> review -> gates -> QA -> optional PR
                         ^                         |
                         +--- bounded fix rounds --+
```

Each role is a separate process and receives files from `.agent-flow/artifacts/issue-N/`, not another role's reasoning. Issue text is escaped and treated as untrusted input. The state machine enforces transitions and the review-round cap. Repeated failures stop for a human. When you request a PR, critical changes create a draft and wait for human review. Local is the default; publishing needs `--pr`.

The loop is not equally enforced on every harness. The guard blocks tool calls directly on Claude Code and Pi. Other harnesses rely on their available sandbox and the pre-commit hook, which runs at commit time and can be bypassed by a human. Reviewer write restrictions vary by harness. See the [harness matrix](docs/HARNESS-MATRIX.md) before choosing a role setup.

## Repository context

Agent Flow uses `AGENTS.md` for shared agent instructions. Claude Code can load it through `CLAUDE.md` containing `@AGENTS.md`. Module-level `AGENTS.md` files add rules for that part of the repository. `CONTEXT_MANIFEST.json` records referenced paths, protected paths, risk boundaries and pipeline settings. The `gardener` skill checks and repairs this context; it re-reads the code before refreshing timestamps.

When an agent repeats a mistake, prefer a mechanical fix: an invariant in code, a test, a guard rule or a protected path. Prompts and prose are the least reliable enforcement.

## Limits and security

- Risk classification and secret detection are heuristic; review their findings.
- Shell-write analysis is best-effort. Use a sandbox or remove shell access from read-only roles when a hard boundary is required.
- Per-tool enforcement is available on Claude Code and Pi. Other harnesses have different enforcement limits.
- Hooks do not access the network. `doctor` may make optional, cached read-only lookups for package updates and GitHub Code Owner settings; CI and offline modes skip them.
- Each issue gets its own git worktree. Measured on Windows with a synthetic 60,000-file repository: creating it took 16 seconds (git's checkout), Agent Flow's own commands each finished in about half a second or less, and the before-and-after check around QA added about 3 seconds in total. Very large monorepos should use git sparse-checkout or a partial clone; Agent Flow does not automate that.
- Critical changes are reviewed by a stronger model only if you set `pipeline.models.high_reasoning` (and `pipeline.models.fast` for the rest). Unset, every role uses the default model, and `status` and `run` say so.
- Audit logs are tamper-evident, not tamper-proof. Keep an audit hash outside the repository if you need an external trust anchor.

See [Security](SECURITY.md) and [known failure modes](FAILURE_MODES.md) for details. Agent Flow works one repository at a time and does not provide model-provider failover.

## Development

```bash
npm install
npm test
```

The test suite exercises real temporary Git repositories and supported installation targets. See [Contributing](CONTRIBUTING.md).

## License

MIT
