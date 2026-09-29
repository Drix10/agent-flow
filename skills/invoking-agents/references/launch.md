# Launching each role

Read "Setup" and "Every launch", then only the section for the harness you're running on. The commands use widely supported flags (verified with `--help` on Claude Code 1.x and 2.x, Codex CLI 0.158, Gemini CLI and Pi 0.87.x); where a newer flag is strictly better, the section says so. If your version rejects a flag, run `--help` and use the noted fallback.

## Setup (once per issue, from the repo root)

Many harness shells keep the working directory between tool calls but not variables or functions. So Step 0 writes every variable to a file, and each later command starts with `. .agent-flow/artifacts/issue-N/env.sh; R=<round>`.

```bash
N=42
mkdir -p ".agent-flow/artifacts/issue-$N"
model() { npx --no-install @drix10/agent-flow config get "pipeline.models.$1" 2>/dev/null; }
harness() { npx --no-install @drix10/agent-flow config get "pipeline.harness_by_role.$1" 2>/dev/null; }
cat > ".agent-flow/artifacts/issue-$N/env.sh" <<EOF
N=$N
ROOT="$PWD"                                   # main checkout: state, guard hook and node_modules live here
A="$PWD/.agent-flow/artifacts/issue-$N"       # absolute, because some CLIs change directory
WT="$PWD/.worktrees/issue-$N"                 # absolute worktree path, handed to every role
GIT_COMMON="$(git rev-parse --path-format=absolute --git-common-dir)"
AF="npx @drix10/agent-flow"
BASE=main                                     # "base" from \`worktree create --json\`
LIMIT=2                                       # "max_review_rounds" from \`state show --issue N --json\`
HARNESS_IMPLEMENTER="$(harness implementer)"   # "" = the harness you run on
HARNESS_REVIEWER="$(harness reviewer)"
HARNESS_QA="$(harness qa)"
FAST_MODEL="$(model fast)"
HIGH_MODEL="$(model high_reasoning)"
COMMANDS="npm test; npm run typecheck"        # from AGENTS.md, or none
ROLE_TIMEOUT=3600                             # wall-clock seconds per launch; the runner enforces it on every harness
CODEX_NET=                                    # 1 = network for Codex's Implementer/QA (lockfile installs)
EOF
```

What each one means, and why:

- **Models.** `pipeline.models.fast` and `pipeline.models.high_reasoning` in `CONTEXT_MANIFEST.json` are optional model IDs for the harness you run (`sonnet`/`opus` for Claude, a Codex or Gemini model name, a Pi pattern). When a key is missing the variable is empty, and every command below uses `${FAST_MODEL:+--model "$FAST_MODEL"}`, which drops the flag entirely. An empty `--model ""` would be an error; no flag means the harness's own default.
- **Harness per role.** `pipeline.harness_by_role` (optional) runs a role on a different harness than yours, for example `{"reviewer": "codex"}` so the Reviewer doesn't share the Implementer's model family and blind spots. For each launch use the section below for `HARNESS_<ROLE>` when it is set, otherwise the harness you run on, and pass that name to `report --harness`. The read-only launch of each section still applies to the Reviewer, so check the [harness matrix](../../../docs/HARNESS-MATRIX.md) before pointing the Reviewer at a harness whose read-only cell isn't ✅. A missing CLI or a failed login is `role_failed` → Needs Me, never a silent fallback to the Implementer's harness. On the last allowed round (`R` = `LIMIT`) the Implementer uses `HIGH_MODEL` when it is set.
- **`MODEL`** for a launch: `FAST_MODEL` for the Implementer and QA; for the Reviewer, `FAST_MODEL` when `reviewer_tier` is `fast` and `HIGH_MODEL` when it is `high-reasoning`.
- **`COMMANDS`**: the test, typecheck and lint commands exactly as `AGENTS.md` lists them, `;`-separated, or `none` when it lists none. QA reports `no_commands_defined` rather than invent one.
- **`FINDINGS`** (set per round, not in `env.sh`): `none` in round 1. Otherwise the absolute path of the report that ended the previous round: `$A/qa-r$((R-1)).json` if it exists (QA failed), else `$A/review-r$((R-1)).json`. It is absolute because the Implementer works from the worktree, not the repo root.

Then write the runner, once:

