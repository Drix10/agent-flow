# Failure Modes

This document is the transparency foundation of the project. It lists every known failure mode, how we address it, and what remains open.

**Philosophy:** Projects that hit 100k stars are transparent about what doesn't work. This document turns users into contributors who add their own failure modes.

---

## FM-01: Bootstrap Hallucination

**What happens:** The bootstrap agent scans a codebase and generates context files with plausible-sounding but incorrect architectural claims.

**Why it matters:** Research shows comprehensive AGENTS.md files can hurt coding agent performance when they contain inaccurate information. Agents fail on implementation skill, not missing repository knowledge.

**Fix:**
- Bootstrap is **interactive and verification-gated**
- Every architectural assertion carries a confidence marker: `[HIGH CONFIDENCE]` (verified by reading code), `[INFERRED]` (guessed), `[NEEDS VERIFICATION]` (unknown)
- User must explicitly confirm each claim before it is written
- No file is written autonomously

**Status:** Addressed in `skills/bootstrap/SKILL.md`

---

## FM-02: Stale Context Death Spiral

**What happens:** Context files reference file paths that no longer exist after refactoring. The agent looks in the wrong place and hallucinates.

**Why it matters:** This is the data-layer failure tier—55% of enterprise harness failures. Stale context produces confident wrong answers with no exception thrown.

**Fix:**
- Every context file has a **machine-readable manifest** with referenced paths and a last-verified timestamp
- `ctxlint` runs in CI to catch stale references, dead commands, directory tree dumps, and token waste
- When a referenced path breaks, the context file is flagged `[STALE]`
- `/doctor` and `/sync-context` rebuild affected files
- Pre-commit hook rejects commits that break references

**Status:** Addressed in `extensions/stale-detector.ts`, `templates/CONTEXT_MANIFEST.json.template`

---

## FM-03: Permission Escalation

**What happens:** The Implementer modifies protected code (e.g., a financial kernel) because "it's just a small change." The Reviewer writes code instead of just reviewing.

**Why it matters:** Prompt-level constraints are not enforced constraints. 11.8% of agent skills have privilege escalation vulnerabilities.

**Fix:**
- Permissions enforced at the **harness level**, not the prompt level
- Implementer's worktree is sandboxed with write access only to its branch
- Reviewer's tool set physically excludes `write` and `edit`
- QA has `bash` for tests but no `write` access to source
- Protected paths are read-only in the Implementer's sandbox
- Pre-commit hook rejects changes to protected paths

**Status:** Addressed in `extensions/worktree.ts`, `skills/reviewer/SKILL.md`

---

## FM-04: ≤2 Rounds Deadlock

**What happens:** The Implementer genuinely cannot fix an issue after two rounds. Or the Reviewer is wrong and the Implementer is right. The loop stalls.

**Why it matters:** Unbounded fix-break retry loops are a known failure mode in multi-agent systems.

**Fix:**
- After round 2, issue escalates to **"Needs Me"** state
- Structured summary provided: what the Reviewer objected to, what the Implementer tried, what the disagreement is about
- Human resolves with additional context neither agent had
- Error taxonomy with category-specific bounds: `SPEC_ERROR` (1 round), `IMPL_ERROR` (2 rounds), `REVIEW_ERROR` (1 round), `ARCH_ERROR` (0 rounds—escalate immediately)

**Status:** Addressed in `skills/invoking-agents/SKILL.md`

---

## FM-05: Risk Boundary Erosion

**What happens:** A repo starts as a CLI tool and grows a payment integration. The skill's risk configuration doesn't adapt. New risk surfaces go unreviewed.

**Why it matters:** Risk boundaries are not static. A stale risk configuration is a security hole.

**Fix:**
- `/audit-risk` runs periodically or on-demand
- Scans for new dependencies, external API calls, authentication code, and data mutation paths
- Proposes risk configuration updates when new surfaces detected
- CI check flags when new dependencies are added without risk review

**Status:** Addressed in `skills/gardener/SKILL.md`

---

## FM-06: Framework Inheritance Problem

