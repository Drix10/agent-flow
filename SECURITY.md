# Security

Agent Flow touches your repository with autonomous agents. This document explains what is enforced, what is conventional, and how to verify every claim yourself.

## What is enforced at the harness level

- **Reviewer and QA cannot write code.** Their skills declare `allowed-tools` without `write` or `edit`. Verify: `grep allowed-tools skills/reviewer/SKILL.md skills/qa/SKILL.md`.
- **Bootstrap and repair need confirmation strings.** `bootstrap_write` requires `CONFIRM_BOOTSTRAP`; `stale_repair` requires `CONFIRM_REPAIR`; `risk_baseline_update` requires `CONFIRM_RISK_BASELINE`. Without the exact string, the tool throws. Verify in `extensions/*.ts`.
- **Implementers work on isolated branches.** Each issue gets its own git worktree and branch (`agent/issue-N`). Nothing lands on your main branch except through a PR you approve.

## What is conventional (not enforced)

- **`allowed-tools` enforcement depends on the harness.** On Pi, skill `allowed-tools` restricts the model. On other harnesses (Claude Code, Cursor), the equivalent mechanism is the harness's own permission system — copy `skills/` over, then confirm the target harness honors the tool list. Until you have watched the Reviewer refuse a direct "write this file" instruction, treat read-only review as **instructed, not proven**. See FM-16 in `FAILURE_MODES.md`.
- **Protected paths** are a bootstrap-time agreement recorded in `CONTEXT_MANIFEST.json`, backed by a pre-commit hook only if you install one. The template does not install hooks for you yet.

## How to audit this package

1. **Read the extensions.** There are six small TypeScript files in `extensions/`. No minification, no bundled blobs, no postinstall scripts. `grep -rn "fetch\|axios\|https://" extensions/` should return nothing.
2. **Run the tests.** `npm test` checks package integrity, skill tool exclusions, and extension wiring. `npm run build` type-checks every tool against Pi's real `ToolDefinition` API.
3. **Check the pack.** `npm pack --dry-run` lists exactly what ships. Only `extensions/`, `skills/`, `templates/`, `prompts/`, `README.md`, and `FAILURE_MODES.md`.
4. **No telemetry.** The package makes no network calls. The only network traffic is your own model provider calls from the harness.

## Known risk data

Independent research finds 26.1% of agent skills contain at least one vulnerability (data exfiltration 13.3%, privilege escalation 11.8%), and skills bundling executable scripts are 2.12× more likely to be vulnerable. Mitigations in this package:

- Skills are instruction-only Markdown. The only executable code is the auditable TypeScript in `extensions/`.
- Every file-writing tool requires an explicit confirmation string.
- CI runs build, lint, and tests on every push.

## Reporting

Open an issue at https://github.com/Drix10/agent-flow/issues with what happened, what you expected, and the relevant logs. Do not post secrets — scrub tokens and keys before attaching output.
