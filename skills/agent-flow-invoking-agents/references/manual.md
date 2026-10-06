# Manual orchestration

The step-by-step procedure for harnesses without `agent-flow run`, or when the CLI cannot be used. `AF` means `npx @drix10/agent-flow`. Read `launch.md` "Setup", "Every launch" and your harness section first. Do not mix this with the CLI for one issue.

## Step 0: Prepare

1. **Issue.** The first available source wins:
   - `gh issue view N --json number,title,body,labels` (needs `gh auth status` to pass);
   - `ISSUES.md` or `.agent-issues.json` at the repo root;
   - title and acceptance criteria written inline by the user. These have no number: use the lowest integer ≥ 100000 that `AF state show --json` doesn't list.

   Write it to `.agent-flow/artifacts/issue-N/issue.md` inside `<untrusted_issue number="N"> … </untrusted_issue>`, escaping `&`, `<` and `>` in the title and body before inserting them. Write the title alone to `title.txt` beside it; the PR title is read from that file, never typed into a command. No testable acceptance criteria → Needs Me (`SPEC_ERROR`) now; don't let the Implementer guess.
2. **State.** `AF state show --issue N --json`:
   - `Completed` → stop and tell the user (reopening is their call).
   - `Needs Me` → show the reason and ask how to proceed.
   - `Working` → a previous orchestrator stopped mid-run. Go to "Resuming" below instead of starting round 1.
   - nothing yet → continue.

   Note `max_review_rounds` as `LIMIT`. If it is below 1, the state machine escalates round 1 before any work happens; stop and ask the user to set it to at least 1 rather than launching anything.
3. **Worktree.** `AF worktree create N --json` → `.worktrees/issue-N` on `agent/issue-N`. Its `base` is the branch every later step diffs and PRs against. Don't assume `main`.
4. **Launch setup.** Write `env.sh`, the runner and the schemas as launch.md "Setup" shows. From here on, begin every command with `. .agent-flow/artifacts/issue-N/env.sh; R=<round>`.

## Resuming

A `Working` issue has a stored `round` and `phase`. Set `R` to that round (the state machine refuses to go backwards, so never re-open round 1), then re-enter at the stored phase. Skip a launch only if its role finished *before* that phase, i.e. its validated `<role>-rR.json` exists and the table says it is done. A report from the phase you are re-entering is not trusted: that is what lets a person send an escalated issue back to `implement` and get every role run again, instead of a rejected result replayed:

| Stored phase | Re-enter at |
|---|---|
| `implement` | 1b (nothing from this round is reused) |
| `review` | 1b is done (reuse `implementer-rR.json`); 1d runs again |
| `qa` | 1b and 1d are done (reuse both reports); 1e runs again |
| `publish` | everything is done; re-check gates, then Step 2 |

On re-entry into round R+1, `FINDINGS` is the report that ended round R (the failing `qa-r`, else `gates-r`, else `review-r`, else the `dirty-` or `policy-` note), not `none`. A launch with a `.pid` but no `.exit` may still be running: use the crash check in launch.md before relaunching it. Recording the same phase and round again is allowed, so repeating a `state update` you can't remember making is harmless.

## Step 1: The round loop

Rounds start at 1. Every round is: implement → classify → review → (if approved) QA. A rejected review or a failed QA that the Implementer can fix starts round R+1 with that report as `FINDINGS`.

Each launch below follows launch.md "Every launch": start it in the background, wait, then run `AF report` (which also writes the audit line). A timeout is Needs Me (`role_timeout`), a run the harness itself failed is Needs Me (`role_failed`), and a malformed report gets one retry with the validator's problems before it becomes Needs Me (`malformed_report`).

**1a. Open the round.**

```bash
AF state update --issue N --state Working --phase implement --round R --json
```

Exit code 3 means the round cap was hit and the issue is now Needs Me. Stop, and go to Escalation. You don't decide whether another round is allowed; the state machine does.

