# Distribution: where Agent Flow is listed

One row per directory or marketplace. **Shipped** means this repo already contains everything that side needs. **Needs a human** means someone with an account has to click, submit, post or install — those items are collected as a message at the bottom. Move a row by doing its next step.

| Directory | State | Install command | Next step |
|---|---|---|---|
| npm | ✅ Listed | `npx @drix10/agent-flow install …` | none — `npm-publish.yml` publishes on every GitHub release |
| pi.dev/packages | ✅ Automatic | `pi install npm:@drix10/agent-flow` | none — the catalog scans npm for the `pi-package` keyword; allow index lag after a release |
| skills.sh | ⏳ Unranked | `npx skills add Drix10/agent-flow` | installs — the leaderboard page is created from install telemetry, there is no submission form |
| Claude official directory | ❌ Not submitted | `/plugin marketplace add Drix10/agent-flow` (ours, below) until listed | submit at `claude.ai/directory/manage`: run `claude plugin validate` first, then portal review (human) |
| Claude (own marketplace) | ✅ Shipped in `.claude-plugin/marketplace.json` | `/plugin marketplace add Drix10/agent-flow` | none |
| Codex (repo marketplace) | ✅ Shipped in `.agents/plugins/marketplace.json` + `plugins/agent-flow/plugin.json` | `codex plugin marketplace add Drix10/agent-flow` | installs + universal-directory submission through the plugin portal (human) |
| Cursor | ✅ File-level via `install --harness cursor` | — | `cursor.directory` community listing (human) |
| Copilot / Windsurf / others | ✅ File-level via `install` | — | no central directory to join |
| Awesome lists | ❌ No PRs | — | PRs to the skills roundup lists (human) |

Notes:

- `plugins/agent-flow/skills/` are copies of `skills/` (the portable plugin format discovers `skills/` automatically, so the manifest needs no skill list). `tests/dogfood.test.js` fails on any drift, and `scripts/check-versions.mjs` pins `plugins/agent-flow/plugin.json` to the release version.
- The Codex marketplace entry follows the repo's default branch. To pin a release, add the `--ref` flag with the release tag; to fetch only the marketplace file, add `--sparse` with `.agents/plugins`.
- After a release, refresh the rows that lag behind npm: pi.dev/packages (automatic) and the skills.sh leaderboard (needs installs, not a refresh).
