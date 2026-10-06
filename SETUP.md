# Set up Agent Flow in a repository (prompt for an AI agent)

Give this to any coding agent (Claude Code, Codex, Gemini CLI, Cursor, Copilot, Windsurf, …) while it is working inside the repository to set up. Paste the prompt below, or tell the agent: *"Follow https://github.com/Drix10/agent-flow/blob/main/SETUP.md to set up Agent Flow in this repo."*

## Prompt

```text
Set up Agent Flow (@drix10/agent-flow) in this repository, end to end. Work in the repo root on a new branch (agent-flow-setup). Do each step in order and stop to ask me where a step says ASK. Never invent facts about this repo: read the code, and ask when unsure.

1. Check. Node 20+ and git are required (`node -v`, `git status`). Stop and tell me if the working tree has uncommitted changes I did not mention. Note which coding tool you are (claude, codex, gemini, cursor, copilot, windsurf, or agents for anything else) and whether this repo has a package.json.

2. Install. Run `npx @drix10/agent-flow install --harness <your tool>`. It copies the skills and wires the guard hook. Without a package.json it also vendors a small runtime into `.agent-flow-runtime/`; commit that directory. If the output has a "note", do what it says (for example Gemini needs `/trust` and a `context.fileName` setting). It also wires a short `SessionStart` briefing (`--no-brief` leaves it out) where the tool has hooks. If I use several tools, repeat with each `--harness`; `cline`, `kiro`, `qoder`, `swival`, `factory` and `commandcode` are instruction-tier (a rules file or a skills folder, no hook that blocks a call).

3. Bootstrap. Use the `agent-flow-bootstrap` skill (Claude Code: `/agent-flow-bootstrap`; elsewhere: "use the bootstrap skill"). It scans the repo read-only and proposes AGENTS.md and CONTEXT_MANIFEST.json. Keep any rules file I already have (AGENTS.md, CLAUDE.md, .cursorrules) as the source of truth; do not overwrite it. ASK me before writing:
   - protected_paths: files that must never change (frozen specs, migrations, ledgers, lockfiles). Propose from what you found; I confirm. A protected path stops an unattended run.
   - review_paths: CI workflows (usually `.github/workflows/`). Agents may add lines there (a new test in the CI list) and I review the pull request, so a CI change doesn't stop the run. An edited or removed line, or an added line that reaches secrets, is sent back. Ask me; don't list the same path under protected_paths.
   - risk_boundaries: the areas where a mistake is expensive (auth, payments, data, kernel code). Propose; I confirm.
   - gates: the real commands for build, test and lint, each runnable here. Run each once to prove it works; a gate that fails on a clean tree is not a gate. Mark a gate that only works on one OS with "os".
   - models (optional): pipeline.models.fast for implement/QA, pipeline.models.high_reasoning for review of critical changes.
   If the secrets scan flags a file, show me the file and the finding; do not ignore it silently.

4. Wire and verify. Run these, fix what they report, and show me the output of the last three:
   npx @drix10/agent-flow hook install        (pre-commit gate)
   npx @drix10/agent-flow manifest sync --yes (if you added or moved context files)
   npx @drix10/agent-flow codeowners --yes    (CODEOWNERS lines for protected_paths)
   npx @drix10/agent-flow baseline accept --all --yes   (only after I reviewed `audit-risk`)
   npx @drix10/agent-flow doctor
   npx @drix10/agent-flow gates run
   npx @drix10/agent-flow status
   Use `node .agent-flow-runtime/bin/agent-flow.js` instead of `npx @drix10/agent-flow` if the runtime was vendored.

5. Try it. Run `agent-flow run "<a small task from this repo>" --dry-run` and show me the result. Do not run it for real or pass --pr without my say-so.

6. Commit. Stage only what setup created (skills, AGENTS.md, CONTEXT_MANIFEST.json, CODEOWNERS, .agent-flow-runtime/, hook wiring). One commit: "chore: set up agent-flow". Do not push unless I ask.

7. Report in under 15 lines: what was installed, the protected paths, risk boundaries and gates you set, anything that failed or that I still must do by hand (for example branch protection on GitHub: "Require review from Code Owners").

Rules while you work: do not edit protected paths or the guard's wiring to get around a block; if the guard blocks you, say so and ask me. Do not add dependencies to this project.
```

## What the steps do

| Step | Command | Result |
|---|---|---|
| Install | `install --harness <name>` | Skills in the tool's folder (`.claude/skills`, `.agents/skills`, `.cursor/skills`, `.gemini/skills`, `.github/skills`), the Reviewer agent where the tool supports one, and the guard hook where it has hooks. Merged into existing settings, never replacing them. |
| Bootstrap | the `agent-flow-bootstrap` skill | `AGENTS.md` and `CONTEXT_MANIFEST.json` (protected paths, risk boundaries, gates, models), written only after you confirm. |
| Wire | `hook install`, `codeowners`, `manifest sync`, `baseline accept` | Pre-commit gate, owner review on protected paths, a manifest that matches the files on disk, a risk baseline. |
| Verify | `doctor`, `gates run`, `status` | Broken context references, gates that actually pass, and one screen of what protects the repo. |

Details: [docs/QUICKSTART.md](docs/QUICKSTART.md) for the first run, [docs/ADOPTION.md](docs/ADOPTION.md) for adopting in layers and for what each file is.