```bash
. ".agent-flow/artifacts/issue-$N/env.sh"
cat > "$A/run-role.mjs" <<'EOF'
// node run-role.mjs <base> <timeout-s> -- [KEY=VALUE…] <command> [args…]
// Detaches so the role outlives the tool call that started it. Writes <base>.argv/.pid/.raw/.err,
// then <base>.secs and, last, <base>.exit (124 = timed out). Same behaviour on Linux, macOS and Windows.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [base, secs, , ...rest] = process.argv.slice(2);
if (process.env.AF_SUPERVISED !== "1") {
  spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, AF_SUPERVISED: "1" } }).unref();
  process.exit(0);
}
const env = { ...process.env };
while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0] ?? "")) { const [k, ...v] = rest.shift().split("="); env[k] = v.join("="); }
delete env.AF_SUPERVISED;
writeFileSync(`${base}.argv`, JSON.stringify(rest));
const win = process.platform === "win32";
// Windows: run .exe directly (args intact); npm's .cmd shims (claude.cmd, codex.cmd) need cmd.exe, with every arg quoted.
const resolveWin = (cmd) => {
  if (/[\\/]/.test(cmd) || /\.[a-z]+$/i.test(cmd)) return cmd;
  for (const d of (process.env.PATH ?? "").split(";")) for (const e of (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")) {
    if (d && existsSync(join(d, cmd + e))) return join(d, cmd + e);
  }
  return cmd;
};
const exe = win ? resolveWin(rest[0]) : rest[0];
const q = (a) => `"${String(a).replace(/"/g, '""')}"`;
const start = Date.now();
let timedOut = false;
const out = (f) => openSync(`${base}.${f}`, "w");
const stdio = ["ignore", out("raw"), out("err")];
const child = win && /\.(cmd|bat)$/i.test(exe)
  ? spawn(`${q(exe)} ${rest.slice(1).map(q).join(" ")}`, { env, stdio, shell: true, windowsHide: true })
  : spawn(exe, rest.slice(1), { env, stdio, windowsHide: true });
