# V3: Pi, OpenCode, no-hook harnesses (verified 2026-11-11)

Versions: Pi 1.5.2, OpenCode 2.0.20 (v2 only; `@opencode/plugin` 2.0.20 d.ts read). All live tests ran in temp dirs
under scratchpad\hv-oc-pi\ with PI_CODING_AGENT_DIR / HOME+XDG_* redirected and a local stub model (Pi: extension-registered
provider; OpenCode: local OpenAI-compatible HTTP stub on 127.0.0.1:18766). Zero real model calls. No user config touched.
Test assets: hv-oc-pi\pi\{guardsrc,pkg,rpc-test.mjs}, hv-oc-pi\oc\{stub-server.mjs,scripts,proj}.

## PI

| Q | Result | Evidence | Conf |
|---|---|---|---|
| tool_call fires for built-ins | write, edit, read, bash, grep, ls all fired (logged event.toolName + input). Unknown tool and schema-invalid args (write w/o content) do NOT fire tool_call (they also never execute). | BOTH (extensions.md "An unknown tool or invalid arguments skip tool_call") | high |
| MCP tools / subagents | Doc: "Every MCP call passes through Pi's tool pipeline... Extension tool_call handlers... apply to MCP tools" (mcp.md:254); nested calls via ctx.executeTool carry parentToolCallId. Pi has no built-in subagents; the example `subagent/` spawns a child `pi --mode json -p` process (see bypass below). MCP not run live. | DOC | med |
| Block | `return {block:true, reason}` -> tool not run, result isError=true with reason text (LIVE: "blocked by hv stub"). | BOTH | high |
| Handler throws | Call blocked (fail-safe); error message goes to model as the tool result (LIVE: "handler boom", isError). Doc: "tool_call errors block the tool". | BOTH | high |
| Extension that fails to LOAD (syntax error) | Pi printed "Error: Failed to load extension ..." and exited without running (fail closed). (Packages that fail to *install* at startup warn and are skipped: DOC packages.md.) | LIVE+DOC | med |
| Modes | print (-p), json, rpc: extensions load and fire. hasUI: false in print/json, true in rpc. ctx.mode = print/json/rpc. | BOTH | high |
| ctx.ui.confirm with no UI | Returns false, no throw (LIVE json mode, hasUI=false). In rpc: emits extension_ui_request; answering `confirmed:true` allows (LIVE). So "ask" in headless = deny unless the handler checks hasUI. | LIVE | high |
| **Project trust (big)** | Project-local `.pi/extensions` (and `.pi/settings.json` packages) are silently SKIPPED in print/json/rpc unless `--approve` or `defaultProjectTrust: "always"` (LIVE: untrusted dir, json and print: write of BLOCKME succeeded, guard never loaded; `--no-approve` same). `-e path` CLI extensions and user-level (agent dir) packages load regardless (LIVE). | BOTH (security.md "Project trust without an interactive prompt") | high |
| Disable verbs | `pi remove <src>`, `pi uninstall` (alias, exists), `pi list`, `pi config` (TUI), `--local/-l` for project scope. | DOC (cli.md) + `pi --help` LIVE | high |
| `-ne/--no-extensions` | Disables discovered+configured+built-in extensions; only explicit `-e` still load. LIVE: with -ne the write succeeded unguarded. | BOTH | high |
| PI_CODING_AGENT_DIR | Overrides config dir (settings.json, packages, auth). LIVE: pointing it elsewhere removes the user-level guard package. | BOTH | high |
| settings.json edit mid-session | NOT applied in the running session (LIVE rpc: packages emptied externally, next prompt still blocked). Applies at next start or `/reload` (interactive slash command; `/reload` sent as an RPC prompt did nothing). | LIVE+DOC | med |
| Agent's own bash/edit can alter it | Yes. LIVE: agent bash `echo {} > settings.json`; next start the guard was gone and the write succeeded. Pi tools run with user perms (security.md). So guard must treat settings.json, .pi/**, PI_CODING_AGENT_DIR paths as protected, and can still be bypassed via env/flags on next launch. | LIVE | high |
| Child pi processes (subagent pattern) | LIVE: bash-spawned `pi --mode json` child was blocked when the guard was a USER-LEVEL package, but UNGUARDED when the guard was only a project `.pi/extensions` file (child has no --approve, untrusted -> skipped). | LIVE | high |
| Audit fields | ctx.sessionManager.getSessionId(), ctx.model.{provider,id} (LIVE both present in tool_call handler); also env PI_SESSION_ID/PI_PROVIDER/PI_MODEL for shell children (environment-variables.md). | BOTH | high |
| Warn-on-paste input event | `pi.on("input", e)`: e.text, e.images, e.source ("interactive"|"rpc"|"extension"); can return {action:"transform"|"handled"|"continue"}. Fired live in json/rpc (source "interactive" for CLI arg, "rpc" for rpc). Fires before skill/template expansion. Cannot tell paste from typing. | BOTH | high |

