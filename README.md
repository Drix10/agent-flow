<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo.svg" alt="Agent Flow" width="320">
</picture>

*Leave your coding agent alone with your repo. Come back to a reviewed pull request, not a mess.*

[![npm version](https://img.shields.io/npm/v/@drix10/agent-flow?style=flat-square&color=111111&label=npm)](https://www.npmjs.com/package/@drix10/agent-flow)
[![npm downloads](https://img.shields.io/npm/dm/@drix10/agent-flow?style=flat-square&color=111111&label=downloads)](https://www.npmjs.com/package/@drix10/agent-flow)
[![CI](https://img.shields.io/github/actions/workflow/status/Drix10/agent-flow/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/Drix10/agent-flow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-111111?style=flat-square)](./LICENSE)

**One agent builds. A second reviews. A third tests. A guard keeps all three out of what they must never touch.**

[Install](#install) · [What you come back to](#what-you-come-back-to) · [How it works](#how-it-works) · [Harnesses](docs/HARNESS-MATRIX.md) · [FAQ](#faq)

</div>

---

## Install

```bash
npx @drix10/agent-flow install --harness claude
```

Then tell your agent *"use the agent-flow-bootstrap skill"*: it reads the repo and asks what must never be touched. After that, hand it a task:

```bash
npx @drix10/agent-flow run "Add a --json flag so CI can parse the output"
```

That's all of it. It runs in its own git worktree and stops with checked work and a draft pull request waiting for you. Works with Claude Code, Codex, Gemini CLI, Cursor, Copilot, Windsurf, Pi and anything that reads `AGENTS.md`: swap `claude` for `codex`, `gemini`, `cursor`, `copilot`, `windsurf` or `agents`. Node.js 20+, no runtime dependencies, no `package.json` needed in your repo.

**The guard blocks tool calls directly on Claude Code and Pi.** On the other hosts the skills guide the agent and a pre-commit hook and CI catch the slips: [what each host enforces](docs/HARNESS-MATRIX.md).

## What you come back to

Real output from a run on a real repository (trimmed):

```text
$ agent-flow status

Protection
  ✓ Claude Code guard hook is active
  ✓ 11 protected paths, 7 critical areas
  ✓ 1 review-only path: agents may add lines (a new CI test), a person reviews the pull request

Work
  · #100000 is ready: reviewed, checked, not pushed
      → agent-flow run 100000 --pr  to open the pull request
```

## Without it, and with it

| | ❌ Without Agent Flow | ✅ With Agent Flow |
|---|---|---|
| **Who checks the work** | The agent that wrote it | A second agent reviews, a third runs the checks |
| **The new test isn't in the CI list** | It edits the workflow or loosens the check to get green | It adds one line; every other CI change is refused |
| **Push to `main`, force-push, `--no-verify`** | Nothing stops it | Refused by the guard (Claude Code, Pi) or caught by the pre-commit hook |
| **A check fails** | You find out when you're back | It goes back to the Implementer, up to a round cap |
| **When you're back** | A whole diff to read | A draft pull request and a short list of what needs you |
| **Docs and context** | `AGENTS.md` describes the old behaviour | `agent-flow doctor` flags it |
| **What happened** | Ask the agent | A hash-chained audit log |

## From one real repo

Agent Flow ran for five days on a real C++ and Python research repository (294 role runs, about $83). The audit log recorded:

- **150 tool calls blocked**, among them 20 reads of secret files, 2 pushes to `main` and 1 `--no-verify`. Not every block was right: 16 were false alarms from a Windows path bug, fixed in 1.2.6.
- **15 lines added to the CI workflow, none changed or deleted.**
- **A median finished issue cost $0.90 and took 17 minutes**, over 63 issues.

One repository, one maintainer: an example, not a benchmark.

<details>
<summary><b>More ways to install and run</b></summary>

**Try it first, nothing installed and nothing written:**

```bash
npx @drix10/agent-flow scan
```

A read-only X-ray of any repository: languages, test and lint commands, CI, secret suspects. Or take just the skills, with any agent, via [skills.sh](https://skills.sh) (they call the CLI through `npx`, so there is still nothing to set up):

```bash
npx skills add Drix10/agent-flow
```

Install the harness files, then ask your coding agent to bootstrap the repository:

```bash
npx @drix10/agent-flow install --harness claude     # nothing to install first
```

Or install it from npm and use the short `agent-flow` command:

```bash
npm install --global @drix10/agent-flow             # the agent-flow command everywhere
agent-flow install --harness claude

npm install --save-dev @drix10/agent-flow           # or pin it in a Node project's package.json
npx agent-flow install --harness claude
```

On Claude Code you can also add the skills as a plugin: `/plugin marketplace add Drix10/agent-flow`, then `/plugin install agent-flow@agent-flow-marketplace`. **The plugin installs the skills only. The guard that blocks edits is wired by `install`, so run it too.** `agent-flow status` says whether the guard is on.

Use `codex`, `gemini`, `cursor`, `copilot`, `windsurf` or `agents` instead of `claude` for those tools. Pi users can install the package with `pi install npm:@drix10/agent-flow`.

In repositories without `package.json`, `install` vendors the small runtime needed by local hooks into `.agent-flow-runtime/`. Commit that directory so the hooks work for other clones; Agent Flow adds no package files or dependencies to the project.

To have your coding agent do the whole setup for you, give it the prompt in [SETUP.md](SETUP.md).

Bootstrap scans the code read-only and proposes `AGENTS.md`, `CONTEXT_MANIFEST.json` and related context files. It asks about protected paths and risk boundaries before writing. Review every proposal before accepting it.

For Claude Code, run a task with observable acceptance criteria:

```bash
npx @drix10/agent-flow run "Add a --json flag so CI can parse the output"
```

The command runs in a worktree and leaves checked work local by default. Add `--dry-run` to see setup gaps without launching roles. Add `--pr` to push the branch and open a pull request. Add `--auto-merge` only when you want eligible low-risk PRs queued for merge and the repository also sets `pipeline.auto_merge_low_risk: true`.

On other harnesses, ask the agent to use the `agent-flow-invoking-agents` skill for an issue or task. It applies the same state, risk, review and QA checks using that harness's launch procedure. Pi also provides `/implement <issue>`.

</details>

<details>
<summary><b>Keep it current, and run it in CI</b></summary>

```bash
npx @drix10/agent-flow@latest update --yes
npx @drix10/agent-flow doctor
npx @drix10/agent-flow audit-risk --fail-on-new
```

`update` refreshes unedited skills, hooks and the vendored runtime; it preserves files you customized. `doctor` checks context paths, commands, links and manifest freshness. `audit-risk` compares dependencies, secrets and other risk surfaces with `.risk-baseline.json`. See [Adoption](docs/ADOPTION.md) for update behavior by install type.

**Add CI checks**

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
- uses: Drix10/agent-flow@v1.2.6
```

</details>

<details>
<summary><b>Everything it does, and the commands</b></summary>

| Area | Behavior | Command or enforcement |
|---|---|---|
| Context drift | Checks referenced paths, commands, relative links, cited commits and manifest timestamps. | `agent-flow doctor` |
| Setup | Scans the repository and proposes context files with confidence markers. | `agent-flow-bootstrap` skill; `agent-flow scan` and `init` |
| Risk | Classifies the actual diff using protected paths and risk boundaries. | `agent-flow classify` |
| Pipeline | Runs implementation, mechanical classification, review, required gates and QA with a round cap. | `agent-flow run` on Claude Code; `agent-flow-invoking-agents` skill elsewhere |
| Risk changes | Compares new dependencies, credentials, payment/auth code and other risk signals with a reviewed baseline. | `agent-flow audit-risk --fail-on-new` |
| Audit trail | Records state changes, guard blocks, gate results and role runs in a hash-chained log. | `agent-flow audit verify` and `summary` |
| Deferred shortcuts | Reads back every `lean:` comment (a ceiling and when to upgrade) and flags the ones that name no trigger. | `agent-flow debt`; [Lean](docs/LEAN.md) |
| Token cost | Short skill descriptions, an orchestrator skill that a CLI run never loads, terse role output, and a warning when a context file is heavy. | `agent-flow doctor`; [what changed](docs/LEAN.md#spending-fewer-tokens-on-the-instructions-themselves) |
| Other tools | A read-only MCP server and a status badge, so a host without our hook can still ask. | `agent-flow mcp`, `agent-flow statusline` |

Useful commands:

```bash
npx @drix10/agent-flow status       # protection, checks, context and pending work
npx @drix10/agent-flow doctor       # read-only context report
npx @drix10/agent-flow scan         # read-only repository reconnaissance
npx @drix10/agent-flow hook install # install the pre-commit gate
npx @drix10/agent-flow debt         # the shortcuts agents left, and which have no trigger to revisit them
npx @drix10/agent-flow uninstall    # preview taking back out what install wrote (--yes to do it)
npx @drix10/agent-flow state dismiss --issue 100000 --reason "did it by hand"   # drop an issue from the list
npx @drix10/agent-flow state dismiss --merged                                   # drop every finished issue already merged into the default branch
```

</details>

## How it works

```text
task -> worktree -> implement -> classify -> review -> gates -> QA -> optional PR
                         ^                         |
                         +--- bounded fix rounds --+
```

Each role is a separate process and receives files from `.agent-flow/artifacts/issue-N/`, not another role's reasoning. Issue text is escaped and treated as untrusted input. The state machine enforces transitions and the review-round cap. Repeated failures stop for a human. When you request a PR, critical changes create a draft and wait for human review. Local is the default; publishing needs `--pr`.

`pipeline.lean` asks the Implementer and Reviewer for the smallest correct change and marks the shortcuts it takes ([Lean](docs/LEAN.md)).

Protected paths stop a run; review-only paths (`review_paths`, usually `.github/workflows/`) don't. An agent may add a line there, such as a new test in the CI list, and the pull request waits as a draft for you. See [Adoption](docs/ADOPTION.md#review-only-paths-ci-and-test-lists-without-stopping-an-unattended-run).

The loop is not equally enforced on every harness. The guard blocks tool calls directly on Claude Code and Pi. Other harnesses rely on their available sandbox and the pre-commit hook, which runs at commit time and can be bypassed by a human. Reviewer write restrictions vary by harness. See the [harness matrix](docs/HARNESS-MATRIX.md) before choosing a role setup.

## Repository context

Agent Flow uses `AGENTS.md` for shared agent instructions. Claude Code can load it through `CLAUDE.md` containing `@AGENTS.md`. Module-level `AGENTS.md` files add rules for that part of the repository. `CONTEXT_MANIFEST.json` records referenced paths, protected paths, risk boundaries and pipeline settings. The `agent-flow-gardener` skill checks and repairs this context; it re-reads the code before refreshing timestamps.

When an agent repeats a mistake, prefer a mechanical fix: an invariant in code, a test, a guard rule or a protected path. Prompts and prose are the least reliable enforcement.

## What leaves your machine

Agent Flow runs no service and has no telemetry, account or API key. It sends nothing to its author. The only traffic is what you start yourself, to services you already use:

| What | Where it goes | When |
|---|---|---|
| Role prompts and the repository content a role reads | The model provider of the agent CLI you run (Claude Code, Codex, Gemini, …), exactly as when you use that CLI directly | When you run the pipeline (`agent-flow run`, or a skill that launches a role) |
| Issue text, the branch, the pull request | GitHub, through your own logged-in `gh` | When you read an issue, or pass `--pr` or `--auto-merge` |
| A version-number request for this package | The npm registry (one GET, cached for 24 hours) | `doctor`, `update`, and `status` in an interactive terminal; skipped in CI and with `--offline` or `AGENT_FLOW_NO_UPDATE_CHECK=1` |
| A Code Owners setting read | GitHub, through your own `gh api` | `doctor`, skipped in CI and with `--offline` |

The guard, the pre-commit hook, `classify`, `audit-risk` and `gates` never touch the network. What Agent Flow writes stays in your repository: the audit log and artifacts under `.agent-flow/` (kept out of git through `.git/info/exclude`). It reads files in your checkout and commit hashes and subjects; it does not collect personal data, and it refuses to read `.env` files and `deny_read` paths. Details: [Security](SECURITY.md).

## Limits and security

- Risk classification and secret detection are heuristic; review their findings.
- Shell-write analysis is best-effort. Use a sandbox or remove shell access from read-only roles when a hard boundary is required.
- Per-tool enforcement is available on Claude Code and Pi. Other harnesses have different enforcement limits.
- Hooks do not access the network. `doctor` may make optional, cached read-only lookups for package updates and GitHub Code Owner settings; CI and offline modes skip them.
- Each issue gets its own git worktree. Measured on Windows with a synthetic 60,000-file repository: creating it took 16 seconds (git's checkout), Agent Flow's own commands each finished in about half a second or less, and the before-and-after check around QA added about 3 seconds in total. Very large monorepos should use git sparse-checkout or a partial clone; Agent Flow does not automate that.
- Critical changes are reviewed by a stronger model only if you set `pipeline.models.high_reasoning` (and `pipeline.models.fast` for the rest). Unset, every role uses the default model, and `status` and `run` say so.
- Audit logs are tamper-evident, not tamper-proof. Keep an audit hash outside the repository if you need an external trust anchor.

See [Security](SECURITY.md) and [known failure modes](FAILURE_MODES.md) for details. Agent Flow works one repository at a time and does not provide model-provider failover.

## FAQ

**Will agents get stuck waiting for me?** Only on protected paths and critical changes. Everything else, including CI list additions, carries on and reaches you as a draft.

**What if my harness has no hooks?** The skills and the pre-commit gate still apply; the guard's per-call blocking does not. The harness matrix says which is which.

**How do I remove it?** `agent-flow uninstall` previews, `--yes` applies. Files you edited are kept.

## Development

```bash
npm install
npm test
```

The test suite exercises real temporary Git repositories and supported installation targets. See [Contributing](CONTRIBUTING.md).

## License

MIT
