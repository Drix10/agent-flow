# Distribution: where Agent Flow is listed

One row per directory or marketplace. **Shipped** means this repo already contains everything that side needs. **Needs a human** means someone with an account has to click, submit, post or install; the copy to paste for each is under [Listing copy](#listing-copy) and [Messages to send](#messages-to-send). Move a row by doing its next step.

| Directory | State | Install command | Next step |
|---|---|---|---|
| npm | ✅ Listed as `@drix10/agent-flow` | `npx @drix10/agent-flow install …` | none: `npm-publish.yml` publishes on every GitHub release. The unscoped `agentflow` is refused by npm (too similar to the existing `agent-flow`, another maintainer's two-release package from 2024); getting it means an npm name dispute, not started |
| GitHub repository | ✅ About text and topics set | — | none |
| GitHub Marketplace (the Action) | ✅ Published (per the maintainer) | `uses: Drix10/agent-flow@v<version>` | none: tick the Marketplace box again on each release |
| pi.dev/packages | ✅ Automatic | `pi install npm:@drix10/agent-flow` | none: the catalog scans npm for the `pi-package` keyword; allow index lag after a release |
| skills.sh | ⏳ Unranked | `npx skills add Drix10/agent-flow` | installs: the leaderboard page is created from install telemetry, there is no submission form |
| Claude official directory | ❌ Not submitted | `/plugin marketplace add Drix10/agent-flow` (ours, below) until listed | submit at `claude.ai/directory/manage`: `claude plugin validate .` passes for the repo and for `.claude-plugin/plugin.json`; the portal review is the human step |
| Claude (own marketplace) | ✅ Shipped in `.claude-plugin/marketplace.json` (skills only: the guard hook comes from `install --harness claude`) | `/plugin marketplace add Drix10/agent-flow` | none |
| Codex (repo marketplace) | ✅ Shipped in `.agents/plugins/marketplace.json` + `plugins/agent-flow/plugin.json` | `codex plugin marketplace add Drix10/agent-flow` | not yet run on a real Codex install; then the universal-directory submission through the plugin portal (human) |
| Cursor | ✅ File-level via `install --harness cursor` | — | `cursor.directory` community listing (human) |
| Copilot / Windsurf / others | ✅ File-level via `install` | — | no central directory to join |
| Awesome lists | ❌ No PRs | — | PRs to the skills roundup lists (human) |

Notes:

- `plugins/agent-flow/skills/` are copies of `skills/` (the portable plugin format discovers `skills/` automatically, so the manifest needs no skill list). `tests/dogfood.test.js` fails on any drift, and `scripts/check-versions.mjs` pins `plugins/agent-flow/plugin.json` to the release version.
- The Codex marketplace entry follows the repo's default branch. To pin a release, add the `--ref` flag with the release tag; to fetch only the marketplace file, add `--sparse` with `.agents/plugins`.
- After a release, refresh the rows that lag behind npm: pi.dev/packages (automatic) and the skills.sh leaderboard (needs installs, not a refresh).
- Not yet tried on a real machine: the `skills.sh` command and the Codex marketplace install. Run each once in a scratch repo before posting either anywhere.

## Listing copy

One positioning, used the same way on every surface. The tagline below is the `description` already in `package.json`, `plugin.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `gemini-extension.json` and `plugins/agent-flow/plugin.json`; the README's opening line says the same thing in more words. Change the wording in all of them or none: no test compares it.

**Name:** Agent Flow

**Tagline (173 characters):**
Run AI coding agents unattended, safely: Implement → Review → QA as separate agents, a guard that blocks edits they must never make, and context that stays true to the code.

**Under 125 characters (GitHub Marketplace's limit; this is the Action's `description`, 114 characters):**
Fail a PR when agent context drifts, a new risk surface appears, a protected path changes or a policy rule breaks.

**Short (one sentence, for directories with a single line):**
Run AI coding agents unattended without letting them go loose: one implements, another reviews, a third tests, a guard blocks what they must never touch, and you only see what needs you.

**Long (3 short paragraphs, for a listing page):**

> Give an agent a task and walk away. Agent Flow runs it through separate implement, review and QA steps in its own git worktree, blocks the edits an agent must never make, and leaves you a draft pull request and a short list of what needs a person.
>
> It lets an agent add a line to your CI test list without calling you back (the pull request waits as a draft), while protected paths, `--no-verify`, force-pushes and pushes to `main` stay refused. `agent-flow doctor` flags context files that no longer match the code.
>
> A Node.js CLI and skills package with no runtime dependencies, for Claude Code, Codex CLI, Gemini CLI, Cursor, Copilot, Windsurf, Pi and others that read `AGENTS.md`. The guard blocks tool calls directly on Claude Code and Pi; elsewhere the pre-commit hook and CI catch a slip. Every claim in the docs is marked enforced, checked or instructed.

**Tags:** agent-skills, ai-coding, guardrails, code-review, multi-agent, agents-md, context-drift, claude-code, codex, gemini-cli, cursor, pre-commit

**Say, and don't say:**

| Say | Don't say |
|---|---|
| Unattended runs with a guard and a review pipeline | "Fully autonomous" or "safe": the guard is best-effort on shell commands |
| Enforced on Claude Code and Pi; pre-commit and CI elsewhere | "Works the same on every harness" |
| Tests run against real git repositories | Any benchmark, star count, install count or token-saving percentage: none is measured here |
| Lean mode asks for the smallest correct change | That it makes a model write less code: not measured in your repo |

## Messages to send

Each is ready to paste. Replace `<version>` with the release.

**Claude official directory** (`claude.ai/directory/manage`): *Agent Flow runs coding agents through separate implement, review and QA steps and keeps their context true to the code. The plugin installs six skills (bootstrap, implementer, reviewer, QA, gardener, orchestrator). The guard that blocks edits to protected paths, `--no-verify` and pushes to the default branch is a hook that `npx @drix10/agent-flow install --harness claude` adds to the repo; the plugin alone does not wire it. MIT, no runtime dependencies. Repo: https://github.com/Drix10/agent-flow. Install: `/plugin marketplace add Drix10/agent-flow`.* Validation already passes (`claude plugin validate .`).

**Codex plugin portal:** *Agent Flow: unattended implement, review and QA with a guard for protected paths. Marketplace: `codex plugin marketplace add Drix10/agent-flow`. Source: https://github.com/Drix10/agent-flow (MIT).* Submit only after one real install worked.

**cursor.directory:** *Agent Flow: rules and skills that keep Cursor agents inside protected paths, with a review and QA pipeline and a session briefing. Install: `npx @drix10/agent-flow install --harness cursor`. https://github.com/Drix10/agent-flow*

**GitHub release (also the Marketplace listing for the Action):** *Agent Flow `<version>`: the release notes from `CHANGELOG.md`, then one line: "Action: `uses: Drix10/agent-flow@v<version>` fails a pull request on context drift, a new risk surface, a protected-path change or a broken policy rule."*

**Awesome-list PR title and line:** *Add Agent Flow: run coding agents unattended with a review pipeline and a guard.* Link the repo, one sentence, MIT.

**Contacting the owner of `agent-flow` on npm** (only if the unscoped name is wanted): *Hello, I maintain Agent Flow (https://github.com/Drix10/agent-flow), published as @drix10/agent-flow. Your `agent-flow` package has had no release since February 2024. Would you transfer the name, or tell me if you plan to keep using it? If I don't hear back I may open an npm name dispute.* Send it to the maintainer address on the package's npm page.
