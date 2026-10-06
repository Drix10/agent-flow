# The Trust Loop

> "The model wasn't the bottleneck. Context and process were."

Agent Flow's core thesis is that **trust is the bottleneck**, not model capability. The Trust Loop is the mechanism that builds, maintains, and compounds trust across agent sessions.

## The Problem

Agent failures in real repositories rarely look like "the model couldn't reason". More often it's:
- the context named a path that moved;
- the reviewer was the implementer in another hat;
- a rule existed only as a sentence in a prompt.

Stale context is especially bad because it produces **confident wrong answers with no exception thrown**.

A system that doesn't feed its own outcomes back into its inputs degrades. The Trust Loop is that feedback path.

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

The `/agent-flow-bootstrap` command scans the repo and **proposes** `AGENTS.md` (root and per module) plus `CONTEXT_MANIFEST.json`. Each file is written only after a human approves it: Pi shows a confirmation dialog, and other harnesses use their own permission prompt. Every architectural assertion carries a confidence marker:

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

Each phase leaves **trust signals** on disk:
- `.agent-state.json`: per-issue state, review round and transition history (how many rounds the fix loop took, why an issue escalated);
- `.agent-flow/audit.jsonl`: guard blocks (which role tried to cross which boundary), confirmations, state transitions, and one line per role run with its exit code, duration, cost and whether its report validated;
- the role reports under `.agent-flow/artifacts/issue-N/` (what the Reviewer caught, what QA reproduced).

Reading them is how you answer the questions that matter: did the Reviewer catch what QA missed, did QA fail for a real reason, did any agent push against its permission boundaries.

### 3. Maintenance (Trust Repair)

The **Gardener** agent runs periodically or on-demand:

- `/sync-context` — updates `DOCS_INDEX.md`, flags stale design docs
- `/audit-risk` — scans for new dependencies, auth code, data mutation paths
- `/doctor` — validates all context file manifests, flags stale paths
- `/repair-docs` — re-verifies flagged claims against the code, fixes the prose, *then* refreshes manifest timestamps
- `/garden` — full cycle

### 4. Verification (Trust Feedback)

The signals above are meant to change the bootstrap artifacts, and today a person or the Gardener does that reading (a command that summarizes `audit.jsonl` is on the [ROADMAP](./ROADMAP.md)):
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

1. Opens an issue for a lint rule or hook that stops new instances. The Gardener edits docs, not code, and the guard enforces that.
2. Opens an issue to clean up existing instances
3. Adds the pattern to the module's `AGENTS.md` as a local trap
4. Updates the root `AGENTS.md` if it's a global rule

## Mechanical checks

`agent-flow doctor` (CI and `/doctor`; the pre-commit hook runs `check-staged`, which applies the same checks to what a commit introduces) catches:
- manifest references that no longer exist, case-exact;
- `backticked/paths` in the context prose that no longer exist;
- context files that were deleted;
- invalid or placeholder timestamps and unfilled `{{TEMPLATE}}` markers;
- references not re-verified within `staleness_threshold_days`.

If [ctxlint](https://www.npmjs.com/package/ctxlint) is installed locally, `--ctxlint` adds its dead-command and token-waste checks. It is never downloaded on demand.

## How this differs from task runners and frameworks

| Typical tool | Agent Flow |
|---|---|
| Queues tasks | Also verifies that the context those tasks rely on is still true |
| Asks the model to follow rules | Blocks the tool call where the harness allows it, and says plainly where it can't |
| Reviewer is a prompt | Reviewer is a separate process with no write tools |
| "Max 2 retries" in a prompt | The state machine refuses round 3 and escalates |
