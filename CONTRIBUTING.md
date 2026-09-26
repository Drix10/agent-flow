# Contributing to Agent Flow

## Prerequisites

- Node.js >= 20
- Git
- A Pi-compatible harness (Pi, Claude Code, Codex, Gemini CLI, or Cursor)

## Setup

```bash
git clone https://github.com/Drix10/agent-flow.git
cd agent-flow
npm install
npm run build
npm test
```

## Development Workflow

1. Fork the repo and create a feature branch: `git checkout -b feat/my-feature`
2. Make changes. Run `npm run build` and `npm test` before committing.
3. Run the doctor against your own repo to verify nothing broke:
   ```bash
   node extensions/stale-detector.js --manifestPath ./CONTEXT_MANIFEST.json
   ```
4. Open a PR. Describe what changed and which failure mode it addresses.

## Testing Against a Real Repo

The best way to test your changes:

1. Clone a small test repo.
2. Symlink your local `agent-flow` into the test repo's `.pi/` directory.
3. Run `/bootstrap`, `/implement`, and `/garden`.
4. Observe which failure modes occur. Add them to `FAILURE_MODES.md`.

## Adding a New Failure Mode

If you find a failure mode not in `FAILURE_MODES.md`:

1. Add an entry with: what happens, why it matters, the fix, and which file addresses it.
2. If the fix is code, add the code and the test.
3. If the fix is prose (a skill instruction), update the relevant `SKILL.md`.
4. Update the "Open Issues" section if the fix is incomplete.

## Skill Authoring Rules

All `SKILL.md` files must follow the [Agent Skills specification](https://agentskills.io/specification):

- YAML frontmatter with `name` and `description` (required)
- `name` must match the parent directory name, lowercase, hyphens only, max 64 chars
- `description` max 1024 chars, describes what the skill does **and when to use it**
- Body contains the workflow, constraints, and output format

## Code of Conduct

By participating, you agree to uphold the [Contributor Covenant](./CODE_OF_CONDUCT.md).