**1b. Implementer.** Launch it with `FINDINGS` as launch.md defines it and validate it as `implementer`. If its `status` is `needs_me`, record Needs Me with its `what_failed` and `suggested_next_step` as the reason, and stop.

**1c. Check the branch, then classify** (mechanical, and authoritative). First `git -C "$WT" status --porcelain`: anything the Implementer left uncommitted would be reviewed here but missing from the pushed branch, so it is a round R+1 with a note listing those files as the findings (`dirty-rR.json`). Then:

```bash
AF classify --issue N --json > "$A/classification.json"
git -C "$WT" diff "$BASE...HEAD" > "$A/diff.patch"
```

An empty `files` list means the branch changes nothing against its base: Needs Me (`no_changes`), not a review and not an empty PR. A non-empty `protected_violations` means Needs Me ("protected path modified: …"). Don't review it and don't open a PR. A non-empty `policy_violations` (the manifest's `policy` rules) is a round R+1 with those messages as the findings: the Implementer can fix them, a reviewer shouldn't have to notice them. So is a non-empty `review_violations` (a review-only path changed by more than added lines, or an added CI line that reaches secrets): write each `file: why` as the findings. A non-empty `review_required` alone is not a problem: carry on, and expect a draft PR (Step 2).

**1d. Reviewer.** Record `AF state update --issue N --state Working --phase review --round R --json`, then launch it with the model its `reviewer_tier` asks for (`fast` → `FAST_MODEL`, `high-reasoning` → `HIGH_MODEL`). Validate it as `reviewer`. Route on the first row that matches:

| Review | Next |
|---|---|
| `permission_violations` not empty | Needs Me |
| any finding `SPEC_ERROR` | Needs Me: the criteria are wrong or ambiguous, and another round can't fix that |
| any finding `ARCH_ERROR` | Needs Me: it needs a human design decision |
| a finding the Implementer disputed with evidence this round, raised again (not in `withdrawn`) | Needs Me now (`disputed_finding`), quoting both positions. Another round would only repeat the argument, and with a cap of 2 there may not be one |
| `approved` | 1e (QA) |
| `request_changes` | round R+1 with `review-rR.json` as the findings |

`context_stale_flags` never block on their own; carry them into the PR body.

**1e. Gates, then QA.** If `AF gates list` shows gates, run `AF gates run --issue N --json > "$A/gates-rR.json"` first. Exit 0 → continue. Exit 1 → a required gate failed: round R+1 with the failing gates' `log` files as the findings, and QA doesn't run. Exit 2 (`environment_error`, a gate that couldn't start) → Needs Me (`qa_environment`), not another round. Only you run gates: the guard blocks `gates run` for `reviewer` and `qa`, so a pass is an exit code you observed. Then record `--phase qa`, snapshot the tree, launch QA, and compare:

```bash
fingerprint() { git -C "$WT" rev-parse HEAD; git -C "$WT" ls-files -s; git -C "$WT" status --porcelain --untracked-files=all
  git -C "$WT" ls-files -m -o --exclude-standard | sort -u | while IFS= read -r f; do printf '%s ' "$f"; git -C "$WT" hash-object -- "$f" 2>/dev/null || echo missing; done; }
fingerprint > "$A/pre-qa.txt"
# launch QA and wait for it (launch.md), then:
fingerprint | diff "$A/pre-qa.txt" -
```

Status alone would miss a commit QA made, or an edit to a file that was already modified, which is why the commit, the staged blobs and a hash of every modified or untracked file are compared too. Any difference means QA changed what it was testing, so its result is invalid: Needs Me (`qa_mutated_tree`). Otherwise validate it as `qa`:

- `passed` → record `AF state update --issue N --state Working --phase publish --round R --json`, then Step 2. (Resuming at `publish` goes straight to Step 2.)
- `passed_with_flaky` → Step 2, and list the flaky tests in the PR body (FM-14).
- `failed` with `reason: null` → the tests ran and failed: round R+1 with `qa-rR.json` as the findings.
- `failed` with a `reason` (`no_commands_defined`, missing tooling, a sandbox or permission error, an install that failed) → Needs Me (`qa_environment`). The Implementer can't fix the environment, so another round would only burn the cap.

## Step 2: PR

```bash
git -C "$WT" push -u origin agent/issue-N
PR=$(gh pr list --head agent/issue-N --state open --json number --jq '.[0].number')
[ -n "$PR" ] || gh pr create --base "$BASE" --head agent/issue-N --title "$(head -n1 "$A/title.txt") (#N)" --body-file "$A/pr.md"
```

Checking for an open PR first makes this step safe to repeat after a crash. Add `--draft` when `risk_level` is `critical` or `human_approval_required` is true. List `review_required` files in `pr.md`. `pr.md` holds: `Closes #N` (for a real GitHub issue), the classification reasons, the review summary (with the Reviewer's `net_lines_removable` when it is above 0), the QA result, flaky tests, any context-stale flags, and the Implementer's `shortcuts` (each is marked `lean:` in the code; the CLI's `debt` command lists them). Reading the title through `$(head …)` means nothing in it is ever executed. Don't paste the title into the command.

- Push or `gh` fails (no remote, no auth, no network) → Needs Me with the verbatim stderr. The branch stays; nothing is lost.
- `human_approval_required: true` → a draft PR plus Needs Me ("critical change — human review required on PR #X", or `review_required` when the change only adds to the manifest's `review_paths`, which says which files to read). Humans merge both; the work itself is finished.
- Otherwise → `AF state update --issue N --state Completed --reason "PR #X"`.
  `Completed` is refused (exit 3, recorded as Needs Me `unreviewed_commits`) unless the latest reviewer run, QA run and every required gate for this round name the current tip of `agent/issue-N`. If it refuses, re-run the missing role or gate on the current tip; don't reset the state by hand.
- Auto-merge only when the user explicitly asked for it, the manifest sets `pipeline.auto_merge_low_risk: true`, `risk_level` is `low`, `human_approval_required` is false, and QA passed: `gh pr merge --auto --squash`. This still waits for CI and branch protection.

The guard refuses pushes to the default branch, force-pushes and `--no-verify`. Don't route around it.

## Step 3: Cleanup

`AF worktree remove N`. It refuses when there's uncommitted work; investigate before you pass `--force`. The branch is kept because the PR needs it. Stop any dev servers you started.


## Escalation (Needs Me)

`AF state update --issue N --state "Needs Me" --reason "…"`. The reason is a decision brief a human can act on in 60 seconds:

```
<category>: <one line>. Tried: <what, per round>. Blocked by: <exact finding or error>. Decide: <the specific question for the human>.
```

Categories: `max_rounds_exceeded`, `SPEC_ERROR`, `ARCH_ERROR`, `disputed_finding`, `protected_path`, `qa_mutated_tree`, `qa_environment`, `malformed_report`, `role_timeout`, `role_failed`, `push_failed`, `issue_not_found`, `critical_change_needs_human`, `review_required`, `no_changes`, `permission_violation`, `budget_exceeded`.

To give an escalated issue another round, a human raises `pipeline.max_review_rounds` (5 at most) and moves it back to Working. You don't. The same goes for `budget_exceeded` (`pipeline.max_cost_usd`): a human raises the cap or accepts the spend.


## Parallel issues

Run independent issues as separate orchestrations, each with its own worktree and artifacts directory. The state file is locked, so parallel updates are safe. You can't know which files an issue touches until it has been implemented, so decide up front from the module scopes in `AGENTS.md`: issues aimed at overlapping modules run one after the other. If two unrelated-looking issues still collide, the later PR shows a merge conflict: escalate it to a human rather than rewriting a pushed branch, which would need the force-push the guard refuses.