## OPENCODE (v2.0.20)

Naming trap (LIVE, from the tool list the model receives): v2 tools are `shell` (not bash), `subagent` (not task), `edit`, `write`, `read`, `glob`, `grep`, `question`, `skill`, `webfetch`, `websearch`, `execute` (Code Mode JS runtime). File param is `path` (not filePath); edit uses oldString/newString; shell has `command`, `workdir`, `background`.

| Q | Result | Evidence | Conf |
|---|---|---|---|
| Block API | `ctx.tool.hook("execute.before", cb)` in a plugin `{id, setup(ctx)}`; throwing denies. LIVE: error text reaches the model as tool state error ("blocked by hv stub", "handler boom"), session continues. Payload: {tool, sessionID, agent, messageID, id, input (mutable)}. | BOTH (d.ts + live) | high |
| Which tools | Fired for write, edit, read, shell, glob, grep, subagent, execute. Child-session (subagent) tool calls also fire (LIVE: child `write` hit the hook and was blocked). Inner calls from `execute` Code Mode: built-ins are not exposed there ("Unknown tool 'write'"); MCP/registered tools inner-call hooking NOT verified. MCP direct calls: not run live (repo matrix claims covered). | LIVE (+partial) | high / med |
| Headless `opencode run` | Plugins load and fire in `opencode run --standalone` (all results above are headless). Default `opencode run` talks to a shared background service; did not test that path (used --standalone). | LIVE | high |
| Plugin load failure | Silent fail-OPEN. Syntax-error plugin and plugin throwing in setup: run proceeds, write succeeds, only a WARN in server log (`failed to load plugin plugin.id=thrower`, visible with --print-logs --log-level warn). | LIVE | high |
| Load locations | `.opencode/plugins/*.js|ts` (project and `~/.config/opencode/plugins`), plus `plugin` array in opencode.json(c); arrays merge low->high; `-id`, `-*` entries disable. Docs: two built-in policy plugins ignore removals "so a repository cannot switch off policy enforcement"; managed/system config (e.g. %ProgramData%\opencode) has highest precedence and cannot be overridden. | DOC | med |
| Bypass (project side) | LIVE: `OPENCODE_DISABLE_PROJECT_CONFIG=1` and `OPENCODE_CONFIG_PROJECT_DISABLE=1` (undocumented, found in binary strings) each silently skip the project plugin -> unguarded write. `OPENCODE_CONFIG_CONTENT='{"plugin":["-hv-guard"]}'` disables it too (control `{}` still guarded). `plugin:["-*"]` broke agent lookup (run error), not a clean bypass. | LIVE | high |
| Agent edits plugin mid-session | LIVE: OpenCode hot-reloads (file watcher). An agent `shell cp noop.js .opencode/plugins/hv-guard.js` in turn 2 removed the guard; turn-3 write succeeded. So `.opencode/**`, opencode.json* must be protected by the guard itself, and the guard must hook `shell`. | LIVE | high |
| Permission "ask" from plugin | `ctx.permission.hook("evaluate", e => { e.effect="ask"|"deny"|"allow"; e.message })`; evaluate fires per tool (action: edit/shell/..., resources: [path or command]). LIVE headless: `ask` -> auto-rejected ("non-interactive run cannot ask the user"); with `--auto` the same `ask` is auto-APPROVED; `deny` holds in both. => use deny, never ask, for guards. | LIVE | high |
| Fields | execute.before gives sessionID, agent, messageID, call id; no model. Model.Ref is on session.* request hooks (d.ts), so correlate by sessionID. | DOC (d.ts) | med |

