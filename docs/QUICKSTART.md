# Quickstart (5 minutes)

## 0. See it work (no setup)

```bash
npx @drix10/agent-flow doctor
```

It finds your context files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.cursor/rules/*.mdc`, `.github/copilot-instructions.md`, `.windsurfrules`, root and nested), checks every backticked path they mention against the repo, and suggests where a renamed file went. Exit 1 if a reference is broken, 0 if not — so it works in CI as-is.

```bash
npx @drix10/agent-flow init          # preview; add --yes to write
```

`init` writes a starter `CONTEXT_MANIFEST.json` from what's on disk — every path your context files currently reference, stamped with today's date — which turns on staleness tracking. With no `AGENTS.md`, it also writes a skeleton from `package.json` scripts / Makefile targets, with unknowns marked `[NEEDS VERIFICATION]`. It never overwrites a file and never calls a model.

## 1. Install

```bash
npm i -D @drix10/agent-flow && npx @drix10/agent-flow install --harness claude    # or codex | gemini | cursor | copilot | windsurf | agents
pi install npm:@drix10/agent-flow                                         # Pi, additionally gets tool-level enforcement
npx @drix10/agent-flow hook install                                               # everyone
```

`install --harness claude` also adds `@AGENTS.md` to `CLAUDE.md` (creating it if needed) so Claude Code loads the root context.

## 2. Bootstrap

`init` gives you a mechanical starting point; bootstrap has an agent fill it in. Pi: `/bootstrap`. Claude Code, Codex, Gemini CLI, Cursor, Copilot, Windsurf: ask the agent to bootstrap the repo (it has the `bootstrap` skill installed) — or run it yourself, `npx @drix10/agent-flow scan`, and follow the same skill.

It scans read-only, stops if it finds committed secrets, proposes `AGENTS.md` and `CONTEXT_MANIFEST.json` with confidence markers, and asks you for protected paths and critical areas. Each file is written only after you approve it.

Then accept the current risk surfaces as your baseline:

```bash
npx @drix10/agent-flow audit-risk                  # review
npx @drix10/agent-flow baseline accept --all --yes
```

Commit `.risk-baseline.json`. Until it exists, `audit-risk --fail-on-new` exits 1 — a CI gate with nothing to compare against would pass while checking nothing.

## 3. Run an issue

Pi: `/implement 42`. Elsewhere: ask the agent to work issue 42 through the pipeline (`invoking-agents` skill).

Worktree → Implementer → mechanical classification → Reviewer (no write or shell tools) → QA (re-runs failures once to catch flakes) → PR. Round 3 escalates to **Needs Me**. Critical changes open a **draft** PR for you.

To follow along: `AGENT_STATE.md`, or `npx @drix10/agent-flow state`.

## 4. Keep context true

Pi: `/doctor` (report only), `/garden` (sync docs index, audit risk, re-verify and repair context). Elsewhere: `npx @drix10/agent-flow doctor`, or ask the agent to garden the repo (`gardener` skill).

Add `npx @drix10/agent-flow doctor` and `npx @drix10/agent-flow audit-risk --fail-on-new` to CI. There's a ready-made workflow in the README.

## Headless mode

Slash commands only exist on Pi, and only in interactive sessions. Everywhere — headless Pi (`pi -p`), `claude -p`, `codex exec` — name the skill and task in the prompt instead: `"Use the gardener skill's /doctor procedure"`. On Pi, file-writing tools refuse to run headless unless you launch with `AGENT_FLOW_HEADLESS_WRITES=1`, because there is no human to confirm; on the others, the harness's own headless approval policy applies (e.g. Codex's `--ask-for-approval`/`--sandbox`).
