---
name: invoking-agents
description: Orchestration layer for agent-team-workflow. Chains Implementer → Reviewer → QA with fresh-context boundaries, enforces the ≤2 rounds constraint, and escalates to Needs Me when deadlocked. Use when running the full pipeline on an issue.
allowed-tools: read bash grep find ls
---

# Invoking Agents Skill

You are the Orchestrator. You chain agents. You enforce constraints. You escalate when needed.

**Critical constraints:**
- Each agent runs in a **fresh context**—no conversation history carries over
- Only **artifacts** pass between agents (diff, review, test results)
- The **≤2 rounds** constraint is enforced mechanically
- **Model-capability requirements** are enforced per phase

---

## Pipeline

```
Issue → Implementer → Reviewer → QA → PR
         (fast model)  (high-reasoning,  (fast model,
         xN worktrees   read-only,        verbatim failures)
         in parallel)   ≤2 rounds)
```

---

## Fresh-Context Boundaries

**This is the most important constraint.** Context rot from conversation history compression is a known failure mode. The failure is in architecture, not information availability.

Each phase starts with a **fresh context window**:

| Phase | Context | Why |
|-------|---------|-----|
| Implementer | `Root_AGENT.md` + `Per-app_AGENT.md` + issue | Fresh start |
| Reviewer | Diff only | No builder bias |
| QA | Diff + test commands | No reviewer bias |
| PR | All artifacts | Final assembly |

**No agent sees another agent's reasoning.** Only artifacts pass between phases.

---

## Pipeline Steps

### Step 1: Classify Issue

Determine risk level mechanically (based on diff properties, not agent self-report):

```javascript
function classifyRisk(filesChanged, protectedPaths) {
  if (filesChanged.some(f => protectedPaths.includes(f))) return "critical";
  if (filesChanged.some(f => f.includes("auth") || f.includes("payment"))) return "critical";
  if (filesChanged.some(f => f.includes("core") || f.includes("kernel"))) return "medium";
  return "low";
}
```

### Step 2: Spawn Implementer

```bash
pi run /implement {issue} --model {fast_model}
```

Wait for completion. Receive artifact: `{ status, branch, worktree, diff_path, ... }`

### Step 3: Spawn Reviewer

```bash
pi run /review {diff_path} --model {high_reasoning_model}
```

Wait for completion. Receive artifact: `{ status, findings, ... }`

**If `status == "approved"`:** proceed to QA.
**If `status == "request_changes"`:** proceed to fix loop.

### Step 4: Fix Loop (≤2 rounds)

```javascript
let round = 0;
const maxRounds = 2;

while (round < maxRounds) {
  // Spawn Implementer to fix
  const fixResult = await spawnImplementer(issue, reviewFindings);

  // Spawn Reviewer to re-review
  const reviewResult = await spawnReviewer(fixResult.diff);

  if (reviewResult.status === "approved") break;

  round++;
  if (round >= maxRounds) {
    // Escalate to Needs Me
    await escalateToNeedsMe(issue, reviewResult, fixResult);
    return;
  }
}
```

### Step 5: Spawn QA

```bash
pi run /qa {branch} --model {fast_model}
```

Wait for completion. Receive artifact: `{ status, failures, ... }`

**If `status == "passed"`:** proceed to PR.
**If `status == "failed"`:** return to Implementer for fix (counts toward round limit).

### Step 6: Open PR

```bash
git push origin agent/issue-{number}
gh pr create --base develop --title "agent: issue #{number}" --body "Closes #{number}"
```

Update state machine: `Working` → `Completed`.

---

## State Machine

| State | Meaning | Transitions |
|-------|---------|-------------|
| `Needs Me` | Human action required | → `Working` (human resolves) |
| `Working` | Agent pipeline running | → `Completed` (success) or `Needs Me` (escalation) |
| `Completed` | PR opened, worktree cleaned | Terminal |

### State File

```json
{
  "sessions": [
    {
      "issue": 42,
      "state": "Working",
      "phase": "reviewer",
      "round": 1,
      "started_at": "2026-09-27T10:00:00Z",
      "worktree": ".worktrees/issue-42"
    }
  ]
}
```

---

## Escalation

Escalate to `Needs Me` when:

- **Max rounds exceeded** (2 rounds of review without approval)
- **Max fix attempts exceeded** (3 test failures)
- **Architectural issue** (ARCH_ERROR classification)
- **Permission violation** (attempted write to protected path)
- **Cannot satisfy acceptance criteria** (Implementer reports impossible)

Escalation format:

```json
{
  "status": "needs_me",
  "issue": 42,
  "reason": "max_rounds_exceeded",
  "what_reviewer_objected_to": "...",
  "what_implementer_tried": "...",
  "disagreement": "...",
  "suggested_action": "..."
}
```

---

## Cleanup

After PR is opened:

```bash
git worktree remove .worktrees/issue-{number}
git branch -d agent/issue-{number}
```

Update state machine: `Completed`.

Clean up temp files, stop any dev servers started during testing.

---

## Parallel Execution

For multiple issues:

```bash
# Spawn N implementers in parallel, each in its own worktree
for issue in 42 43 44; do
  pi run /implement $issue &
done
wait
```

Each worktree is isolated. No conflicts.

---

## Model-Capability Enforcement

| Phase | Model Tier | Why |
|-------|-----------|-----|
| Implementer | Fast | Implementation can grind |
| Reviewer | High-reasoning | Review is where you need smarts |
| QA | Fast | Mechanical |
| Gardener | High-reasoning | Judgment tasks |

The Orchestrator enforces the correct model per phase. It never lets a fast model do a high-reasoning job.
