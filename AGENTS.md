# AGENTS.md: session rules

- `extensions/**/*.ts` and `bin/agent-flow.js` are the source; `extensions/**/*.js` is build output and ignored.
- `skills/` is the source for the skill copies in `.agents/`, `.cursor/` and `.gemini/`; `templates/opencode/` is the source for `.opencode/plugins/`. `tests/dogfood.test.js` fails when a copy drifts.
- Before finishing: `npm run lint` and `npm test`.
- Every guard change needs a regression test; record behaviour changes in `CHANGELOG.md`.
- No machine paths, keys or tokens in tracked files.