writeFileSync(`${base}.pid`, String(child.pid));
const stop = () => (win ? spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]) : child.kill("SIGTERM"));
const kill = setTimeout(() => { timedOut = true; stop(); setTimeout(() => child.kill("SIGKILL"), 10000).unref(); }, Number(secs) * 1000);
const done = (code) => {
  clearTimeout(kill);
  writeFileSync(`${base}.secs`, String(Math.round((Date.now() - start) / 1000)));
  writeFileSync(`${base}.exit.tmp`, String(timedOut ? 124 : (code ?? 1)));
  renameSync(`${base}.exit.tmp`, `${base}.exit`);
};
child.on("error", () => done(127));
child.on("exit", done);
EOF
$AF schema --dir "$A"      # <role>.schema.json (Claude, validation) + <role>.strict.schema.json (Codex)
```

A node runner rather than `timeout`: GNU `timeout` isn't on macOS by default (Homebrew's coreutils installs it as `gtimeout`) or on Windows, and node is already required by agent-flow. From PowerShell, call it the same way: `node "$A\run-role.mjs" "$A\implementer-r$R" 3600 -- AGENT_FLOW_ROLE=implementer claude -p …`. On Windows the command runs through a shell so `.cmd` shims resolve; if a JSON-valued argument gets mangled there, run the orchestrator from WSL or Git Bash.

## Every launch

The orchestrator's own shell tool times out long before a role finishes (Claude Code's Bash tool: 2 minutes by default, 10 at most), so never run a role in the foreground. For each launch:

1. **Start it** with the runner: `node "$A/run-role.mjs" "$A/<role>-r$R" "$ROLE_TIMEOUT" -- <env> <command>`. It returns at once.
2. **Wait** with short checks, each well under your shell timeout: `sleep 60; cat "$A/<role>-r$R.exit" 2>/dev/null || echo running`. Repeat until it prints a number.
3. **Validate and log**, whatever the exit code. This extracts the JSON from the harness output, checks it against the role schema, and appends a `role_run` line to `.agent-flow/audit.jsonl` with the argv, exit code, duration, and the cost/turns/tokens the harness reported:

   ```bash
   $AF report <role> "$A/<role>-r$R.raw" --out "$A/<role>-r$R.json" --json \
     --harness <claude|codex|gemini|pi> --model "$MODEL" --issue "$N" --round "$R" \
     --exit "$(cat "$A/<role>-r$R.exit")" --seconds "$(cat "$A/<role>-r$R.secs")" --argv-file "$A/<role>-r$R.argv"
   ```

   On Codex, pass `"$A/<role>-r$R.last"` (the `-o` file) instead of `.raw`; `.raw` holds Codex's progress log. `<role>` is `implementer`, `reviewer` or `qa`, but the files are named `implementer-rR`, `review-rR` and `qa-rR`.
4. **Route on the result:**
   - exit `124` → Needs Me, `role_timeout`. Don't relaunch; a role that needed an hour will need it again.
   - `problems` starting with `harness error:` (turn or budget cap, auth, crash) → Needs Me, `role_failed`, with that text.
   - otherwise invalid → **one** retry, with the validator's problems fed back (below). Invalid again → Needs Me, `malformed_report`, with the problems.

**The retry.** On Claude, resume the same session so the work isn't repeated: the same command with `--resume <session>` (the `harness.session_id` that `report --json` printed) and the prompt `Your report was rejected by the validator: <problems>. Print only the corrected JSON report.` Elsewhere, relaunch the same command with that sentence appended to the prompt. An Implementer relaunched this way finds its commit already on the branch and only has to report it.

**Crash check.** If a `.pid` file exists but `.exit` doesn't, the role may still be running: `kill -0 "$(cat "$A/<role>-r$R.pid")"` (PowerShell: `Get-Process -Id …`). Alive → keep waiting. Gone with no `.exit` → the runner itself died (reboot, killed session); relaunch that one step.

---

## Claude Code

**Before the first launch**, confirm the guard hook is installed: `$AF guard --check`. The hook is what confines the Implementer to its worktree and blocks protected paths on every tool call. Without it, stop and ask the user to run `$AF install --harness claude`.

Every role runs with **the repo root as its working directory**, not the worktree. The hook command is `node "$CLAUDE_PROJECT_DIR/node_modules/@drix10/agent-flow/…" guard`: started from a fresh worktree, `CLAUDE_PROJECT_DIR` would point at a checkout with no `node_modules`, the hook would fail to start, and a failing hook is not a blocking one. So the prompt hands each role the absolute worktree path and it `cd`s there; Claude Code keeps a `cd` for later Bash calls as long as it stays inside the project directory, which the worktree is. That's also why no `--add-dir` is needed.

Read-only enforcement is `--permission-mode plan` (edits need an approval nobody is there to grant) plus `--disallowedTools` (the deny-list), plus the guard hook above — which is the part that actually blocks. Where the CLI offers it, `--agent reviewer` with `--tools Read,Grep,Glob` is stronger (an allow-list instead of a deny-list); prefer that.

**Implementer.** `acceptEdits` lets it edit files. `--allowedTools` pre-approves the shell (tests, commit) and the `Skill` tool, which otherwise needs a permission nobody is there to grant in `-p` mode. The guard hook still vets every call. `ROLE_TIMEOUT` (the runner) is the budget; hitting it ends the run with exit 124.

```bash
node "$A/run-role.mjs" "$A/implementer-r$R" "$ROLE_TIMEOUT" -- \
  AGENT_FLOW_ROLE=implementer AGENT_FLOW_WORKTREE="$WT" \
  claude -p ${FAST_MODEL:+--model "$FAST_MODEL"} \
  --permission-mode acceptEdits --allowedTools Bash,Skill \
  --output-format json \
  "Use the implementer skill. Round $R. Issue: $A/issue.md. Worktree: $WT (cd into it first). Findings to address: $FINDINGS"
```

**Reviewer.** `plan` mode plus a deny-list: no edits, no shell, no skill-loading (the prompt points at the skill file, which it reads). Both are enforced by Claude Code itself, and the guard hook blocks anything they miss.

```bash
node "$A/run-role.mjs" "$A/review-r$R" "$ROLE_TIMEOUT" -- \
  AGENT_FLOW_ROLE=reviewer \
  claude -p ${MODEL:+--model "$MODEL"} \
  --permission-mode plan --disallowedTools Write,Edit,MultiEdit,NotebookEdit,Bash,Skill \
  --output-format json \
  "Round $R of $LIMIT. Read .claude/skills/reviewer/SKILL.md and follow it. Packet: $A/ (issue.md, diff.patch, classification.json, implementer-r$R.json, and review-r$((R-1)).json if it exists). Worktree for reading context: $WT"
