# Harness Enforcement Matrix

What is **enforced** (the harness or our code blocks it), **checked** (the pre-commit hook or CI catches it), or only **instructed** (the model is asked to comply), per harness.


| Capability | Pi | Claude Code | Codex CLI | Gemini CLI | Cursor | VS Code / Copilot | Windsurf |
|---|---|---|---|---|---|---|---|
| Skill discovery | `pi.skills` | `.claude/skills/` | Codex plugin (`codex plugin marketplace add Drix10/agent-flow`) or `.agents/skills/` | `.gemini/skills/` | `.cursor/skills/` | `.github/skills/` | none documented — `.agents/skills/` is a manual reference |
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

**Gemini CLI:** the pipeline runs the Implementer and QA with `--approval-mode yolo` (they need a shell), so nothing confines them while they run; only the pre-commit hook and QA's before/after tree check contain them. The Reviewer runs at the default approval mode, and its write-block is unverified until someone runs the probe below. See `skills/agent-flow-invoking-agents/references/launch.md`.

"⚠️ shell best-effort" means the guard lexes the command and resolves where it writes (redirections, `cp`/`mv`/`tee`/`sed -i`…, following `cd`), but it only sees the command text: an interpreter or script can still write anywhere. For a hard guarantee, run the agent in a container or sandbox. The same limit applies to the git row: branch protection on the remote is the real backstop.

A ✅ from the CLI means the rule is enforced when the CLI is called. Whether the agent calls it depends on the skill (instructed), but the rule itself can't be bypassed by calling the CLI with different arguments.

**Gemini CLI, Codex, Cursor:** `install --harness gemini|codex|cursor` wires the guard as a pre-tool hook (`.gemini/settings.json` `BeforeTool`, `.codex/hooks.json` `PreToolUse`, `.cursor/hooks.json` `beforeShellExecution`/`beforeReadFile`/`preToolUse`). Existing hooks in those files are kept. Status:

- **Codex: verified live** on Linux/WSL (see below). Windows PowerShell is fixed and unit-tested, not re-run live.
- **Gemini CLI: docs-verified (Gemini CLI source and docs, main branch at 0.64 nightly / latest stable 0.61, read 2026-10-01), not run live.** The installed hook matches every tool (the real tool names change between releases), uses exit code 2 with a reason on stderr, and a crash exits 2. Things to know: project hooks are **not registered at all in an untrusted folder** (most likely why an earlier headless probe wrote both files: trust the folder first), any other hook failure (exit 1, timeout) lets the tool run, `hooksConfig.enabled: false` in user settings turns hooks off, and edits need a restart.
- **Cursor: docs-verified (cursor.com/docs/hooks, read 2026-10-01), not run live.** Entries are `failClosed: true` (Cursor fails open otherwise), a UTF-8 BOM on Windows stdin is stripped, and the Delete tool counts as a write. Known limits: project hooks need a trusted workspace; there is no documented pre-write hook, so a Write or Delete is only blocked if `preToolUse` denies it (docs list Write among its tools, but we found no explicit statement that a deny stops an edit); Tab completions use separate hooks we don't cover; in Cursor's CLI only some events are documented to fire (`beforeShellExecution` is, `beforeReadFile`/`preToolUse` unconfirmed), so in the CLI the shell hook is the backstop. Relative hook paths run from the project root for project hooks only.

**OpenCode:** `npx @drix10/agent-flow install --harness opencode` writes one flat file, `.opencode/plugins/agent-flow-guard.js`, with no SDK import, so it loads on both OpenCode v1 (named export and `server`) and v2 (`setup` plus `ctx.tool.hook("execute.before")`). **Docs- and source-verified (OpenCode 1.18.33 and the `@opencode/plugin` 2.0.20 package, read 2026-10-01), not run live.** A thrown error denies the call on v1 (documented). On v2 a throw aborts the call, but how it is shown to the model is unverified. Project plugins load without a trust prompt, but a v2 plugin that fails to load fails silently, so confirm with the probe below after installing. The hook covers built-in, MCP and subagent tool calls, but a `bash` command can still write around file-tool checks, which is why the guard also parses shell commands. As an extra layer, OpenCode's own `permission` config with `deny` rules holds even in headless mode (`ask` rules are auto-rejected there). Probe: protect a path in `CONTEXT_MANIFEST.json`, ask OpenCode to write there, and expect a denial naming the rule.

**OS sandbox:** bubblewrap 0.9.0 is installed in WSL Ubuntu 24.04 and a read-only bind test blocked a write. `agent-flow sandbox -- <cmd>` now wraps a command in bubblewrap (read-only filesystem except the worktree; options for a fully read-only tree, no network, a hidden home directory and extra writable directories are listed in the changelog). It is tested on Linux; not yet run on a Windows machine's WSL.

## Session briefing and the status badge

`install` also wires a short briefing so a session knows the rules before it runs into the guard (`agent-flow brief`: what is protected, what is review-only, what is always blocked, which checks must pass, how many issues wait on a person; facts only, never the free text of an issue). `--no-brief` leaves it out.

