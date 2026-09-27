# Agent Flow

**Your agents trust the context you give them. Agent Flow makes sure it's still true.**

[![npm version](https://img.shields.io/npm/v/@drix10/agent-flow)](https://www.npmjs.com/package/@drix10/agent-flow)
[![CI](https://github.com/Drix10/agent-flow/actions/workflows/ci.yml/badge.svg)](https://github.com/Drix10/agent-flow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![runtime deps: 0](https://img.shields.io/badge/runtime%20deps-0-brightgreen)

Coding agents fail quietly. The model is usually fine. What goes wrong is everything around it:

- an `AGENTS.md` that still names a file renamed last quarter;
- a "reviewer" that is just the implementer in a different hat;
- a "read-only" rule that is only a sentence in a prompt;
- a new payment dependency nobody looked at.

Agent Flow is a small, auditable layer that catches these:

| | What it does | How it's enforced |
|---|---|---|
| 🩺 **Drift detection** | Checks every path your context files mention (manifest *and* the `backticked/paths` in the prose) against the real filesystem. Case-exact, so it works on Windows and macOS too. | `agent-flow doctor` in CI and in the pre-commit hook |
| 🛡️ **Guardrails** | Reviewer and QA can't write. Implementers can't leave their worktree. Nobody touches protected paths, `--no-verify`s, force-pushes, or pushes to `main`. | Pi `tool_call` hook blocks the call *before* it runs |
| ⚖️ **Mechanical risk** | Classifies the *actual diff* against your protected paths and risk boundaries → reviewer tier, draft PR, human gate. | `risk_classify` / `agent-flow classify` |
| 🔁 **Bounded review loop** | Implement → Review → QA as separate processes. Round 3 auto-escalates to **Needs Me** with a decision brief. | State machine rejects illegal transitions and rounds that go backwards |
| 🔎 **Risk audit** | Flags new dependencies, auth/payment code, destructive data ops, outbound calls, and secrets (values never printed) against a baseline. | `agent-flow audit-risk --fail-on-new` |

Zero runtime dependencies. No network calls. No telemetry. Every check is plain TypeScript you can read in an afternoon.

---

## 30 seconds

Someone renamed `src/users/service.ts`. Someone else added `stripe`. An agent edited a payments file.

```console
$ npx agent-flow doctor
✓ manifest schema
✓ context files exist
✗ referenced paths exist — 1
    AGENTS.md: src/users/service.ts (prose)
✓ timestamps valid
✓ verified within threshold

$ npx agent-flow audit-risk --fail-on-new
✗ 2 new risk surface(s):
    dependency    package.json  Dependency: stripe
    payment       package.json  Dependency: stripe

$ npx agent-flow classify
risk: critical  reviewer: high-reasoning  human approval: required  3 files vs main
  - critical: src/payments/charge.ts is under protected path src/payments/
  - medium: dependency manifest changed (package.json) — risk review required
✗ protected paths touched: src/payments/charge.ts
```

That is real output. Each check exits non-zero, so CI goes red before an agent builds on a false premise.

---

## Install

**Pi** gets the full set: skills, slash commands, tools, and the guard.

```bash
pi install npm:@drix10/agent-flow
```

**Claude Code, Codex, Gemini CLI, Cursor, Copilot** get the skills, a reviewer subagent, and the CLI.

```bash
npm install -D @drix10/agent-flow
npx agent-flow install --harness claude     # or codex | gemini | cursor | copilot | agents
```

`install` works on Windows, macOS and Linux. It never overwrites a skill you've edited.

**Everyone** should add the pre-commit gate and the CI checks:

```bash
npx agent-flow hook install                  # protected paths, secrets, broken context refs
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
      - run: npx agent-flow doctor
      - run: npx agent-flow audit-risk --fail-on-new
```

## Use

| Pi command | Outside Pi | What happens |
|---|---|---|
| `/bootstrap` | `npx agent-flow scan` + the `bootstrap` skill | Scans read-only and proposes `AGENTS.md` + `CONTEXT_MANIFEST.json`. Every claim carries `[HIGH CONFIDENCE]`, `[INFERRED]` or `[NEEDS VERIFICATION]`. Asks you for protected paths and risk boundaries. Writes each file only after you approve it. |
| `/implement 42` | the `invoking-agents` skill | Runs Implementer → classify → Reviewer → QA → PR, each as a separate process. See [the pipeline](#the-pipeline). |
| `/doctor` | `npx agent-flow doctor` | Drift report. Changes nothing. |
| `/repair-docs` | the `gardener` skill | Re-reads the code, fixes the prose, *then* refreshes the manifest. |
| `/audit-risk` | `npx agent-flow audit-risk` | New risk surfaces since the baseline. |
| `/sync-context` | the `gardener` skill | Updates `DOCS_INDEX.md` with stale, missing and archived docs. |
| `/garden` | — | All of the above, in order. |

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

- **Separate processes.** Each role is its own `pi -p` with its own `AGENT_FLOW_ROLE`. The Reviewer launches with `--tools read,grep,find,ls`, so it has no write, edit or shell tool at all.
- **Artifacts only.** Roles hand off `issue.md`, `diff.patch`, `classification.json`, `review-rN.json` and `qa-rN.json`. They never hand off reasoning.
- **Issue text is untrusted.** It is wrapped in `<untrusted_issue>`. Every skill tells the model to treat it as requirements, never instructions. The guard blocks role changes and nested agent launches from inside a role.
- **Critical changes** get a draft PR and a human. Low-risk changes can auto-merge only if you opt in (`pipeline.auto_merge_low_risk`).

## What is enforced, per harness

Being straight about this is the point of the project.

| | Pi | Claude Code | Codex | Gemini CLI | Cursor / Copilot |
|---|---|---|---|---|---|
| Reviewer can't write | ✅ `--tools` + guard | ✅ subagent `tools: Read, Grep, Glob` | ⚠️ `sandbox_mode = "read-only"` (verify) | ⚠️ tool list (verify) | ❌ instruction only |
| Protected paths | ✅ guard + hook | ✅ hook | ✅ hook | ✅ hook | ✅ hook |
| Round cap / transitions | ✅ `state_update` | ✅ `npx agent-flow state` | ✅ CLI | ✅ CLI | ✅ CLI |
| Drift + risk checks | ✅ tools + CLI | ✅ CLI | ✅ CLI | ✅ CLI | ✅ CLI |
| Shell writes by read-only roles | ⚠️ best-effort pattern block | n/a (no shell) | sandbox | — | — |

The ✅ cells in "Protected paths" come from the pre-commit hook. It runs at commit time, not at edit time, and a human can bypass it with `--no-verify`. The guard stops agents from doing that. Full details: [docs/HARNESS-MATRIX.md](./docs/HARNESS-MATRIX.md).

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

- **Shell analysis is best-effort.** Pattern matching can't catch every way to write a file through an interpreter. For a hard guarantee, launch read-only roles without a shell (`--tools read,grep,find,ls`) or in a container.
- **The risk audit is heuristic.** It gives you leads to review, not verdicts. It is tuned to rarely false-alarm, so it will miss things.
- **The Pi guard and tools only exist in Pi.** Other harnesses get the same logic through the CLI and hook, which work at commit time rather than per tool call. Real cross-harness enforcement at tool-call time needs an MCP server ([ROADMAP](./ROADMAP.md)).
- **One repo at a time** (FM-13). There is no model-provider fallback yet (FM-15).

All known failure modes, including the ones we found in our own code, are listed in [FAILURE_MODES.md](./FAILURE_MODES.md). If you find one that isn't there, [open an issue](https://github.com/Drix10/agent-flow/issues). Each confirmed one becomes a test.

## Security

- **Zero runtime dependencies.** Only `node:` built-ins, so there is less supply chain to trust.
- **No network.** ctxlint runs only if it's already installed locally. v1.0.x used `npx`, which could download code; that is fixed.
- **Every git call uses an argv array.** No shell strings.
- **Every write stays inside the repo.** No `..`, no absolute paths, no escaping through symlinks.
- **Human confirmation is real.** Pi shows a dialog that only a human can click. Headless writes need `AGENT_FLOW_HEADLESS_WRITES=1`, set by whoever launches the process.
- **Guard blocks and state transitions are logged** to `.agent-flow/audit.jsonl`. Agents can't edit that file directly.

See [SECURITY.md](./SECURITY.md) to audit these claims yourself.

## Contributing

`npm install && npm test` runs 60+ tests against real git repos in temp directories, on Linux, macOS and Windows in CI. Read [CONTRIBUTING.md](./CONTRIBUTING.md), then pick a failure mode.

## License

MIT