## NO-HOOK HARNESSES: several now HAVE pre-tool hooks (only documented items)

| Harness | Pre-tool mechanism | Block semantics | Source |
|---|---|---|---|
| GitHub Copilot (VS Code, Copilot CLI, cloud agent) | `preToolUse` (+sessionStart, userPromptSubmitted, subagentStart/Stop, postToolUse); `.github/hooks/*.json`, `.github/copilot/settings.json`, `.claude/settings.json`, `~/.copilot/hooks/`. VS Code hooks are Preview; cloud agent supports a subset and does not auto-copy local hook files. | `{"permissionDecision":"deny","permissionDecisionReason":"..."}`; exit-code rules not detailed | https://code.visualstudio.com/docs/copilot/customization/hooks ; https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-hooks |
| Cline | Hooks exist: CLI `.cline/hooks/PreToolUse.sh`, `~/.cline/hooks/`, `--hooks-dir`; VS Code `.clinerules/hooks/`, `~/Documents/Cline/Hooks/` (search-result summary, not primary page). SDK plugins: `beforeTool` returning `{skip:true, reason}` or `{policy:{autoApprove:false}}`. Primary doc now points hooks to SDK plugins. | skip / approval policy (SDK); script output format for legacy hooks NOT verified | https://docs.cline.bot/sdk/plugins.md ; https://docs.cline.bot/customization/hooks |
| Windsurf (now docs.devin.ai) | Cascade hooks: `.devin/hooks.v1.json` project/user; "can block the command"; "Hooks neither load nor run while a workspace is open in Restricted Mode". Event names and exit-code semantics on the Windsurf page were NOT retrievable (page truncated). Devin CLI hooks (separate page): PreToolUse, exit 2 or `"decision":"block"`; reads `.claude/settings.json`. | exit 2 (Devin CLI page; Windsurf page unconfirmed) | https://docs.devin.ai/desktop/cascade/hooks ; https://docs.devin.ai/cli/extensibility/hooks/overview |
| Kiro | `PreToolUse`/`PostToolUse` hooks, "Can validate and block tool usage"; `.kiro/hooks/*.json` (v1), `~/.kiro/hooks/` (CLI V3); IDE and CLI both. Exact exit-code/output contract NOT found. | unverified mechanism | https://kiro.dev/docs/hooks/ ; https://kiro.dev/docs/hooks/types/ |
| Qoder | IDE/JetBrains: 12 events, PreToolUse blockable; `~/.qoder/settings.json`, `.qoder/settings.json`, `.qoder/settings.local.json`. CLI has separate hook docs (not read). | exit 2 blocks (stderr to model) or hookSpecificOutput permissionDecision deny | https://docs.qoder.com/extensions/hooks |
| Factory Droid | PreToolUse; `.factory/hooks.json`, `~/.factory/hooks.json`, `settings.json` "hooks"; enterprise `allowManagedHooksOnly: true` makes user/project hooks ignored. | exit 2 or hookSpecificOutput permissionDecision deny | https://docs.factory.com/cli/configuration/hooks-guide |
| Command Code | PreToolUse (shell, read, write, edit), PostToolUse, Stop, SessionStart; `.commandcode/settings.json`, `~/.commandcode/settings.json`. FAILS OPEN on crash/timeout/unparseable stdout. | exit 2 or permissionDecision deny | https://commandcode.ai/docs/hooks/reference |
| Swival | No hook found. Documents skills/MCP, command whitelists, OS sandboxes (AgentFS, nono), LLM-as-judge review loop. | n/a | https://swival.dev/ (pages/safety-and-sandboxing.html) |
| Augment (Auggie; not in TARGETS) | PreToolUse, exit 2 blocks, crash/timeout fails open; `/etc/augment/settings.json` and `C:\ProgramData\Augment\settings.json` system-level immutable. | exit 2 / deny | https://docs.augmentcode.com/cli/hooks |