**What happens:** The skill ships with fixed templates. Users either accept defaults (and hit walls) or spend hours customizing (and wonder why they didn't write their own).

**Why it matters:** Heavyweight frameworks fail because they impose process rather than bootstrap it.

**Fix:**
- The skill is a **conversation, not a configuration**
- Defaults come with explanations
- "Here's what I'd put in your Root_AGENT.md based on what I found. Here's why. Change anything that doesn't match your reality."
- Output is always a starting point the user owns, never a finished artifact they inherited

**Status:** Addressed in `skills/bootstrap/SKILL.md`

---

## FM-07: Security Vulnerabilities

**What happens:** Agent skills contain vulnerabilities including data leaks and permission escalation.

**Why it matters:** 26.1% of skills contain at least one vulnerability. 76 contained confirmed malicious payloads—deliberate credential theft, reverse shells, and data exfiltration.

**Fix:**
- Every file is human-readable
- Every tool call is logged
- `/doctor` validates deviations from expected behavior
- No obfuscated scripts
- TypeScript extensions are auditable
- CI runs security scan on all skill files

**Status:** Addressed in `extensions/*.ts`, CI pipeline

---

## FM-08: Builder-Auditor Conflation

**What happens:** The same agent builds and reviews its own work. Self-assessment bias causes the Reviewer to approve its own code.

**Why it matters:** Systematic self-assessment bias in code review classification is a known failure mode.

**Fix:**
- Reviewer is a **separate agent with fresh context**
- Reviewer runs on a different (higher-reasoning) model than the Implementer
- Reviewer's tool set excludes write and edit
- Reviewer sees only the diff, not the Implementer's reasoning
- Review tier classification is **mechanical** (based on diff properties, not agent self-report)

**Status:** Addressed in `skills/reviewer/SKILL.md`, `extensions/state-machine.ts`

---

## FM-09: Context Rot from Conversation History

**What happens:** Long-horizon agent performance degrades when a task is embedded in a longer interaction history, even while the required information remains inside the context window.

**Why it matters:** The failure is in architecture, not information availability. Context rot from conversation history compression is a known failure mode.

**Fix:**
- Workflow phases enforce **fresh-context boundaries** so degradation cannot propagate across roles
- Each agent role starts with a fresh context window
- Only the artifacts (diff, review, test results) pass between phases
- No conversation history carries over

**Status:** Addressed in `skills/invoking-agents/SKILL.md`

---

## FM-10: Model-Capability Mismatch

**What happens:** Implementation-optimized models perform judgment tasks (review, risk assessment) poorly. Fast models miss subtle issues in high-risk code.

**Why it matters:** Model-capability mismatch is a known failure mode. Implementation-optimized models should not perform judgment tasks.

**Fix:**
- Mechanical edits run on fast models (Sonnet-tier)
- Money, contracts, auth always reviewed by high-reasoning models (Opus-tier)
- Model requirements are **enforced per workflow phase**
- Risk classification is mechanical, not agent-reported

**Status:** Addressed in `skills/bootstrap/SKILL.md` (calibration), `skills/reviewer/SKILL.md`

---

## FM-11: Anti-Pattern Virus

**What happens:** One workaround copied everywhere within days. Agents extend whatever patterns they see.

**Why it matters:** "The codebase is the strongest form of long-term memory." Anti-patterns spread like a virus.

**Fix:**
- When a bad pattern is found, write a **lint rule immediately** to stop the bleeding, then clean it up
- Hierarchy of corrections: architecture → static analysis → rules → skills → style guide
- `/garden` command runs periodic cleanup
- CI flags new instances of known anti-patterns

**Status:** Addressed in `skills/gardener/SKILL.md`

---

## FM-12: The Human Bottleneck

**What happens:** Agents run in parallel, but everything waits on human approval. The human becomes the bottleneck.

**Why it matters:** Lauren Tan's talk: "The hardest phase is escaping 1–5 agents → higher scale."

**Fix:**
- "Needs Me" state is **rare**—only for genuine disagreements, not routine approvals
- Low-risk changes (docs, tests, mechanical edits) auto-merge after QA
- Only high-risk changes (money, auth, contracts) require human review
- Trust is built incrementally: start with more human gates, remove them as trust signals accumulate

**Status:** Addressed in `extensions/state-machine.ts`, `skills/invoking-agents/SKILL.md`

---

## Open Issues

The following failure modes are known but not yet fully addressed:

- **FM-13: Multi-repo coordination.** The skill currently works on a single repo. Cross-repo dependencies require manual configuration.
- **FM-14: Non-deterministic test flakiness.** QA reports failures verbatim, but flaky tests cause false positives. Future: flakiness detection.
- **FM-15: Model provider outages.** If the configured model provider is down, the pipeline stalls. Future: fallback provider configuration.

---

## Contributing

If you encounter a failure mode not listed here, please open an issue with:
1. What happened
2. What you expected
3. The context files and agent logs
4. Whether the hierarchy of corrections could have prevented it
