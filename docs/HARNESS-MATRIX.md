# Harness Enforcement Matrix

What is **enforced** (the harness or our code blocks it), **checked** (the pre-commit hook or CI catches it), or only **instructed** (the model is asked to comply), per harness.

| Capability | Pi | Claude Code | Codex CLI | Gemini CLI | Cursor | VS Code / Copilot |
|---|---|---|---|---|---|---|
| Skill discovery | `pi.skills` | `.claude/skills/` | `.agents/skills/` | `.gemini/skills/` | `.cursor/skills/` | `.github/skills/` |
| Root context auto-loaded | `AGENTS.md` | `CLAUDE.md` → `@AGENTS.md` | `AGENTS.md` | `GEMINI.md`, or `context.fileName` incl. `AGENTS.md` | `AGENTS.md` | `AGENTS.md` |
| `allowed-tools` restricts tools | ❌ pre-approval only (FM-16, tested) | ❌ pre-approval | ❌ | ❌ | ❌ | ❌ |
| Reviewer can't write | ✅ `--tools read,grep,find,ls` + guard | ✅ subagent `tools: Read, Grep, Glob` | ✅ `codex exec --sandbox read-only` (verified flag) | ⚠️ tool list without write/shell, unverified | ❌ instructed | ❌ instructed |
| Protected paths | ✅ guard (per call) + hook | ✅ hook (commit time) | ✅ hook | ✅ hook | ✅ hook | ✅ hook |
| Implementer confined to worktree | ✅ guard | ❌ instructed | ❌ instructed | ❌ instructed | ❌ instructed | ❌ instructed |
| State machine (round cap, transitions) | ✅ `state_update` tool | ✅ `npx agent-flow state update` | ✅ CLI | ✅ CLI | ✅ CLI | ✅ CLI |
| Mechanical risk classification | ✅ `risk_classify` | ✅ `npx agent-flow classify` | ✅ CLI | ✅ CLI | ✅ CLI | ✅ CLI |
| Drift / risk checks | ✅ tools + CLI | ✅ CLI | ✅ CLI | ✅ CLI | ✅ CLI | ✅ CLI |
| Human confirmation for context writes | ✅ UI dialog | the harness's own permission prompt | same | same | same | same |
| Install | `pi install npm:@drix10/agent-flow` | `npx agent-flow install --harness claude` | `… --harness codex` | `… --harness gemini` | `… --harness cursor` | `… --harness copilot` |

A ✅ from the CLI means the rule is enforced when the CLI is called. Whether the agent calls it depends on the skill (instructed), but the rule itself can't be bypassed by calling the CLI with different arguments.

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