## Implications for a harness-neutral guard design

1. One decision core + thin adapters is right, but adapters must normalise tool names per harness (OpenCode v2: shell/subagent/execute, path not filePath; Pi: bash/edit/write, `path`; Claude-style hooks: Bash/Write). Verify the CLI guard's tool_name mapping for `shell`.
2. Claude-format hooks are now the common denominator: Copilot (reads `.claude/settings.json`), Qoder, Factory, Command Code, Augment, Devin/Windsurf, Kiro all use PreToolUse + exit 2 / permissionDecision deny. A single stdin-JSON `agent-flow guard` command (exit 2 + stderr reason, plus permissionDecision JSON) can serve all; only the config file path and input field names differ. Re-classify these in HARNESS-MATRIX from "instructed" to "hook available, unverified live".
3. Fail-open is the norm: Command Code and Augment run the tool if the hook crashes/times out; OpenCode silently runs unguarded if the plugin fails to load; Pi project extensions are silently skipped when untrusted. Design for it: a startup self-check (`guard --check`) plus pre-commit/CI as the backstop; never claim enforcement without a live probe on that machine.
4. Pi: install the guard at USER level (`pi install npm:...` without -l) or pass `-e`; project-level `.pi/extensions` gives no protection for headless/pipeline runs or for child `pi` processes. Role-restricted runs should use `--tools`, `--no-approve` irrelevant, and set `defaultProjectTrust` only in agent dir.
5. Self-protection is mandatory: the agent's own shell/edit can rewrite Pi settings.json, `.opencode/plugins/*` (hot-reloaded mid-session!) and opencode.json. Guard rules must cover those paths and the shell command analysis must catch writes to them; env-var bypasses (OPENCODE_DISABLE_PROJECT_CONFIG, OPENCODE_CONFIG_CONTENT, PI_CODING_AGENT_DIR, `-ne`) are launcher-side, so the pipeline launcher must set/scrub env and flags.
6. Use deny, not ask: headless Pi confirm returns false; OpenCode `ask` is auto-rejected headless but auto-approved under `--auto`.
7. Strongest tamper-resistance available: OpenCode managed config/policy (system dir), Factory `allowManagedHooksOnly`, Augment system settings. Nothing equivalent found for Pi.
8. Audit: Pi gives session id + provider/model in-hook; OpenCode gives sessionID/agent/call id (model via session hooks).

## Could not verify

- Pi: MCP tool_call and `parentToolCallId` live; `pi config` TUI; interactive `/reload` effect on removed packages; Windows-specific behaviour of bash tool analysis.
- OpenCode: MCP and Code Mode inner-tool calls hitting execute.before; plugin hot-reload for global dir; managed/system policy dir enforcement (needs admin write); default (non-standalone) background-service path; OpenCode v1 plugin API (only v2 installed); model field in hook payload.
- Other harnesses: all docs-only, none run live. Windsurf event names/exit codes, Kiro blocking contract, Cline script-hook output format and Windows support, Qoder CLI, and whether Copilot VS Code honours exit code 2 were not confirmed from primary pages. Fetch summaries came from a small model and may drop detail; treat as leads to confirm.