```

**QA.** A shell and read tools, no file-writing tools. Unlisted tools need an approval nobody is there to grant in `-p` mode, so they are denied; the guard blocks mutating commands (best effort), and SKILL.md's tree check catches anything that gets through.

```bash
node "$A/run-role.mjs" "$A/qa-r$R" "$ROLE_TIMEOUT" -- \
  AGENT_FLOW_ROLE=qa \
  claude -p ${FAST_MODEL:+--model "$FAST_MODEL"} \
  --allowedTools Bash,Skill \
  --output-format json \
  "Use the qa skill. Issue $N. Worktree: $WT (cd into it first). Commands: $COMMANDS"
```

## Codex CLI

Codex runs each role with the worktree as its working root (`-C`), so its OS sandbox confines writes to it. The installed `.agents/skills/` must be committed, because a worktree only contains what's committed. `--add-dir "$GIT_COMMON"` makes the repository's git directory writable so the Implementer can commit.

`--output-schema` uses OpenAI's strict structured outputs: every object closed and every key required. That's what the `.strict.schema.json` files are (verified: Codex accepts them and `report` validates the result, reading their `null`s as "absent"). The canonical schemas would be rejected before the role did any work.

Codex has no turn cap, so `ROLE_TIMEOUT` is the budget. Its `workspace-write` sandbox has no network by default; set `CODEX_NET=1` when the worktree needs a lockfile install, knowing that also gives the role network access.

```bash
# Implementer
node "$A/run-role.mjs" "$A/implementer-r$R" "$ROLE_TIMEOUT" -- \
  AGENT_FLOW_ROLE=implementer AGENT_FLOW_WORKTREE="$WT" \
  codex exec ${FAST_MODEL:+-m "$FAST_MODEL"} -C "$WT" --sandbox workspace-write --add-dir "$GIT_COMMON" \
  ${CODEX_NET:+-c sandbox_workspace_write.network_access=true} \
  --output-schema "$A/implementer.strict.schema.json" -o "$A/implementer-r$R.last" \
  "Use the implementer skill. Round $R. Issue: $A/issue.md. Worktree: $WT. Findings to address: $FINDINGS"

# Reviewer: read-only sandbox, enforced by the OS, not a prompt
node "$A/run-role.mjs" "$A/review-r$R" "$ROLE_TIMEOUT" -- \
  AGENT_FLOW_ROLE=reviewer \
  codex exec ${MODEL:+-m "$MODEL"} -C "$WT" --sandbox read-only \
  --output-schema "$A/review.strict.schema.json" -o "$A/review-r$R.last" \
  "Use the reviewer skill. Round $R of $LIMIT. Packet: $A/"

# QA: workspace-write, because test runners write caches, coverage and node_modules; read-only
# turns those into false failures. The before/after tree check in SKILL.md catches real mutation.
node "$A/run-role.mjs" "$A/qa-r$R" "$ROLE_TIMEOUT" -- \
  AGENT_FLOW_ROLE=qa \
  codex exec ${FAST_MODEL:+-m "$FAST_MODEL"} -C "$WT" --sandbox workspace-write \
  ${CODEX_NET:+-c sandbox_workspace_write.network_access=true} \
  --output-schema "$A/qa-report.strict.schema.json" -o "$A/qa-r$R.last" \
  "Use the qa skill. Issue $N. Commands: $COMMANDS"
