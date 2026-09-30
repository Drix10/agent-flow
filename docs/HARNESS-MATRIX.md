# Harness Enforcement Matrix

What is **enforced** (the harness or our code blocks it), **checked** (the pre-commit hook or CI catches it), or only **instructed** (the model is asked to comply), per harness.

| Capability | Pi | Claude Code | Codex CLI | Gemini CLI | Cursor | VS Code / Copilot | Windsurf |
|---|---|---|---|---|---|---|---|
| Skill discovery | `pi.skills` | `.claude/skills/` | `.agents/skills/` | `.gemini/skills/` | `.cursor/skills/` | `.github/skills/` | none documented — `.agents/skills/` is a manual reference |
| Root context auto-loaded | `AGENTS.md` | `CLAUDE.md` → `@AGENTS.md` | `AGENTS.md` | `GEMINI.md`, or `context.fileName` incl. `AGENTS.md` | `AGENTS.md` | `AGENTS.md` | `AGENTS.md`, per-directory in monorepos |
| `allowed-tools` restricts tools | ❌ pre-approval only (FM-16, tested) | ❌ pre-approval | ❌ | ❌ | ❌ | ❌ | ❌ |
| Reviewer can't write | ✅ `--tools read,grep,find,ls` + guard (write-block probed live) | ✅ subagent `tools: Read, Grep, Glob` | ✅ `codex exec --sandbox read-only` (OS sandbox; flag verified against `--help`, write-block not yet probed by us) | ⚠️ default approval mode: headless denies writes and shell (unverified) | ❌ instructed | ❌ instructed | ❌ instructed |
| Protected paths | ✅ guard (per call) + hook | ✅ `agent-flow guard` hook (per call) + pre-commit hook | ⚠️ pre-commit hook only | ⚠️ pre-commit hook only | ⚠️ pre-commit hook only | ⚠️ pre-commit hook only | ⚠️ pre-commit hook only |
| Implementer confined to worktree | ✅ file tools (incl. symlinks), guard · ⚠️ shell best-effort | ✅ file tools via `agent-flow guard` hook · ⚠️ shell best-effort | ❌ instructed | ❌ instructed | ❌ instructed | ❌ instructed | ❌ instructed |
| No `--no-verify` / force-push / push to default branch by agents | ⚠️ guard, every session (shell analysis) | ⚠️ `agent-flow guard` hook, every session (shell analysis) | ❌ instructed | ❌ instructed | ❌ instructed | ❌ instructed | ❌ instructed |
| Protected directories, bulk git rewrites, env-file reads | ✅ guard | ✅ `agent-flow guard` hook | ❌ pre-commit only | ❌ pre-commit only | ❌ pre-commit only | ❌ pre-commit only | ❌ pre-commit only |
| State machine (round cap, transitions) | ✅ `state_update` tool | ✅ `npx @drix10/agent-flow state update` | ✅ CLI | ✅ CLI | ✅ CLI | ✅ CLI | ✅ CLI |
| Mechanical risk classification | ✅ `risk_classify` | ✅ `npx @drix10/agent-flow classify` | ✅ CLI | ✅ CLI | ✅ CLI | ✅ CLI | ✅ CLI |
| Drift / risk checks | ✅ tools + CLI | ✅ CLI | ✅ CLI | ✅ CLI | ✅ CLI | ✅ CLI | ✅ CLI |
| Human confirmation for context writes | ✅ UI dialog | the harness's own permission prompt | same | same | same | same | same |
| Install | `pi install npm:@drix10/agent-flow` | `npx @drix10/agent-flow install --harness claude` | `… --harness codex` | `… --harness gemini` | `… --harness cursor` | `… --harness copilot` | `… --harness windsurf` |

"⚠️ pre-commit hook only" means the rule is *checked* when a commit is made (the hook rejects it), not blocked when the agent writes the file: the write still happens on disk. Only Pi and Claude Code block per call.

