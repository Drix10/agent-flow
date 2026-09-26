---
description: Run the Implement → Review → QA → PR pipeline on a GitHub issue
argument-hint: "<issue-number>"
---
Run the full agent pipeline for GitHub issue $1 by following the `invoking-agents` skill: classify risk, spawn Implementer → Reviewer → QA with fresh-context boundaries, enforce ≤2 review rounds, escalate to Needs Me on deadlock, and call `state_update` at every phase transition. Additional instructions: ${@:2}
