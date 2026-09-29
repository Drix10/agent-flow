<div align="center">

# Agent Flow

**Your agents trust the context you give them. Agent Flow makes sure it's still true.**

*Context-drift detection, guardrails & an Implement → Review → QA pipeline for AI coding agents — Claude Code, Codex CLI, Gemini CLI, Cursor, Copilot, Windsurf and any tool that reads `AGENTS.md`.*

[![npm version](https://img.shields.io/npm/v/@drix10/agent-flow?style=flat-square&logo=npm)](https://www.npmjs.com/package/@drix10/agent-flow)
[![npm downloads](https://img.shields.io/npm/dm/@drix10/agent-flow?style=flat-square&logo=npm&label=downloads)](https://www.npmjs.com/package/@drix10/agent-flow)
[![CI](https://img.shields.io/github/actions/workflow/status/Drix10/agent-flow/ci.yml?branch=main&style=flat-square&logo=github&label=CI)](https://github.com/Drix10/agent-flow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](./LICENSE)
[![Node](https://img.shields.io/node/v/@drix10/agent-flow?style=flat-square&logo=node.js&logoColor=white&label=node)](https://nodejs.org/)
![runtime deps: 0](https://img.shields.io/badge/runtime%20deps-0-brightgreen?style=flat-square)

<video src="https://github.com/user-attachments/assets/3acb0531-93c1-4770-a5e9-d26491bfe4c4" width="100%" autoplay loop muted playsinline>Agent Flow demo video: an AI coding agent runs the Implement → Review → QA pipeline, catching context drift and risky diffs.</video>

</div>

**Agent Flow** is a zero-runtime-dependency CLI plus skills layer for **AI coding agents** — **Claude Code, Codex CLI, Gemini CLI, Cursor, GitHub Copilot, Windsurf**, and anything that reads **`AGENTS.md`** — that keeps context files honest, gates risky diffs, and runs Implement → Review → QA as separate, enforceable processes.

Coding agents fail quietly. The model is usually fine. What goes wrong is everything around it:

- an `AGENTS.md` that still names a file renamed last quarter;
- a "reviewer" that is just the implementer in a different hat;
- a "read-only" rule that is only a sentence in a prompt;
- a new payment dependency nobody looked at.

Agent Flow is a small, auditable layer that catches these:

| | What it does | How it's enforced |
|---|---|---|
| 🩺 **Drift detection** | Checks every path your context files mention (manifest *and* the `backticked/paths` in the prose) against the real filesystem. Case-exact, so it works on Windows and macOS too. | `agent-flow doctor` in CI and in the pre-commit hook |
| 🛡️ **Guardrails** | Reviewer and QA can't write. Implementers stay in their worktree (file tools enforced; shell best-effort). No agent session — pipeline role or not — skips hooks, force-pushes, or pushes to `main`; nobody writes, deletes or moves protected paths (directories included) or reads env files and `deny_read` paths. | Claude Code subagent tool restrictions and the `agent-flow guard` `PreToolUse` hook, Codex read-only sandbox, or (on Pi) the `tool_call` hook — plus the pre-commit hook everywhere. See [per-harness table](#what-is-enforced-per-harness). |
| ⚖️ **Mechanical risk** | Classifies the *actual diff* against your protected paths and risk boundaries → reviewer tier, draft PR, human gate. | `risk_classify` / `agent-flow classify` |
| 🔁 **Bounded review loop** | Implement → Review → QA as separate processes. Round 3 auto-escalates to **Needs Me** with a decision brief. | State machine rejects illegal transitions and rounds that go backwards |
| 🔎 **Risk audit** | Flags new dependencies, auth/payment code, destructive data ops, outbound calls, and secrets (values never printed) against a baseline. | `agent-flow audit-risk --fail-on-new` |
| 🚦 **Gates and policy** | Tests and lint the *orchestrator* runs (exit code, log and hash recorded, not a model's summary), plus repo rules: size caps, forbidden added lines, source-needs-tests. | `agent-flow gates run`, `classify --fail-on-policy`, pre-commit |
| 🧾 **Audit trail** | Every guard block, transition and gate run is a line in a hash chain; editing or deleting one is detectable. | `agent-flow audit verify` / `summary` |

Zero runtime dependencies. No network calls. No telemetry. Every check is plain TypeScript you can read in an afternoon.

---

## 30 seconds

Someone renamed `src/users/service.ts`. Nobody told `AGENTS.md`. No setup, no config — run it in any repo:

```console
$ npx @drix10/agent-flow doctor
✓ context files found: AGENTS.md
✗ referenced paths exist — 1
    AGENTS.md:3  src/users/service.ts  → did you mean src/users/user-service.ts?
✓ no unfilled placeholders
```

Then an agent adds `stripe` and edits a payments file on a branch:

```console
$ npx @drix10/agent-flow audit-risk --fail-on-new
✗ 2 new risk surface(s):
    payment       package.json  stripe
    dependency    package.json  stripe

$ npx @drix10/agent-flow classify
risk: critical  reviewer: high-reasoning  human approval: required  4 files vs main
  - critical: src/payments/charge.ts is under protected path src/payments/
  - medium: dependency manifest changed (package.json) — risk review required
✗ protected paths touched: src/payments/charge.ts
```

That is real output (trimmed). `doctor` reads every AGENTS.md, CLAUDE.md, GEMINI.md, `.cursorrules`, Copilot and Windsurf rules file it finds; `agent-flow init` adds a manifest for staleness tracking. Each check exits non-zero, so CI goes red before an agent builds on a false premise.

---

## Install

**Claude Code, Codex CLI, Gemini CLI, Cursor, Copilot, Windsurf** — the primary targets — get the skills, a read-only reviewer subagent (where the harness has one), and the zero-dependency CLI:

```bash
npm install -D @drix10/agent-flow
npx @drix10/agent-flow install --harness claude     # or codex | gemini | cursor | copilot | windsurf | agents

# — or just the skills, via the skills CLI:
npx skills add Drix10/agent-flow
```

Any other tool that reads [AGENTS.md](https://agents.md) — Aider, Zed, Warp, JetBrains Junie, RooCode, Amp, opencode, goose, and more — already gets drift detection and risk classification from the CLI with no install step at all; `--harness agents` just adds a conventional `.agents/skills/` folder on top.

`install` works on Windows, macOS and Linux, is idempotent, and never overwrites a skill you've edited (`--force` to override). Every command it needs — `doctor`, `audit-risk`, `classify`, `state`, `worktree` — ships in the CLI, so nothing here depends on a harness-specific extension API.

**Pi** additionally gets tool-level enforcement, because Pi exposes a `tool_call` hook the others don't:

```bash
pi install npm:@drix10/agent-flow
```

**Everyone** should add the pre-commit gate and the CI checks. In a non-Node repo (Python, Go, Rust…), install the CLI once with `npm i -g @drix10/agent-flow`; the hook finds it there.

```bash
npx @drix10/agent-flow hook install                  # protected paths, secrets, broken context refs
```

```yaml
# .github/workflows/agent-context.yml
name: agent-context
on: [push, pull_request]
jobs:
  context:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npx @drix10/agent-flow doctor
      # needs a committed .risk-baseline.json: review `audit-risk` once, then
      # `npx @drix10/agent-flow baseline accept --all --yes` and commit it
      - run: npx @drix10/agent-flow audit-risk --fail-on-new
```

Or use the composite action, which also runs `classify --fail-on-protected --fail-on-policy` on pull requests and can upload SARIF to code scanning:

```yaml
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: Drix10/agent-flow@v1.1.3
```

## Use

On Claude Code, Codex, Gemini CLI, Cursor and Copilot, these run as skills the agent invokes by name (or you ask for by task — "bootstrap this repo", "implement issue 42") plus the CLI commands the skill shells out to. Pi additionally wires them up as slash commands.

| Skill / CLI | Pi shortcut | What happens |
|---|---|---|
| `bootstrap` skill + `npx @drix10/agent-flow scan` | `/bootstrap` | Scans read-only and proposes `AGENTS.md` + `CONTEXT_MANIFEST.json`. Every claim carries `[HIGH CONFIDENCE]`, `[INFERRED]` or `[NEEDS VERIFICATION]`. Asks you for protected paths and risk boundaries. Writes each file only after you approve it. |
| `invoking-agents` skill | `/implement 42` | Runs Implementer → classify → Reviewer → QA → PR, each as a separate process. See [the pipeline](#the-pipeline). |
| `npx @drix10/agent-flow doctor` | `/doctor` | Drift report. Changes nothing. |
| `gardener` skill | `/repair-docs` | Re-reads the code, fixes the prose, *then* refreshes the manifest. |
| `npx @drix10/agent-flow audit-risk` | `/audit-risk` | New risk surfaces since the baseline. |
| `gardener` skill | `/sync-context` | Updates `DOCS_INDEX.md` with stale, missing and archived docs. |
| all of the above, in order | `/garden` | Full maintenance pass. |

The pipeline state lives in `AGENT_STATE.md`, sorted into **🔴 Needs Me**, **🔵 Working** and **🟢 Completed**.

---

## The pipeline

```
issue ─▶ worktree ─▶ Implementer ─▶ classify ─▶ Reviewer ─▶ QA ─▶ PR
          .worktrees/  fast model     real diff    high-reasoning  fast   draft if critical
          issue-N      confined to    vs manifest  no write,       re-runs
                       its worktree                no shell        flakes once
                            ▲                          │
                            └──── ≤ 2 rounds ──────────┘──▶ round 3 = 🔴 Needs Me
```

- **Separate processes.** Each role is its own process with its own `AGENT_FLOW_ROLE` — `claude -p` on Claude Code, `codex exec` on Codex CLI, `pi -p` on Pi. The Reviewer launches read-only: the `reviewer` subagent on Claude Code, `codex exec --sandbox read-only` on Codex, `--tools read,grep,find,ls` on Pi. See [skills/invoking-agents/SKILL.md](./skills/invoking-agents/SKILL.md) for the exact command on each.
- **Artifacts only.** Roles hand off `issue.md`, `diff.patch`, `classification.json`, `review-rN.json` and `qa-rN.json`. They never hand off reasoning.
- **Issue text is untrusted.** It is wrapped in `<untrusted_issue>`. Every skill tells the model to treat it as requirements, never instructions. The guard blocks role changes and nested agent launches from inside a role.
- **Critical changes** get a draft PR and a human. Low-risk changes can auto-merge only if you opt in (`pipeline.auto_merge_low_risk`).

## What is enforced, per harness

Being straight about this is the point of the project.

| | Claude Code | Codex CLI | Gemini CLI | Cursor / Copilot / Windsurf | Pi |
|---|---|---|---|---|---|
| Reviewer can't write | ✅ subagent `tools: Read, Grep, Glob` | ✅ `codex exec --sandbox read-only` | ⚠️ tool list (verify) | ❌ instruction only | ✅ `--tools` + guard |
| Protected paths | ✅ `guard` hook (per call) + pre-commit | ✅ pre-commit | ✅ pre-commit | ✅ pre-commit | ✅ guard (per call) + pre-commit |
| Round cap / transitions | ✅ `npx @drix10/agent-flow state` | ✅ CLI | ✅ CLI | ✅ CLI | ✅ `state_update` |
| Drift + risk checks | ✅ CLI | ✅ CLI | ✅ CLI | ✅ CLI | ✅ tools + CLI |
| Shell writes by read-only roles | n/a (no shell) | sandbox | — | — | ⚠️ best-effort pattern block |

On Claude Code and Pi the guard blocks the write itself. Everywhere else the ✅ in "Protected paths" is the pre-commit hook, which runs at commit time, not at edit time, and a human can bypass it with `--no-verify`. The guard stops agents from doing that. Full details, plus every other [AGENTS.md](https://agents.md)-reading tool the CLI already works with unmodified (Aider, Zed, Warp, JetBrains Junie, RooCode, and more): [docs/HARNESS-MATRIX.md](./docs/HARNESS-MATRIX.md).

**What `allowed-tools` in a SKILL.md does:** nothing, as far as enforcement goes. We tested it (FM-16): a Reviewer skill without `write` in `allowed-tools` still wrote a file when asked. That result is why the guard exists.

---

## Context that stays true

Agent Flow writes **`AGENTS.md`**, the file Pi, Codex, Cursor, Copilot and most agents already load. Claude Code picks it up through a one-line `CLAUDE.md` (`@AGENTS.md`). One source of truth for every harness.

```
AGENTS.md                 always loaded · purpose, commands, paved paths, local traps (<150 lines)
<module>/AGENTS.md        loaded in that module · only what differs from the root
DOCS_INDEX.md             which design docs exist, which are stale
CONTEXT_MANIFEST.json     every referenced path + last_verified · protected_paths · risk_boundaries
```

Drift gets caught three ways:

- **Mechanically**, by `doctor` in CI and the pre-commit hook.
- **In review**, where the Reviewer flags claims the diff made false. These are `[CONTEXT_STALE]` flags, and they don't block the PR.
- **By the Gardener**, which fixes the prose *before* it refreshes a timestamp. A timestamp refreshed without re-reading the code turns stale context into "fresh" context, and that is the failure this project exists to prevent.

## Fix mistakes where they'll stay fixed

When an agent makes the same mistake twice, fix it at the highest level you can:

1. **Architecture**: make the mistake impossible.
2. **Static analysis**: a lint rule or a type.
3. **Hooks and guard**: add it to `protected_paths`, or add a pre-commit check.
4. **Skills and context**: a local trap in the module's `AGENTS.md`.
5. **Style guide**: the weakest fix, because it depends on someone remembering it.

If the Implementer keeps editing your migrations, a better prompt won't stop it. Add `**/migrations/**` to `protected_paths`, and the guard and the hook will.

---

## Honest limits

- **Shell analysis is best-effort**, on the harnesses that only offer pattern-matched shell checks. Pattern matching can't catch every way to write a file through an interpreter. For a hard guarantee, launch read-only roles without a shell tool at all: Claude Code's subagent `tools:` list, Codex's `--sandbox read-only`, Pi's `--tools read,grep,find,ls`, or any of them inside a container.
- **The risk audit is heuristic.** It gives you leads to review, not verdicts. It is tuned to rarely false-alarm, so it will miss things.
- **Tool-call enforcement exists on Pi and Claude Code only** (Pi's `tool_call` hook, Claude Code's `PreToolUse` hook via `agent-flow guard`). Codex, Gemini, Cursor, Copilot and Windsurf get the same logic through the CLI and the pre-commit hook, which act at commit time rather than per tool call.
- **One repo at a time** (FM-13). There is no model-provider fallback yet (FM-15).

All known failure modes, including the ones we found in our own code, are listed in [FAILURE_MODES.md](./FAILURE_MODES.md). If you find one that isn't there, [open an issue](https://github.com/Drix10/agent-flow/issues). Each confirmed one becomes a test.

## Security

- **Zero runtime dependencies.** Only `node:` built-ins, so there is less supply chain to trust.
- **No network.** ctxlint runs only if it's already installed locally. v1.0.x used `npx`, which could download code; that is fixed.
- **Every git call uses an argv array.** No shell strings.
- **Every write stays inside the repo.** No `..`, no absolute paths, no escaping through symlinks.
- **Human confirmation is real.** Pi shows a dialog that only a human can click. Headless writes need `AGENT_FLOW_HEADLESS_WRITES=1`, set by whoever launches the process.
- **Guard blocks and state transitions are logged** to `.agent-flow/audit.jsonl`. Agents can't edit that file directly.

See [SECURITY.md](./SECURITY.md) to audit these claims yourself. Adding it to a repo that already has rules, a task file and frozen paths: [docs/ADOPTION.md](./docs/ADOPTION.md).

## Contributing

`npm install && npm test` runs the suite against real git repos in temp directories, on Linux, macOS and Windows in CI, covering every `install --harness` target. Read [CONTRIBUTING.md](./CONTRIBUTING.md), then pick a failure mode.

## License

MIT