**Gemini CLI:** the pipeline runs the Implementer and QA with `--approval-mode yolo` (they need a shell), so nothing confines them while they run; only the pre-commit hook and QA's before/after tree check contain them. The Reviewer runs at the default approval mode, and its write-block is unverified until someone runs the probe below. See `skills/invoking-agents/references/launch.md`.

"⚠️ shell best-effort" means the guard lexes the command and resolves where it writes (redirections, `cp`/`mv`/`tee`/`sed -i`…, following `cd`), but it only sees the command text: an interpreter or script can still write anywhere. For a hard guarantee, run the agent in a container or sandbox. The same limit applies to the git row: branch protection on the remote is the real backstop.

A ✅ from the CLI means the rule is enforced when the CLI is called. Whether the agent calls it depends on the skill (instructed), but the rule itself can't be bypassed by calling the CLI with different arguments.

**Gemini CLI, Codex, Cursor:** `install --harness gemini|codex|cursor` now also wires the guard as a pre-tool hook (`.gemini/settings.json` `BeforeTool`, `.codex/hooks.json` `PreToolUse`, `.cursor/hooks.json` `beforeShellExecution`/`beforeReadFile`/`preToolUse`, fail-closed). Built from each vendor's hook documentation and unit-tested with their payload shapes; **not yet verified in a live session**, and hook config paths/shapes for Codex and Gemini's project-dir variable are the likeliest things to need a fix. Run the same A/B/C probe as for OpenCode. Existing hooks in those files are kept.

**OpenCode:** `npx @drix10/agent-flow install --harness opencode` writes `.opencode/plugins/agent-flow-guard.js`, a `tool.execute.before` plugin that runs the guard before each tool call and throws (denying the call) on a block. Unit-tested against the plugin API; **not yet verified in a live OpenCode session**. Probe: protect a path in `CONTEXT_MANIFEST.json`, ask OpenCode to write there, and expect a denial naming the rule.

## Everything else that reads `AGENTS.md`

The CLI rows above (`doctor`, `classify`, `audit-risk`, `state`, the pre-commit hook) don't care which harness is running — they read your repo, your manifest and your git history, not the agent. So they already work, unmodified, with every other tool that has adopted the [AGENTS.md](https://agents.md) convention: Aider, Zed, Warp, Amp, opencode, goose, JetBrains Junie, RooCode, Kilo Code, Devin, Jules, Factory, and Augment Code among them. `npx @drix10/agent-flow install --harness agents` gives any of these a conventional `.agents/skills/` folder to point their own instructions at; only the harness-specific rows above (skill auto-discovery, a locked-down reviewer subagent) need a name in the table.

## Verify it yourself

Every "⚠️ unverified" cell is one probe away from ✅ or ❌. Launch the reviewer on that harness and ask it to *"create TEST.md containing hello"*. If the file appears, the cell is ❌. Please open an issue with the result either way.

**Claude Code is already live-verified this way**, not just checked structurally: in a scratch repo with `.claude/agents/reviewer.md` installed, we asked a top-level session to launch the `reviewer` subagent via the Task tool and told the subagent, in its own prompt, to create `TEST.md` by any means available and report whether it succeeded. It reported it had no write-capable tool and could not; `TEST.md` did not exist on disk afterward. That is the same probe described above — run it again on your own install to reproduce it, especially after a Claude Code version bump.

**What "✅" means for Codex's `--sandbox read-only`:** the flag itself is real — checked against `codex exec --help` on v0.157.1, and it's OpenAI's own OS-level sandbox (Seatbelt on macOS, Landlock/seccomp on Linux), the same category of mechanism as a container. We could not run the write-block probe end-to-end ourselves (no Codex account in our test environment), so if you're the first to run it, please still open an issue with the result — that turns "flag exists and is documented as a hard sandbox" into "we watched it block a write."

## Why skills alone can't enforce anything

A SKILL.md is text that goes into the model's context. Enforcement needs something that sits *between* the model and the tool:
- a harness permission system (Claude Code subagent `tools`, the Codex sandbox);
- a hook (Pi `tool_call`, git pre-commit);
- a process boundary (`pi --tools`, a container).

Agent Flow uses all three where they exist, and says plainly where they don't.
