# Agent Flow

**Run your agents like a small team.**

[![CI](https://github.com/Drix10/agent-flow/actions/workflows/ci.yml/badge.svg)](https://github.com/Drix10/agent-flow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Agent Skills Standard](https://img.shields.io/badge/Agent%20Skills-Standard-blue)](https://agentskills.io)

A self-bootstrapping, self-healing agent engineering workflow for any repository.

Install it once. It scans your codebase, generates tiered context files, configures a rigorous Implement → Review → QA pipeline, and then **continuously repairs itself** when your codebase drifts.

## The Problem

65% of enterprise AI agent failures trace to **context drift**, not model capability. 88% of AI agent projects fail to reach production. The model isn't the bottleneck—context and process are.

## The Solution

This package gives your repository a **living engineering process**:

### 01 · Context in Tiers

```
Root_AGENT.md          → global rules + repo map (always loaded)
Per-app_AGENT.md       → local traps, per module (loaded per module)
DOCS_INDEX.md          → status, date, issue wins (~docs index)
Design docs + skills   → read on demand
Private memory         → your prefs + live state (not committed)
```

Each session reads just enough, then follows links for depth. Context files are **machine-verifiable** with manifests, last-verified timestamps, and staleness flags.

### 02 · Implement → Review → QA

```
Issue → Implementer → Reviewer → QA → PR
         (fast model)  (high-reasoning,  (fast model,
         xN worktrees   read-only,        verbatim failures)
         in parallel)   ≤2 rounds)
```

Separate agents, separate permissions. The Reviewer is instructed read-only — its skill declares no write tools — but this is convention, not a block: on Pi, `allowed-tools` is a pre-approval list, and a live test (FM-16) confirmed the Reviewer writes when directly asked. Real enforcement exists only on Claude Code via the Reviewer subagent's `tools` field (`.claude/agents/reviewer.md`). See `docs/HARNESS-MATRIX.md` for the per-harness enforcement table. Model matched to risk: mechanical edits run on fast models, money/contracts/auth always reviewed by high-reasoning models.

### 03 · Sessions File Themselves

The sidebar sorts every session by what it's waiting on:

- **Needs Me** — action required from a human
- **Working** — sub-agents implementing, PR open, waiting on CI
- **Completed** — worktrees removed, temp files cleaned, servers stopped

## Quick Start

```bash
# Install the package
pi install npm:@drix10/agent-flow

# Bootstrap your repository (interactive)
/bootstrap

# Or run the full pipeline on an issue
/implement 42

# Maintain the system
/sync-context
/audit-risk
/doctor
```

## Commands

| Command | What it does |
|---------|-------------|
| `/bootstrap` | Scans repo, proposes tiered context files, calibrates risk boundaries |
| `/implement <issue>` | Runs Implement → Review → QA → PR pipeline |
| `/sync-context` | Updates DOCS_INDEX, flags stale design docs |
| `/audit-risk` | Scans for new dependencies, auth code, data mutation paths |
| `/doctor` | Validates all context file manifests, flags stale paths |
| `/repair-docs` | Rebuilds affected context files after `[CONTEXT_STALE]` flag |
| `/garden` | Full maintenance cycle: sync + audit + repair |

## The Trust Loop

```
┌─────────────────────────────────────────────────────┐
│                   TRUST LOOP                        │
│                                                     │
│  Bootstrap ──→ Execution ──→ Maintenance            │
│      ↑                             │                │
│      │                             ↓                │
│      └────── Verification ←────────┘                │
│              (CI hooks,                             │
│               stale flags,                          │
│               risk audits)                          │
└─────────────────────────────────────────────────────┘
```

Every execution run produces **trust signals** (did context help or hurt? did the Reviewer catch real issues? did QA fail correctly?). Every maintenance cycle consumes those signals and improves the bootstrap artifacts.

## Hierarchy of Corrections

When an agent makes a mistake, fix it at the **highest leverage level first**:

1. **Codebase / Architecture** — make the mistake impossible
2. **Static Analysis** — linters, compiler diagnostics, CI
3. **Rules / Hooks** — pre-commit, pre-push
4. **Skills** — agent instructions
5. **Style Guide** — weakest, relies on human review

If the Implementer keeps modifying a protected kernel, the fix is not a better prompt—it's a **pre-commit hook that rejects the change**.

## Security

This package is designed to be auditable:

- Every file it generates is human-readable
- Every tool call it makes is logged
- The `/doctor` command validates deviations from expected behavior
- No telemetry, no network calls beyond your configured model provider

Agent skills introducing executable scripts are 2.12× more likely to contain vulnerabilities. This package bundles TypeScript extensions, not obfuscated scripts. Read the source before installing.

## Compatibility

Works with any Agent Skills–compatible harness:

- **Pi** — native, full enforcement
- **Claude Code** — copy `skills/` to `.claude/skills/`; Reviewer read-only enforced via subagent `tools` field
- **Codex / Gemini CLI / Cursor** — copy to the harness skills dir; skills only, enforcement is conventional

Enforcement differs per harness — Pi: full. Claude Code: Reviewer read-only enforced, state machine and risk audit advisory. Codex/Gemini/Cursor: skills only. Details in [docs/HARNESS-MATRIX.md](./docs/HARNESS-MATRIX.md).

See [README-COMPATIBILITY.md](./README-COMPATIBILITY.md) for per-harness install instructions.

## License

MIT
