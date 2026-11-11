# V2: pre-tool hook semantics, Codex / Gemini CLI / Cursor (verified 2026-11-11)

Versions: codex-cli 0.163.0, gemini 0.62.0, Cursor 3.11.19 (GUI only; no cursor-agent CLI installed).
Test dirs: scratchpad/hv-other/{codex1,gem1,shared}. Stub = shared/stub.js (logs stdin, mode.json drives exit/stdout/stderr/sleep/crash).
No user config modified. Note: user's own ~/.codex/hooks.json (tracekit tracer, passive) also loaded during codex runs.

LIVE LIMITS: Codex account hit its usage limit (every model call errors "usage limit ... Nov 26"), Gemini API unreachable
("fetch failed"/503). So NO tool-call (PreToolUse/BeforeTool) live test was possible for either. Live tests used the
pre-model prompt hooks (Codex UserPromptSubmit, Gemini BeforeAgent), which share the hook runner/exit semantics, plus
codex app-server `hooks/list` (no model) and reading the installed Gemini bundle source.

## CODEX (docs: https://learn.chatgpt.com/docs/hooks, redirected from developers.openai.com/codex/hooks)

| Q | Result | Evidence | Conf |
|---|---|---|---|
| 1 events/config/matcher | Events: PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, UserPromptSubmit, SubagentStart/Stop, Stop, SessionStart/End, Interrupt, PreModelRequest/PostModelRequest. Config: ~/.codex/hooks.json, ~/.codex/config.toml, <repo>/.codex/hooks.json, <repo>/.codex/config.toml (all sources merged: "Codex loads all matching hooks"). JSON shape {"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"...","timeout":10}]}]}}. Matcher = regex on tool name; "*", "" or omitted = all. UPS/Stop/Interrupt take no matcher. | BOTH (project .codex/hooks.json loaded live via hooks/list; UPS fired) | high |
| 2 exit codes/JSON | Doc: exit 0 ok (JSON or silent); exit 2 = block, reason on stderr; PreToolUse JSON `permissionDecision:"deny"` (+reason) or allow (+updatedInput); `decision:"block"` for UPS/PostToolUse/Stop. LIVE on UserPromptSubmit: JSON {"decision":"block"} -> "Blocked", model never called. exit 1, crash, timeout, exit 0 + non-JSON -> "Failed"/"Completed", run PROCEEDS (fail open). SURPRISE: exit 2 (with and without stderr text, sync write) -> "Failed", proceeded (usage-limit error from model still appeared), i.e. exit 2 did NOT block on UPS in 0.163/Windows. PreToolUse exit 2 not live-tested. Missing script not separately tested (crash = fail open). | BOTH | UPS: high; PreToolUse exit 2: doc-only, med |
| 3 ask | PreToolUse has no ask: deny/allow only. Separate PermissionRequest event returns behavior allow|deny. Headless: approval is "never" by default in exec, no ask path. | DOC | med |
| 4 timeout | Default 600 s (SessionEnd/Interrupt 1 s, max 3 s); `timeout` in seconds. LIVE (UPS, timeout 10, sleep 12): "Failed", run proceeds = fail open. | BOTH | high (UPS) |
| 5 trust | Hook-level trust by hash: "Before a non-managed hook can run, Codex requires you to review and trust the exact hook definition." app-server hooks/list shows my project hook trustStatus=untrusted (values: managed/untrusted/trusted/modified). LIVE: in exec, untrusted project hook did NOT run (no log, no "hook:" line). `--dangerously-bypass-hook-trust` makes it run. Project dir need not be "trusted" for hooks to be listed. Kill switches: `[features] hooks=false` / `--disable hooks`; managed hooks via requirements.toml (`allow_managed_hooks_only=true` ignores user+project hooks). `--dangerously-bypass-approvals-and-sandbox` does not disable hooks per docs (permission_mode shows bypassPermissions in stdin); not live-tested with a tool call. | BOTH | high |
| 6 tools | Doc: Bash, apply_patch (matches apply_patch/Edit/Write), MCP tools (mcp__server__tool), local function tools (update_plan, spawn_agent). Gaps: hosted WebSearch "does not use the local function-tool hook path"; write_stdin does not re-fire PreToolUse. Older versions (Apr 2026) were Bash-only. | DOC (+3rd-party blogs) | med |
| 7 stdin | LIVE (UPS): session_id, turn_id, transcript_path, cwd, hook_event_name, model, permission_mode, prompt. PreToolUse adds tool_name/tool_input per docs. | BOTH | high |
| 8 before-prompt | UserPromptSubmit: block via decision:"block"; systemMessage warns; additionalContext supported. LIVE ok. | BOTH | high |
| 9 exec parity | LIVE: `codex exec` runs UPS hooks the same as interactive (trust gating, JSON block, status lines). PreToolUse in exec not live-tested. | LIVE | med |

## GEMINI CLI (docs: https://geminicli.com/docs/hooks/ , /hooks/reference/ , /cli/trusted-folders/ ; plus installed bundle source)

| Q | Result | Evidence | Conf |
|---|---|---|---|
| 1 | Events: SessionStart/End, BeforeAgent, AfterAgent, BeforeModel, AfterModel, BeforeToolSelection, BeforeTool, AfterTool, PreCompress, Notification. Config: .gemini/settings.json (project), ~/.gemini/settings.json, /etc/gemini-cli/settings.json, extensions. Shape {"hooks":{"BeforeTool":[{"matcher":"regex","hooks":[{"type":"command","name":"x","command":"...","timeout":ms}]}]}}. Tool matchers = regex on tool name (read_file, write_file, replace, run_shell_command, mcp_<server>_<tool>); lifecycle matchers exact strings; "*" or "" = all. | BOTH (project settings.json hooks loaded, BeforeAgent fired) | high |
| 2 exit codes | Doc: 0 = stdout parsed as JSON; 2 = block, stderr = reason; other = warning, proceeds. Source (hookRunner): JSON is parsed from stdout (else stderr) REGARDLESS of exit code. If non-JSON text: exit 0 -> allow; exit 1 -> allow + warning; any other code (2,3,..) -> DENY with the text as reason. If stdout+stderr both empty, no output -> ALLOWED even with exit 2. LIVE (BeforeAgent): exit 2 + stderr -> "blocked: <reason>"; exit 3 + stderr -> blocked; exit 2 with NO output -> NOT blocked (went on to model); exit 1 -> warning, proceeds; JSON {"decision":"deny"} blocks even with exit 0 or 1; missing script (node exits 1) -> proceeds; crash -> proceeds. Decision values deny|block (alias) |allow|ask; `continue:false` stops the whole agent loop. For BeforeTool deny: reason returned to model as tool error "Tool execution blocked: ...". | BOTH (BeforeAgent live; BeforeTool by source+doc) | high for semantics, BeforeTool not live |
| 3 ask | Source: BeforeTool decision:"ask" forces ASK_USER confirmation even if policy allowed (hook ask overrides; systemMessage shown). Policy engine in non-interactive mode defaults to DENY for ask_user (nonInteractive ? DENY : ASK_USER), so headless ask likely = deny/blocked; not live-tested. Whether --yolo auto-approves a hook-forced ask: source suggests forcedDecision ask_user is still sent to confirmation; untested. | DOC/SRC | low-med |
| 4 timeout | Default 60000 ms, `timeout` in ms. LIVE: timeout -> "Hook timed out after 10000ms", hook marked failed, run PROCEEDS (fail open). | BOTH | high |
| 5 trust | Project hooks are fingerprinted (name+command); a changed hook is "new, untrusted" with a warning. Folder trust (security.folderTrust) restricts hooks/env/MCP in untrusted folders; headless cannot show dialog; bypass `--skip-trust` or GEMINI_CLI_TRUST_WORKSPACE=true. LIVE: in my fresh temp folder, headless `gemini -p` ran project hooks with no prompt and no flag (folder trust apparently not enabled in this user's settings; default is off), so the default is: project hooks RUN. Kill switches: `/hooks disable-all`, disabledHooks list, config enableHooks (default true; settings key not verified), enterprise /etc/gemini-cli/settings.json and --admin-policy. `--yolo` is approval mode; source shows executeToolWithHooks is independent of approval mode (so BeforeTool still runs under yolo) but not live-tested. | BOTH/SRC | med |
| 6 tools | BeforeTool fires for built-ins (read_file, write_file, replace, run_shell_command ...) and MCP tools; scheduler path and executeToolWithHooks both fire it. Gaps/subagents: not documented. | DOC+SRC | med |
| 7 stdin | LIVE (BeforeAgent): session_id, transcript_path, cwd, hook_event_name, timestamp, prompt. BeforeTool per docs: tool_name, tool_input, mcp_context, original_request_name + base fields. Env: GEMINI_PROJECT_DIR, GEMINI_SESSION_ID, GEMINI_CWD, CLAUDE_PROJECT_DIR. No model field. | BOTH | high |
| 8 before-prompt | BeforeAgent: deny discards the prompt; additionalContext appended; systemMessage warns. LIVE ok. | BOTH | high |
| 9 | n/a (headless `gemini -p` runs hooks, LIVE for BeforeAgent). | LIVE | high |

## CURSOR (docs: https://cursor.com/docs/hooks ; forum bug reports). Docs-only, no headless CLI installed, GUI not testable.

| Q | Result | Evidence | Conf |
|---|---|---|---|
| 1 | Pre-action events: preToolUse, beforeShellExecution, beforeMCPExecution, beforeReadFile, subagentStart, beforeSubmitPrompt (+ observational after*). Config: <project>/.cursor/hooks.json, ~/.cursor/hooks.json, enterprise (Windows C:\ProgramData\Cursor\hooks.json), team; priority Enterprise>Team>Project>User. Shape {"version":1,"hooks":{"preToolUse":[{"command":"./x.sh","matcher":"Shell","timeout":N,"failClosed":true}]}}. Matcher regex; preToolUse matches tool type (Shell, Read, Write, MCP:<name>); beforeShellExecution matches command text. Hot reload on save. | DOC | high |
| 2 exit codes | exit 0 = use JSON (invalid JSON blocks permission hooks); exit 2 = deny; other codes FAIL OPEN unless failClosed:true. JSON {"permission":"allow|deny|ask","user_message","agent_message","updated_input"}. | DOC | high (doc) / med (real) |
| 3 ask | beforeShellExecution supports ask (prompts user). preToolUse: "ask" NOT enforced. Forum: ask ignored when sandboxed shell runs; "Hook ASK output not stopping agent". Headless: no spec; beforeSubmitPrompt not run in CLI -p. | DOC+forum | med |
| 4 timeout | "platform default", per-hook seconds; failures (incl timeout) allow unless failClosed:true. Forum: lowering timeout on Windows CLI silently disables deny-hooks. | DOC+forum | med |
| 5 trust | Project hooks require a trusted workspace; user/enterprise run regardless. Disable: remove hooks.json; enterprise hooks take priority. | DOC | med |
| 6 tools | preToolUse covers Shell, Read, Write, Grep, Delete, Task, MCP. Known gaps (forum): built-in Web search does not fire; AskQuestion tool skips; subagentStart/Stop flaky; empty stdin on remote Linux workspaces; cloud agents do not support beforeMCPExecution. | DOC+forum | med |
| 7 stdin | Base: conversation_id, generation_id, model, hook_event_name, cursor_version, workspace_roots, user_email, transcript_path; preToolUse adds tool_name, tool_input, tool_use_id, cwd; beforeShellExecution adds command, cwd, sandbox. Windows: PowerShell runs command; stdin has UTF-8 BOM (strip \uFEFF or JSON.parse throws -> guards fail open). | DOC+forum | high |
| 8 before-prompt | beforeSubmitPrompt: only {"continue":false,"user_message"} block, cannot rewrite. Not fired in CLI print mode; enterprise/team ones not run in CLI. | DOC+forum | med |
| 9 headless | Cursor CLI (cursor-agent) hook support partial: beforeShellExecution, afterShellExecution, afterFileEdit, postToolUse, stop, sessionStart; Windows+Git Bash ancestry: hooks never run and tool call reports "Hook blocked" (fail closed, bug acknowledged); user-level hooks not run in interactive Windows CLI 2026.08.11. | forum | med |

## Implications for a harness-neutral guard design
- Do NOT rely on "exit 2 blocks" alone. Safest universal block signal = print JSON deny on stdout AND write reason to stderr AND exit 2. Per-tool: Codex (JSON permissionDecision deny; UPS exit 2 did not block live), Gemini (JSON decision deny works for any exit code; bare exit 2 with empty output does NOT block), Cursor (JSON permission deny or exit 2).
- Every harness fails OPEN on crash, missing script, timeout, bad exit code (Cursor needs failClosed:true; Cursor invalid JSON on permission hooks is the one fail-closed case). Design: guard script must catch all exceptions and itself emit the deny; wrap in try/catch -> deny for guarded cases.
- Windows stdin pitfalls: Cursor BOM; write stderr synchronously before exit (process.exit can truncate pipes).
- Trust: Codex project hooks are inert until trusted (hash) -> `agent-flow init` must tell user to run /hooks trust or the guard silently does nothing; hash changes invalidate trust. Gemini runs project hooks by default (unless folderTrust on). Cursor needs trusted workspace.
- Kill switches exist everywhere (codex --disable hooks / --dangerously-bypass-hook-trust; gemini /hooks disable-all; cursor delete file). A guard is advisory vs a deliberate user; use managed/enterprise config only for hard enforcement.
- Tool coverage differs: normalize tool names (Bash / run_shell_command / Shell) and treat file edits separately (Codex apply_patch, Gemini write_file/replace, Cursor Write). Hosted web search, AskQuestion are unhooked.
- 'ask' is not portable: Codex PreToolUse none, Cursor preToolUse unenforced, Gemini ask->deny headless. Use deny with a message instead; warn-on-paste uses UPS (Codex), BeforeAgent (Gemini), beforeSubmitPrompt (Cursor; not in CLI -p).
- stdin schema: Codex has session_id/cwd/model/tool_name/tool_input; Gemini no model; Cursor workspace_roots and conversation_id instead of session_id. Adapter must map.

## Not verified
- Any live PreToolUse/BeforeTool/beforeShellExecution run (Codex usage-limited, Gemini API unreachable, Cursor GUI-only).
- Codex PreToolUse exit-2 block (UPS exit 2 did not block, contradicting doc); missing-script on Codex; --dangerously-bypass-approvals-and-sandbox vs hooks.
- Gemini yolo + hooks, headless ask behavior, folder-trust-enabled behavior, hooksConfig key name.
- All Cursor behavior (doc/forum only).
