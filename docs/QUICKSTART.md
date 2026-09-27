# Quickstart (5 minutes)

## 1. Install

```bash
npm i -D @drix10/agent-flow && npx agent-flow install --harness claude    # or codex | gemini | cursor | copilot
pi install npm:@drix10/agent-flow                                         # Pi, additionally gets tool-level enforcement
npx agent-flow hook install                                               # everyone
```

## 2. Bootstrap

Pi: `/bootstrap`. Claude Code, Codex, Gemini CLI, Cursor, Copilot, Windsurf: ask the agent to bootstrap the repo (it has the `bootstrap` skill installed) — or run it yourself, `npx agent-flow scan`, and follow the same skill.

It scans read-only, stops if it finds committed secrets, proposes `AGENTS.md` and `CONTEXT_MANIFEST.json` with confidence markers, and asks you for protected paths and critical areas. Each file is written only after you approve it.

Then accept the current risk surfaces as your baseline:

```bash
npx agent-flow audit-risk                  # review
npx agent-flow baseline accept --all --yes
```

## 3. Run an issue

Pi: `/implement 42`. Elsewhere: ask the agent to work issue 42 through the pipeline (`invoking-agents` skill).

Worktree → Implementer → mechanical classification → Reviewer (no write or shell tools) → QA (re-runs failures once to catch flakes) → PR. Round 3 escalates to **Needs Me**. Critical changes open a **draft** PR for you.

To follow along: `AGENT_STATE.md`, or `npx agent-flow state`.

## 4. Keep context true

Pi: `/doctor` (report only), `/garden` (sync docs index, audit risk, re-verify and repair context). Elsewhere: `npx agent-flow doctor`, or ask the agent to garden the repo (`gardener` skill).

Add `npx agent-flow doctor` and `npx agent-flow audit-risk --fail-on-new` to CI. There's a ready-made workflow in the README.

## Headless mode

Slash commands only exist on Pi, and only in interactive sessions. Everywhere — headless Pi (`pi -p`), `claude -p`, `codex exec` — name the skill and task in the prompt instead: `"Use the gardener skill's /doctor procedure"`. On Pi, file-writing tools refuse to run headless unless you launch with `AGENT_FLOW_HEADLESS_WRITES=1`, because there is no human to confirm; on the others, the harness's own headless approval policy applies (e.g. Codex's `--ask-for-approval`/`--sandbox`).
