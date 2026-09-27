# Quickstart (5 minutes)

## 1. Install

```bash
pi install npm:@drix10/agent-flow                                         # Pi
npm i -D @drix10/agent-flow && npx agent-flow install --harness claude    # or codex | gemini | cursor | copilot
npx agent-flow hook install                                               # everyone
```

## 2. Bootstrap

```text
/bootstrap
```

It scans read-only, stops if it finds committed secrets, proposes `AGENTS.md` and `CONTEXT_MANIFEST.json` with confidence markers, and asks you for protected paths and critical areas. Each file is written only after you approve it.

Then accept the current risk surfaces as your baseline:

```bash
npx agent-flow audit-risk                  # review
npx agent-flow baseline accept --all --yes
```

## 3. Run an issue

```text
/implement 42
```

Worktree → Implementer → mechanical classification → Reviewer (no write or shell tools) → QA (re-runs failures once to catch flakes) → PR. Round 3 escalates to **Needs Me**. Critical changes open a **draft** PR for you.

To follow along: `AGENT_STATE.md`, or `npx agent-flow state`.

## 4. Keep context true

```text
/doctor     # report only
/garden     # sync docs index, audit risk, re-verify and repair context
```

Add `npx agent-flow doctor` and `npx agent-flow audit-risk --fail-on-new` to CI. There's a ready-made workflow in the README.

## Headless (`pi -p`)

Slash commands are expanded in interactive sessions. In `-p` mode, name the skill in the prompt: `pi -p "Use the gardener skill's /doctor procedure"`. File-writing tools refuse to run headless unless you launch with `AGENT_FLOW_HEADLESS_WRITES=1`, because there is no human to confirm.
