# Lean: the smallest correct change

A pipeline that checks code well still lets a model over-build it: a dependency where the standard library had a call, an abstraction with one user, a wrapper that only forwards. The Reviewer then reads more than there is to read, and a person reading the pull request does too. `pipeline.lean` tells the Implementer and the Reviewer to push the other way, without ever relaxing what makes the change safe.

## The setting

```json
{ "pipeline": { "lean": "lite" } }
```

| Level | What the roles are told |
|---|---|
| `off` | Nothing. The Implementer's "smallest change that satisfies every criterion" is all there is. |
| `lite` (default) | Reuse before you write. Fix the root cause: grep every caller before changing a function. Leave one runnable check for non-trivial logic. Mark a deliberate shortcut with a `lean:` comment and list it in the report. Never lean away validation, error handling, security or accessibility. |
| `full` | All of `lite`, and climb the ladder strictly (below). The Reviewer treats an avoidable new dependency as blocking instead of a warning. |

It is read from the default branch's manifest, like `gates` and `policy`, so a branch can't switch it off for its own review. `run` appends `Lean level: <level>.` to the Implementer's and the Reviewer's prompt, and the manual launch recipe does the same.

## The ladder (`full`)

Stop at the first rung that holds: do the criteria need it at all, then does the repo already have it, then the standard library, then a platform feature (see [native-first](../skills/implementer/references/native-first.md)), then an installed dependency, then one line, then the minimum that works. Add no abstraction the criteria didn't ask for, no scaffolding for later, and the fewest files.

The ladder runs after understanding the problem, never instead of it: the Implementer reads the code the change touches and traces the real flow first. A small diff in the wrong place is a second bug.

## Shortcuts are debt somebody can see

A shortcut that cuts a real corner (a global lock, an O(n²) scan, a naive heuristic) is marked where it lives:

```python
# lean: one global lock; per-account locks if throughput matters
```

The Implementer also lists it under `shortcuts` in its report, and `run --pr` puts the list in the pull request. `agent-flow debt` reads them all back from the code (`--json`, `--fail-on-no-trigger`), and flags the ones that name no condition for revisiting them, because those are the ones that rot. `agent-flow status` shows the count, and the Gardener's `/debt` turns them into issues. `ponytail:` comments are read too. A marker inside a string literal (a test fixture) is text, not a comment.

## The Reviewer's lean lens

At `lite` and `full` the Reviewer also hunts what could be deleted, as non-blocking findings, one line each, tagged `delete`, `stdlib`, `native`, `reuse`, `yagni` or `shrink`, with the replacement named, and reports `net_lines_removable`. It never flags a small runnable check, a `lean:` marker, or validation, error handling, security or accessibility code. The Gardener's `/audit-lean` is the same lens over the whole repo, as a report.

## What is and isn't claimed

- The ruleset text and the report fields are tested (`tests/lean.test.js`, `tests/release-hygiene.test.js`). **Whether it makes a model write less code in your repo is not measured here**, and a terse reasoning model can end up costing more. Turn it to `off` if a run shows it hurting.
- It is guidance, not enforcement: nothing blocks an over-built change. The guard, the classifier and the gates are what enforce; this makes the change smaller before they look at it.

## Keeping a role honest about its inputs

Anything measuring a role is only as good as its isolation. A plugin or hook installed globally on the machine adds context to the Reviewer or to QA. `pipeline.isolate_roles: true` launches each role with `--setting-sources project,local`, so only the repository's own Claude Code settings apply. It is off by default because it also drops the user's own settings for roles (model defaults, user-level MCP servers); the project's guard hook is project-level and stays.

## Spending fewer tokens on the instructions themselves

Lean mode shrinks what a role writes. The other cost is what a session reads before it starts, and that is the part agent-flow controls exactly. What changed, with sizes measured in characters (not tokens, which depend on the model's tokenizer):

- **Skill descriptions** are loaded into every session that has the skill installed. The six went from 3,285 to 1,969 characters, and `tests/token-budget.test.js` keeps each under 450 and the total under 2,200.
- **The orchestrator skill** was 15.2 KB, read by any session that invoked it. On Claude Code the CLI (`agent-flow run`) does the orchestrating, so it is now 3.9 KB with the manual procedure in `references/manual.md`, read only by a harness that needs it.
- **Roles** are told to answer first and say nothing between tool calls, to give findings as one line each, and to keep code, paths and error text verbatim. QA's raw-output limit keeps the first 50 and last 100 lines of a long log, because the failure is usually at the end. Security warnings, irreversible actions and anything written to a commit, comment or document stay in plain prose, so terse never reaches a commit message or a code comment.
- **Context files**: `agent-flow doctor` now warns, without failing, when an `.md` context file is over 150 lines or about 9 KB, since every task pays for it. The agent is told not to read `CONTEXT_MANIFEST.json` (tools read it; `agent-flow brief` says what an agent needs). The starter `DOCS_INDEX.md` lost its lifecycle list and its copy of the manifest.
- **The MCP server** cuts a tool answer at 20,000 characters instead of 200,000.

Not measured: how much less a model outputs with the terse rule in your repo. Thinking tokens are untouched by it.

## Credits

The idea, the ladder, the reviewer tags and the `lean:` marker come from [ponytail](https://github.com/DietrichGebert/ponytail) (MIT, Dietrich Gebert), and the terse-output rules from [caveman](https://github.com/JuliusBrussee/caveman) (MIT, Julius Brussee). The wording here is this project's own, written around agent-flow's guard, report schemas and escalation, not copied. Their benchmark figures are theirs, self-reported on their own tasks and models; none is claimed here.
