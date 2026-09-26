# The Trust Loop

> "The model wasn't the bottleneck. Context and process were."

Agent Flow's core thesis is that **trust is the bottleneck**, not model capability. The Trust Loop is the mechanism that builds, maintains, and compounds trust across agent sessions.

## The Problem

65% of enterprise AI agent failures trace to **context drift**—not model quality. 88% of AI agent projects fail to reach production. The failure is architectural: systems that don't retain feedback or improve from their own outcomes degrade over time.

The data-layer failure tier accounts for 55% of enterprise harness failures. Stale context produces **confident wrong answers with no exception thrown**.

## The Loop

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

## The Four Phases

### 1. Bootstrap (Trust Creation)

The `/bootstrap` command scans the repo and **proposes** tiered context files. Nothing is written autonomously. Every architectural assertion carries a confidence marker:

- `[HIGH CONFIDENCE]` — verified by reading code
- `[INFERRED]` — guessed from patterns
- `[NEEDS VERIFICATION]` — unknown, requires user input

The user confirms or corrects each claim. The output is a starting point the user owns, not a finished artifact they inherited.

### 2. Execution (Trust Consumption)

The pipeline runs:
```
Issue → Implementer → Reviewer → QA → PR
         (fast model)  (high-reasoning,  (fast model,
         xN worktrees   read-only,        verbatim failures)
         in parallel)   ≤2 rounds)
```

Each phase produces **trust signals**:
- Did the context files help or hinder?
- Did the Reviewer catch issues that QA missed?
- Did QA fail correctly, or produce false positives?
- How many rounds did the fix loop take?
- Did any agent attempt to violate its permission boundaries?

### 3. Maintenance (Trust Repair)

The **Gardener** agent runs periodically or on-demand:

- `/sync-context` — updates `DOCS_INDEX.md`, flags stale design docs
- `/audit-risk` — scans for new dependencies, auth code, data mutation paths
- `/doctor` — validates all context file manifests, flags stale paths
- `/repair-docs` — rebuilds affected context files after `[CONTEXT_STALE]` flag
- `/garden` — full cycle

### 4. Verification (Trust Feedback)

Every execution run produces signals that feed back into the bootstrap artifacts:
- If the Reviewer consistently catches a class of issue, the fix is not a better Reviewer prompt—it's a **lint rule** that makes the issue impossible.
- If the context files consistently mislead, the fix is not a better context file—it's a **CI check** that validates context claims against the codebase.

## The Hierarchy of Corrections

When an agent makes a mistake, fix it at the **highest leverage level first**:

1. **Codebase / Architecture** — make the mistake impossible
2. **Static Analysis** — linters, compiler diagnostics, CI
3. **Rules / Hooks** — pre-commit, pre-push
4. **Skills** — agent instructions
5. **Style Guide** — weakest, relies on human review, which doesn't scale

## The Gardener's Role

"Your team needs gardeners." Anti-patterns spread like a virus. One workaround copied everywhere within days. The Gardener:

1. **Immediately** writes a lint rule to stop the bleeding
2. Creates an issue to clean up existing instances
3. Adds the pattern to `Per-app_AGENT.md` as a local trap
4. Updates `Root_AGENT.md` if it's a global rule

## Integration with ctxlint

Agent Flow integrates with ctxlint in CI. ctxlint catches:
- `stale-file-ref` — file paths mentioned in context files that no longer exist
- `stale-command` — shell commands that are not available or have changed
- `no-directory-tree` — hardcoded directory tree dumps that go stale
- `token-waste` — redundant, padded, or low-signal content burning context window tokens

When ctxlint finds an issue, the context file is flagged `[STALE]` and the Gardener rebuilds it.

## What Makes This Different

| Other tools | Agent Flow |
|-------------|-----------|
| Task management | Trust loop |
| Pipeline execution | Bootstrap + execution + self-healing |
| Asset caching | Universal adaptation |
| Process frameworks | Self-bootstrapping systems |
| Runtime environments | Context bootstrappers |

No other project has a **self-healing** context system that repairs itself when it drifts.
