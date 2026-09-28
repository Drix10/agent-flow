# Launching each role

Read only the section for the harness you're running on. Every command assumes these variables, set once per issue from the repo root:

```bash
N=42                                            # issue number
A="$PWD/.agent-flow/artifacts/issue-$N"          # artifacts (absolute: some CLIs change directory)
WT=".worktrees/issue-$N"
AF="npx @drix10/agent-flow"
```

`R` is the current round. `FINDINGS` is the previous round's `review-r<R-1>.json` or `qa-r<R-1>.json`, or `none` in round 1. `MODEL` comes from the table in SKILL.md.

After every launch, validate the output. It extracts the JSON from whatever the harness printed and checks it against the role's schema:

```bash
$AF report <implementer|reviewer|qa> "$A/<role>-r$R.raw" --out "$A/<role>-r$R.json"
```

A non-zero exit means the report is malformed. Go to Needs Me with `malformed_report: <the problems it printed>`; don't guess what the role meant.

The flags below were checked against Claude Code 2.1.283, Codex CLI 0.157.1, Gemini CLI 0.61.0 and Pi's `--help`. If your version differs, check `--help` before relying on them.

---

## Claude Code

**Before the first launch**, confirm the guard hook is installed. It is what confines the Implementer to its worktree and blocks protected paths on every tool call. Without it, stop and ask the user to run `$AF install --harness claude`.

```bash
$AF guard --check
```

**Implementer.** `acceptEdits` lets it edit files and `--allowedTools Bash` lets it run tests and commit. The guard hook still vets every one of those calls.

```bash
AGENT_FLOW_ROLE=implementer AGENT_FLOW_WORKTREE="$WT" \
claude -p --model "$MODEL" --permission-mode acceptEdits --allowedTools Bash \
  --output-format json --json-schema "$(cat "$A/implementer.schema.json")" \
  "Use the implementer skill. Round $R. Issue: $A/issue.md. Worktree: $WT. Findings to address: $FINDINGS" \
  > "$A/implementer-r$R.raw"
```

**Reviewer.** `--agent reviewer` runs the session as `.claude/agents/reviewer.md`, and `--tools` removes every other tool. Both are enforced by Claude Code itself. (`--agents` is different: it takes a JSON definition, not a name.)

```bash
AGENT_FLOW_ROLE=reviewer \
claude -p --model "$MODEL" --agent reviewer --tools Read,Grep,Glob \
  --output-format json --json-schema "$(cat "$A/review.schema.json")" \
  "Round $R of $LIMIT. Packet: $A/ (issue.md, diff.patch, classification.json, implementer-r$R.json, and review-r$((R-1)).json if it exists). Worktree for reading context: $WT" \
  > "$A/review-r$R.raw"
```

**QA.** A shell plus read tools, no file-writing tools. The guard blocks mutating commands (best-effort), and SKILL.md's tree check catches anything that gets through.

```bash
AGENT_FLOW_ROLE=qa \
claude -p --model "$MODEL" --tools Bash,Read,Grep,Glob --allowedTools Bash \
  --output-format json --json-schema "$(cat "$A/qa-report.schema.json")" \
  "Use the qa skill. Issue $N. Worktree: $WT. Commands: $COMMANDS" \
  > "$A/qa-r$R.raw"
```

## Codex CLI

Codex runs each role with the worktree as its working root (`-C`), so its OS sandbox confines writes. The installed `.agents/skills/` and `.codex/` must be committed, because a worktree only contains what's committed. `--add-dir` makes the git directory writable so the Implementer can commit.

```bash
# Implementer
AGENT_FLOW_ROLE=implementer AGENT_FLOW_WORKTREE="$PWD/$WT" \
codex exec -m "$MODEL" -C "$WT" --sandbox workspace-write --add-dir "$(git rev-parse --git-common-dir)" \
  --output-schema "$A/implementer.schema.json" -o "$A/implementer-r$R.raw" \
  "Use the implementer skill. Round $R. Issue: $A/issue.md. Worktree: $PWD/$WT. Findings to address: $FINDINGS"

# Reviewer — read-only sandbox: OS-level, not a prompt
AGENT_FLOW_ROLE=reviewer \
codex exec -m "$MODEL" -C "$WT" --sandbox read-only \
  --output-schema "$A/review.schema.json" -o "$A/review-r$R.raw" \
  "Use the reviewer skill. Round $R of $LIMIT. Packet: $A/"

# QA — read-only sandbox too: tests that must write (caches, coverage) need workspace-write here instead
AGENT_FLOW_ROLE=qa \
codex exec -m "$MODEL" -C "$WT" --sandbox read-only \
  --output-schema "$A/qa-report.schema.json" -o "$A/qa-r$R.raw" \
  "Use the qa skill. Issue $N. Commands: $COMMANDS"
```

Codex's `-p` is `--profile`, not "prompt". The prompt is the positional argument.

## Gemini CLI

```bash
AGENT_FLOW_ROLE=implementer AGENT_FLOW_WORKTREE="$WT" gemini -m "$MODEL" --approval-mode auto_edit -o json -p "Use the implementer skill. …" > "$A/implementer-r$R.raw"
AGENT_FLOW_ROLE=reviewer gemini -m "$MODEL" --approval-mode plan -o json -p "Use the reviewer skill. …" > "$A/review-r$R.raw"
AGENT_FLOW_ROLE=qa gemini -m "$MODEL" -o json -p "Use the qa skill. …" > "$A/qa-r$R.raw"
```

`--approval-mode plan` is Gemini's documented read-only mode. Nothing here confines the Implementer to its worktree. Only the pre-commit hook enforces protected paths.

## Pi

The guard extension is active in every Pi process. `--tools` removes tools entirely.

```bash
AGENT_FLOW_ROLE=implementer AGENT_FLOW_WORKTREE="$WT" pi -p --model "$MODEL" "Use the implementer skill. …" > "$A/implementer-r$R.raw"
AGENT_FLOW_ROLE=reviewer pi -p --tools read,grep,find,ls --model "$MODEL" "Use the reviewer skill. …" > "$A/review-r$R.raw"
AGENT_FLOW_ROLE=qa pi -p --tools read,grep,find,ls,bash --model "$MODEL" "Use the qa skill. …" > "$A/qa-r$R.raw"
```

## Windows

In PowerShell, set variables with `$env:AGENT_FLOW_ROLE="implementer"` and clear them afterwards with `Remove-Item Env:AGENT_FLOW_ROLE, Env:AGENT_FLOW_WORKTREE`. Windows PowerShell 5.1's `>` writes UTF-16; `report` decodes it, so redirection works as shown.