| Host | Hook | Output shape | Status |
|---|---|---|---|
| Claude Code | `SessionStart`, and `SubagentStart` (a subagent never sees the parent's context) | raw text at `SessionStart`, `hookSpecificOutput` JSON at `SubagentStart` | unit-tested here; not run live |
| Codex CLI | `SessionStart` in `.codex/hooks.json` | `hookSpecificOutput.additionalContext` | unit-tested here; not run live |
| Cursor | `sessionStart` in `.cursor/hooks.json` (fails open, unlike the guard) | `additional_context` | unit-tested here. not run live here. Its `subagentStart` is reported not to add context, so subagents don't get the brief |
| Gemini CLI, Copilot, Windsurf, OpenCode, Pi | none wired | | the hook event names and output shapes are unverified, so nothing is installed that could print the wrong thing into a session |

`agent-flow brief` recognises Copilot, Qoder and ZCode hook environments too (`COPILOT_PLUGIN_DATA`, `QODER_SESSION_ID`, `ZCODE_APP_VERSION`) and answers in their shapes, but `install` doesn't wire those hosts.

Claude Code's `statusLine` can show `agent-flow statusline` (guard on or OFF, how many issues need you, are ready, are working). `install --harness claude --statusline` sets it when no `statusLine` exists; an existing one is never replaced.

## More hosts: skills folders and rules files

Instruction-tier. The paths below are each host's documented convention, not checked by running these hosts here, and none has a hook agent-flow can use to block a call: enforcement is the pre-commit hook (`hook install`) and CI, so treat every row as ❌ instructed in the table above.

| Host | `install --harness` | Writes | Notes |
|---|---|---|---|
| Cline | `cline` | `.clinerules/agent-flow.md`, skills in `.agents/skills` | the rules file restates the guard's list and asks |
| Kiro | `kiro` | `.kiro/steering/agent-flow.md` (`inclusion: always`), skills in `.agents/skills` | |
| Qoder | `qoder` | `.qoder/rules/agent-flow.md`, skills in `.agents/skills` | Qoder also loads `AGENTS.md` on its own |
| Swival | `swival` | `.swival/skills/` | also reads `AGENTS.md` |
| Factory Droid | `factory` | `.factory/skills/` | also reads `AGENTS.md` up to the git root |
| Command Code | `commandcode` | `.commandcode/skills/` | also reads `AGENTS.md` |

`install` never writes a harness's files unless you named it, and `update` and `uninstall` act only on the harnesses that are installed (the install record names them; a hook file or rules file in place counts too).

## Everything else that reads `AGENTS.md`

The CLI rows above (`doctor`, `classify`, `audit-risk`, `state`, the pre-commit hook) don't care which harness is running — they read your repo, your manifest and your git history, not the agent. So they already work, unmodified, with every other tool that has adopted the [AGENTS.md](https://agents.md) convention: Aider, Zed, Warp, Amp, opencode, goose, JetBrains Junie, RooCode, Kilo Code, Devin, Jules, Factory, and Augment Code among them. `npx @drix10/agent-flow install --harness agents` gives any of these a conventional `.agents/skills/` folder to point their own instructions at; only the harness-specific rows above (skill auto-discovery, a locked-down reviewer subagent) need a name in the table.

## Verify it yourself

Every "⚠️ unverified" cell is one probe away from ✅ or ❌. Launch the reviewer on that harness and ask it to *"create TEST.md containing hello"*. If the file appears, the cell is ❌. Please open an issue with the result either way.

**Claude Code is already live-verified this way**, not just checked structurally: in a scratch repo with `.claude/agents/reviewer.md` installed, we asked a top-level session to launch the `reviewer` subagent via the Task tool and told the subagent, in its own prompt, to create `TEST.md` by any means available and report whether it succeeded. It reported it had no write-capable tool and could not; `TEST.md` did not exist on disk afterward. That is the same probe described above — run it again on your own install to reproduce it, especially after a Claude Code version bump.

**Claude Code guard hook, live-verified (2026-09-30, Claude Code 2.1.285, headless `claude -p`, bypass-permissions mode):** in a scratch repo with `install --harness claude` + `hook install` and `protected_paths: ["secrets/**"]`: Write to a protected file = blocked; Bash `git commit --no-verify` = blocked; Write to an ordinary file = allowed; Write to `.claude/settings.json` = blocked (guard wiring). Caveat we hit: in the cloud sandbox we ran in, `claude -p` did not load the project's `.claude/settings.json` hooks by itself (the hook only fired once the settings file was passed to Claude Code explicitly), so on a new machine confirm the hook fires (`agent-flow guard --check` and a `--no-verify` probe) rather than assuming the install worked.

**Codex guard hook, live-verified on Linux (WSL, 2026-09-30):** after trusting the project hook through Codex's own hook review (the /hooks command), a headless `codex exec` run with its automatic-approval mode and the default workspace-write sandbox was blocked by the hook on all three denied operations: a shell write to a protected file, a no-verify commit, and a write to `.codex/hooks.json` (Codex reported "Command blocked by PreToolUse hook"; nothing changed on disk). An ordinary file write ran. Two caveats. First, an earlier run that used Codex's bypass-hook-trust option together with the full-access sandbox did **not** honour the hook's exit-code-2 deny, so treat those options as switching enforcement off. Second, this was Bash on Linux; on Windows, Codex's shell is PowerShell, where the guard had a gap (`Set-Content -LiteralPath` slipped through) that is now fixed and unit-tested but not yet re-run live, because Codex's Windows shell failed to start in our test.

**What "✅" means for Codex's `--sandbox read-only`:** the flag itself is real — checked against `codex exec --help` on v0.157.1, and it's OpenAI's own OS-level sandbox (Seatbelt on macOS, Landlock/seccomp on Linux), the same category of mechanism as a container. We could not run the write-block probe end-to-end ourselves (no Codex account in our test environment), so if you're the first to run it, please still open an issue with the result — that turns "flag exists and is documented as a hard sandbox" into "we watched it block a write."

## Why skills alone can't enforce anything

A SKILL.md is text that goes into the model's context. Enforcement needs something that sits *between* the model and the tool:
- a harness permission system (Claude Code subagent `tools`, the Codex sandbox);
- a hook (Pi `tool_call`, git pre-commit);
- a process boundary (`pi --tools`, a container).

Agent Flow uses all three where they exist, and says plainly where they don't.
