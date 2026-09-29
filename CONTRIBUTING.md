# Contributing to Agent Flow

## Setup

```bash
git clone https://github.com/Drix10/agent-flow.git
cd agent-flow
npm install
npm test          # builds, then runs every test against temp git repos
```

Node ≥ 20 and git are required. The CI matrix covers Linux, macOS and Windows on Node 20 and 22.

## Layout

```
extensions/lib/   all logic, zero dependencies (shared by Pi tools and the CLI)
extensions/*.ts   thin Pi tool wrappers + the guard hook
bin/agent-flow.js CLI
skills/           Agent Skills (instructions only)
prompts/          Pi slash-command templates
templates/        AGENTS.md, module AGENTS.md, CLAUDE.md, DOCS_INDEX.md, manifest
schemas/          JSON Schema for CONTEXT_MANIFEST.json and the Implementer / Reviewer / QA reports
tests/            node:test suites; real git repos in temp directories
docs/             harness matrix, quickstart, the v1.1 audit
```

## Rules for changes

1. **Logic goes in `extensions/lib/`.** Tool wrappers and the CLI only parse input and format output. Otherwise Pi and every other harness drift apart.
2. **No runtime dependencies.** `node:` built-ins only.
3. **No shell strings.** Use `execFile` with argv. Validate anything that reaches git (`validateBranchName`, `validateRevision`).
4. **Anything that writes goes through `resolveInside` + `atomicWrite`,** and user-facing writes go through `requireConfirmation`.
5. **Every claim in a doc needs a test, or gets labelled Instructed.** If you write "enforced", link the test.

## Adding a failure mode

1. Add an entry to `FAILURE_MODES.md`: what happens, the fix, a status (Enforced / Checked / Instructed / Open).
2. If the fix is code, add a test that fails without it.
3. If the fix is a skill instruction, say so. Don't call it enforced.

## Testing against a real repo

```bash
npm run build
cd /path/to/some/repo
node /path/to/agent-flow/bin/agent-flow.js doctor
node /path/to/agent-flow/bin/agent-flow.js audit-risk
pi -e /path/to/agent-flow/extensions/index.js     # load the extensions in Pi
```

## Skill authoring

Follow the [Agent Skills specification](https://agentskills.io/specification):
- `name` matches the directory (lowercase, hyphens, ≤ 64 chars);
- `description` ≤ 1024 chars, and says what the skill does *and when to use it*;
- don't declare `allowed-tools` as if it restricted anything (FM-16).

## Code of Conduct

By participating you agree to the [Contributor Covenant](./CODE_OF_CONDUCT.md).