```

Codex's `-p` is `--profile`, not "prompt". The prompt is the positional argument. `.codex/agents/reviewer.toml` is a custom-agent definition Codex spawns only when a session explicitly asks for it; the pipeline doesn't need it, because the read-only sandbox above is the enforcement.

## Gemini CLI

Gemini has no working-directory flag, so roles start from the repo root and `cd` into the worktree path they're given. In `-p` mode any tool that would ask for confirmation is denied, and the shell always asks. The Implementer and QA need a shell (tests, commit), so they run with `--approval-mode yolo`, which approves every tool call. Be plain with the user about what that means: on Gemini **nothing confines the Implementer or QA while they run**. Only the pre-commit hook (protected paths, secrets, at commit time) and QA's before/after tree check contain them. The Reviewer runs at the default approval mode (this version offers `default`, `auto_edit` and `yolo` only — no read-only `plan`): read tools don't ask, so they work, while writes and the shell would ask and are denied headless.

Headless Gemini exits with a fatal error in an untrusted folder. Have the user trust the repo once (`/trust` in an interactive session), or add `--skip-trust` to these commands. Gemini has no per-launch turn flag (the `model.maxSessionTurns` setting ends a run with exit code 53), so `ROLE_TIMEOUT` is the budget.

```bash
node "$A/run-role.mjs" "$A/implementer-r$R" "$ROLE_TIMEOUT" -- AGENT_FLOW_ROLE=implementer AGENT_FLOW_WORKTREE="$WT" \
  gemini ${FAST_MODEL:+-m "$FAST_MODEL"} --approval-mode yolo \
  -p "Use the implementer skill. Round $R. Issue: $A/issue.md. Worktree: $WT (cd into it first). Findings to address: $FINDINGS"
node "$A/run-role.mjs" "$A/review-r$R" "$ROLE_TIMEOUT" -- AGENT_FLOW_ROLE=reviewer \
  gemini ${MODEL:+-m "$MODEL"} \
  -p "Use the reviewer skill. Round $R of $LIMIT. Packet: $A/. Worktree for reading context: $WT"
node "$A/run-role.mjs" "$A/qa-r$R" "$ROLE_TIMEOUT" -- AGENT_FLOW_ROLE=qa \
  gemini ${FAST_MODEL:+-m "$FAST_MODEL"} --approval-mode yolo \
  -p "Use the qa skill. Issue $N. Worktree: $WT (cd into it first). Commands: $COMMANDS"
```

This version has no `-o` flag, so the role's raw text goes straight to `report`, which extracts the fenced or last JSON object and validates it (stats/tokens aren't reported for Gemini here). `.gemini/agents/reviewer.md` is for delegating a review from an interactive Gemini session (`@reviewer …`); the pipeline launches the Reviewer as its own `plan`-mode process instead, because that mode is the enforcement.

## Pi

The guard extension is active in every Pi process. `--tools` is an allowlist: tools not named don't exist in that process. These flags come from `pi --help` (0.87.1); run it once, and if they differ on your version, follow the Claude Code pattern (tool allowlist per role) with whatever Pi now calls them. If the agent-flow package was installed project-locally (`pi install -l`), add `--approve` so a headless run loads it.

```bash
node "$A/run-role.mjs" "$A/implementer-r$R" "$ROLE_TIMEOUT" -- AGENT_FLOW_ROLE=implementer AGENT_FLOW_WORKTREE="$WT" \
  pi -p ${FAST_MODEL:+--model "$FAST_MODEL"} "Use the implementer skill. Round $R. Issue: $A/issue.md. Worktree: $WT (cd into it first). Findings to address: $FINDINGS"
node "$A/run-role.mjs" "$A/review-r$R" "$ROLE_TIMEOUT" -- AGENT_FLOW_ROLE=reviewer \
  pi -p --tools read,grep,find,ls ${MODEL:+--model "$MODEL"} "Use the reviewer skill. Round $R of $LIMIT. Packet: $A/. Worktree for reading context: $WT"
node "$A/run-role.mjs" "$A/qa-r$R" "$ROLE_TIMEOUT" -- AGENT_FLOW_ROLE=qa \
  pi -p --tools read,grep,find,ls,bash ${FAST_MODEL:+--model "$FAST_MODEL"} "Use the qa skill. Issue $N. Worktree: $WT (cd into it first). Commands: $COMMANDS"
```

## Windows

Run `env.sh` and the commands above from Git Bash or WSL where you can. In PowerShell, set the same variables with `$N = 42`, `$A = "$PWD\.agent-flow\artifacts\issue-$N"` and so on, pass role variables to the runner as `KEY=VALUE` arguments exactly as above (it sets them for the child only), and replace `${X:+--model "$X"}` with an `if ($X) { '--model', $X }` array. Windows PowerShell 5.1's `>` writes UTF-16; `report` decodes it.
