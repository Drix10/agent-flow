# P3: product-scope + rule-taxonomy review of POSTURE-DESIGN.md and PHASE5-PLAN.md v3

Reviewer: adversarial, read-only. Repo HEAD d9f7146 (v1.2.7). Replays run against the built extensions/lib/guard.js.
Scratch: p3replay.mjs/.out (destructive ops), p3roles.mjs/.out (roles), p3push.mjs/.out (push/fetch idioms), p3floor.mjs/.out (floor forgery).
Source note: PHASE5-PLAN.md and docs/phase5/evidence/ are NOT in the working tree (plan/ is gitignored and the files are absent on disk). I read PHASE5-PLAN.md from commit 940a9f8 (copy: scratchpad/PHASE5.md) and the reviews from the scratchpad copies.

---------------------------------------------------------------------------------------------------
## 0. Verdict

The direction (gate by blast radius, declare intent up front, never infer per call) is right. Four things break it as written:

1. The "floor" that makes `solo`/`team` safe is forgeable by allowed local commands (replay below), and relaxations are put in the wrong scope (repo, not human).
2. The tier table does not describe the guard that exists. It contradicts today's behaviour, the plan's own preset table and itself.
3. Three postures is more surface than the evidence supports. Only ONE axis (may the agent land on the default branch directly) is a real policy choice; the rest are bug fixes, existing manifest keys, or reversibility problems that a checkpoint solves better than a block.
4. Release A ships new unconditional blocks to every user, including the only evidenced user, before the pause/grant channel exists.

---------------------------------------------------------------------------------------------------
## 1. TIER AUDIT: all 30 rule names (29 `block("...")` sites in guard.ts + `guard-error` in extensions/guard.ts:96)

Legend: B = block, L = allow + log, A = allow. "RL" = fires for a role-less session (the real population; see 1b). Tier is MY assignment, "design" is what POSTURE-DESIGN.md implies.
"Fit" = does the rule fit T0/T1/T2.

### 1a. Table

| # | rule | RL? | what it does today (guard.ts) | my tier | solo / team / strict | fit / flag |
|---|---|---|---|---|---|---|
| 1 | no-verify | yes | `--no-verify`, `-n`, `core.hooksPath` writes; plus raw-text scan of whole command (G:1683) | T2 | B / B / B | Fits. FLAG: raw scan false-blocks reads and prose: `git config core.hooksPath` (read) = BLOCK, `git commit -m "note core.hooksPath"` = BLOCK (p3push.out). Bug fix, not posture. |
| 2 | fetch-refspec | yes | any `git fetch remote src:dst` | T0 for dst under refs/remotes/; T2 for dst = local default branch or refs/heads/* of others | A / A / B for remote-tracking | MISFIT. Blocks `git fetch origin pull/5/head:pr-5` and `main:main` (p3push.out), the common PR-checkout idiom. Real risk is only overwriting local refs; that is a floor-integrity rule (see flaw 1). |
| 3 | ref-rewrite | yes | `git update-ref`, `git replace` | T2 for refs/heads/<default>, refs/remotes/**, refs/agent-flow/**; T0 otherwise | B / B / B | MISFIT/INCONSISTENT. `update-ref -d refs/heads/x` = BLOCK, `git branch -D x` = allow, same effect. `git branch -f main <sha>` = allow, same effect as `update-ref refs/heads/main` (p3floor.out). |
| 4 | force-push | yes | force flags, `+ref`, mirror, prune, `--delete`, `:branch` | T2 for shared/default branches; T1 for deleting the agent's own merged `agent/*` branch | B / B / B; own-branch delete: A (L in solo) / probe-gated A / B | MISFIT: one name covers three different things (force, mirror, own-branch delete). Branch delete of a merged branch is the evidenced false block (01a1ba9a x2). |
| 5 | push-default-branch | yes | push to main/master/manifest default; MCP push_files etc. | T1 | L / B / B | Fits. This is the one real posture axis. |
| 6 | explicit-refspec | yes | push with no refspec, or dest empty/HEAD/@/glob | T1 (same as 5: it exists only because dest is unresolvable) | L / B / B | MISFIT in `team`: bare `git push` and `git push origin HEAD` are BLOCKED in every posture (p3push.out); the named form `git push -u origin feature/x` passes. So the shortest, most common forms are blocked on the compliant PR path and the named form passes. Resolve HEAD/bare to the current branch name instead of blocking. |
| 7 | bulk-git-protected | yes, ONLY if protected_paths non-empty | reset --hard/--merge, clean -f, stash (non list/show), checkout/switch -f, checkout/restore/rm/mv `.` | T0 + checkpoint (see 2); T2 only when the named paths are protected | A+snapshot / A+snapshot / B for reset --hard, clean -x | MISFIT, and CONTRADICTS the design. Today the keyed condition is "protected_paths exists", not blast radius. With protected_paths set it blocks `git stash`, `git stash pop`, `git checkout .`, `git restore .` (safe or reversible) while `git branch -D`, `git gc --prune=now`, `git reflog expire`, `git filter-branch`, `rm -rf .env` are allowed (p3replay.out). With no protected_paths, `git reset --hard` and `git clean -fdx` are allowed (p3replay.out). |
| 8 | secret-read | yes | env files + deny_read via shell and read tools; recursive search sweep | T2 | B / B / B | Fits as T2 but CONTRADICTS the design's T0 line "read-only actions are NEVER blocked". 5 live events, 0-1 real catch, 3 over-broad (plan 1a). Keep B, fix over-breadth (A5), bless `env-check`. |
| 9 | catastrophic-delete | yes | rm/mv of `/`, home, system dir, drive root | T2 | B / B / B | Fits. Lifted by ALLOW_PROTECTED (plan H8). |
| 10 | obfuscated-command | yes | `$IFS` splitting | T2 (anti-evasion) | B / B / B | Fits. No test asserts the name. |
| 11 | deny-command | yes, ONLY if policy.deny_commands set | opt-in presets (database, infra) + custom | T2 "destructive remote/prod writes" | B / B / B (+ presets on in strict) | PARTIAL. The design's T2 "destructive remote/prod writes" and "external publish" have no default rule; only this opt-in one. Strict could switch the presets on. |
| 12 | role-escalation | no (role != orchestrator) | role changes, nested agent launches, spawn tools | pipeline-only | n/a | Never fires for solo/team interactive sessions. Role-less `claude -p` and `pi remove` are allowed (p3roles.out). |
| 13 | role-tool | no | agent-flow mutators not in ROLE_TOOL_ALLOW; CLI twins; MCP merge_pull_request | pipeline-only | n/a | Role-less `merge_pull_request` and `gh pr merge` are allowed; even the IMPLEMENTER may `gh pr merge` (p3roles.out). |
| 14 | qa-no-autofix | no | reviewer/qa with --fix/--write/-u | pipeline-only | n/a | |
| 15 | read-only-role | no | reviewer/qa write tools and mutating shell | pipeline-only | n/a | |
| 16 | tamper-proof | partly | trust files by file tools; role-less shell: only .git/hooks and destructive .git | T2 | B / B / B | GAP: role-less `rm -rf .agent-flow` = allow, `git clean -fdx` = allow, and it deletes `.agent-flow/` (audit chain, backups) and `.agent-state.json` because install puts them in .git/info/exclude (bin:2253); verified `git clean -fdxn` lists `.agent-flow/` and `.env`. |
| 17 | agent-config | no | role writes to .claude/, .github/workflows/, .husky/ ... | pipeline-only | n/a | The design's "hot paths .github/workflows stay strict under solo" has NO role-less rule behind it: role-less Write of `.github/workflows/ci.yml` = allow (p3roles.out). Only user-declared protected_paths covers it. |
| 18 | protected-path | yes (if protected_paths) | writes to manifest protected_paths | T2 (user-declared) | B / B / B | This IS the hot-path feature, already shipped and floored additively. The design's separate "hot paths" is a duplicate. |
| 19 | guard-wiring | yes, ONLY if protected_paths non-empty | .claude/settings*.json, node_modules/@drix10/agent-flow ... | T2 ("disable the guard") | B / B / B | Conditional today. Role-less `pi remove`, `rm -rf .claude` = allow (p3roles.out). Plan A6/B4 make it unconditional (see flaw 3). |
| 20 | symlink-escape | no | role write whose symlink leaves repo | pipeline-only | n/a | No test. |
| 21 | worktree-confinement | no | implementer writes outside AGENT_FLOW_WORKTREE | pipeline-only | n/a | |
| 22 | governance | no | implementer touches CONTEXT_MANIFEST.json | pipeline-only | n/a | Role-less may write the manifest, i.e. can write a `posture` key (p3floor.out). |
| 23 | context-file | no | implementer writes context files | pipeline-only | n/a | |
| 24 | gardener-scope | no | gardener writes non-.md | pipeline-only | n/a | |
| 25 | outside-repo | no | role writes outside repo | pipeline-only | n/a | Role-less `../outside.txt` = allow. |
| 26 | unknown-target | no | file-write tool with no path (roles) | pipeline-only | n/a | |
| 27 | manifest-unreadable | yes | manifest present but invalid and call writes | T2 integrity (fail closed) | B / B / B | Plan A2 changes the loader; keep fail-closed. |
| 28 | manifest-integrity | yes | rm/mv of CONTEXT_MANIFEST.json | T2 | B / B / B | Lifted by ALLOW_PROTECTED. |
| 29 | opaque-script | no | implementer runs >512KB script | pipeline-only | n/a | No test. |
| 30 | guard-error | yes (Pi audits; CLI path does not) | exception inside decide, fails closed | infrastructure, not a tier | B / B / B | Not a policy rule; must never be postured. |

### 1b. What the table says

- 13 of 30 rules (12, 13, 14, 15, 17, 20, 21, 22, 23, 24, 25, 26, 29) fire only when a role is set (`if (role && ...)`, guard.ts:1670, 1905, 1953). A role comes from `AGENT_FLOW_ROLE` (pipeline launcher) or a Claude `agent_type` (a subagent). A solo user with no pipeline never meets them. FAILURE_MODES.md:232 itself says an inline session "runs as orchestrator or with no role".
- Role-less enforcement = rules 1-11, 16 (narrow), 18, 19 (conditional), 27, 28, 30. Postures can only ever touch rules 2-8 and 11. They do not interact with roles at all: posture and role are orthogonal axes, and the design must say so. Role rules stay un-postured (always B for a role; there is no solo exemption for a reviewer that must be read-only).
- The one place postures and roles collide is the design's sentence "agent self-merge blocked for non-orchestrator roles and role-less sessions" (team). Today, `gh pr merge` is allowed for role-less AND for the implementer (p3roles.out); only the MCP `merge_pull_request` is blocked, and only for roles. So this sentence is a new block, applied to the exact population (role-less) that the evidence says needs fewer blocks. Evidence that the owner's accepted lawful path included agent self-merge: 01a1ba9a #5409 "then open prs, merge delete simple"; 110fe80e ships by merge-PR refs.
- Rules that exist only for the reviewed-PR pipeline (13 above) should be left untouched in Release B and documented as "pipeline roles", not as part of any posture.
- Contradictions with the tier:
  - T0 "local resets ... never blocked" vs today's rule 7 (blocks `git reset --hard` whenever protected_paths is set).
  - T0 "read-only never blocked" vs T2 "read secrets blocked" (rule 8) and the T1 line "recursive search near env files?" which PHASE5 B1 says is never relaxed.
  - T1 `reset --hard` "blocked in team" vs PHASE5 B1 table "standard = current behaviour" (allowed unless protected_paths) vs "strict: block always".
  - T2 lists "read/write secrets" (no secret-WRITE rule exists; deferred to Release C), "external publish/post" (no rule; `git tag v1 && git push origin v1` and `git push --tags` are allowed, p3push.out, and the repo itself publishes via GitHub Release), "destructive remote/prod writes" (opt-in presets only), "disable the guard" (role-less `pi remove` allowed). Three of the five T2 classes have no rule at default settings; "always gated in every posture" is untrue today and stays untrue after Release A.
  - "hot paths enforced even under solo": no role-less rule exists for `.github/workflows/`, `deploy/`, migrations (only protected_paths, user-declared).
  - Fetch of `refs/remotes/*` is blocked (rule 2), yet T0 says branches/reads are always free.

---------------------------------------------------------------------------------------------------
## 2. IRREVERSIBILITY CHECK of "T0 always free"

Replay results (role-less and implementer, repo with NO protected_paths, p3replay.out): every command below = `allow`, except where noted. With `protected_paths: ["src/billing/**"]` set, the starred ones flip to `bulk-git-protected`.

| command | recoverable? | what I verified | guard today | where it belongs |
|---|---|---|---|---|
| `git reset --hard` | tracked uncommitted edits: NO. committed state: yes via reflog/ORIG_HEAD | reasoning + git semantics | allow (no protected_paths) / block* | T0 + checkpoint |
| `git clean -fdx` | NO for untracked+ignored | `git clean -fdxn` in a scratch repo lists `.agent-flow/` (audit hash chain, backups), `.env`, `dist/`, `node_modules/`, `untracked.txt`; it skips nested worktrees ("Would skip repository .worktrees/x") | allow / block* | `-x/-X`: T2 for env + `.agent-flow/` unless checkpointed (also a self-disable route: it lists `node_modules/`, which holds the guard package in a project install, and a missing hook script fails OPEN, plan s7; `rm -rf node_modules` is also allow in the replay); plain `-fd`: T0 + checkpoint |
| `rm -rf <dir>` in repo | tracked: yes via git; untracked/ignored: NO | `rm -rf .`, `./*`, `.env`, `.agent-flow`, `.worktrees`, `build`, `node_modules` all allow with no protected_paths; `rm -rf .git` = tamper-proof | allow; `rm -rf .`/`./*` = protected-path* | T0 for build outputs; `.`/`./*`/`.env`/`.agent-flow` need checkpoint or T1 |
| `git branch -D x` | commits: yes while reachable from some reflog, else only `git fsck --lost-found` | verified: after a commit in a worktree, `git worktree remove --force` then `git branch -D`, `git reflog --all` finds 0 trace, `git fsck --lost-found --no-reflogs` finds the commit; `Deleted branch agent/y (was 142eb8a)` prints the sha | allow | T1 for unmerged branches; checkpoint (ref) makes it T0 |
| `git branch -D main`, `git branch -f main <sha>` | local default ref rewritten | `git branch -f main HEAD~1` allow; same as `update-ref` which IS blocked | allow | T2: local default branch ref (see flaw 1) |
| `git rebase --root`, `rebase -i`, `commit --amend`, `filter-branch` | yes via reflog/ORIG_HEAD (filter-branch leaves refs/original) | allow | allow | T0 (reflog is the safety net) |
| `git checkout -- .`, `checkout .`, `restore .` | uncommitted tracked edits: NO | allow / block* | allow | T0 + checkpoint |
| `git stash`, `stash pop` | safe, reversible | BLOCK* when protected_paths set | block* | FALSE BLOCK: stash is the safety valve; fix |
| `git stash drop` / `clear` | stash commit dangling (drop prints sha; clear prints nothing); lost after gc | allow / block* | | T0 + checkpoint |
| `git worktree remove --force` | uncommitted work in that worktree: NO; its HEAD reflog is deleted with it (verified above) | allow (reviewer/qa get read-only-role) | allow | T1 in `team`/`strict`; checkpoint first. Plan item 22 "OUT": agree for solo, not for team. |
| `git gc --prune=now` | AMPLIFIER: permanently deletes every dangling object (dropped stashes, deleted-branch commits) | allow | allow | NOT T0. T2-ish: destroys the safety net of every other op |
| `git reflog expire --expire=now --all` (+gc) | AMPLIFIER: removes the reflog that makes all the "recoverable" rows recoverable | allow | allow | NOT T0. Same class as above |
| overwrite with `>` / `truncate -s 0` / `sed -i` | tracked+committed: yes; uncommitted: NO | allow (non-protected paths) | allow | T0 + checkpoint at most; do not block |

Conclusions:
1. "T0 always free" is NOT true for: `git clean -x*` (destroys the product's own audit chain and the user's only copy of `.env`), `git gc --prune=now` and `git reflog expire` (destroy the recovery mechanism for everything else), `git worktree remove --force` (loses uncommitted work and the branch's reflog), and `git branch -D` of an unmerged branch in a worktree flow. `reset --hard`, `checkout .`, `restore .`, `stash drop/clear`, `rm -rf` of untracked, `>` overwrites are lossy only for UNCOMMITTED state.
2. Split by what is lost, not by command name: (a) loses only uncommitted/untracked-unignored state -> checkpoint then allow; (b) loses ignored-but-precious state (`.env`, `.agent-flow/`, `.agent-state.json`) -> checkpoint the small precious files too, or block `-x`; (c) destroys the recovery mechanism (`gc --prune=now`, `reflog expire`, `update-ref -d` on refs/agent-flow) -> T2.
3. Safety-ref mechanism: cheaper and friendlier than blocking. Measured on this repo (220 tracked files, 40 MB .git): temp-index snapshot (tracked + untracked-not-ignored; leaves the real index untouched) 0.69 s wall on Windows; `git stash create` (tracked only) 0.10 s. Recipe verified in a scratch repo: `GIT_INDEX_FILE=.git/snap.idx git read-tree HEAD && git add -A && git write-tree && git commit-tree -p HEAD`, then `git update-ref refs/agent-flow/snap/<ts> <commit>`. Properties that make it better than a block:
   - A false positive costs ~0.1-0.7 s and a few objects; a false block costs a stalled session and a possible uninstall (01a1ba9a W1). So the destructive-op detector can be sloppy (over-match), unlike a blocking detector. This removes the whole "parse the command exactly" burden the plan struggles with in A1/A4/A5.
   - Reachable from a ref, so `gc --prune=now` does not drop it; `reflog expire` does not touch refs. `update-ref -d` is already blocked (rule 3).
   - No hook protocol change: the guard allows the call and snapshots first. Works on every adapter that runs the guard.
   - Caveats (not verified here): large or cold-disk repos (a `git add -A` over 100k files may take seconds; Claude kills hooks at 60 s and then does NOT block, plan s7), secrets get copied into .git objects (local only; keep refs out of any pushable namespace and say so), ignored files are not captured by default (add a small copy of `.env*`, `.agent-flow/`, `.agent-state.json` under .git/agent-flow/snap/<ts>/ with a size cap), interpreter-driven deletes (`python -c`, `node -e`) are only caught if the trigger is "any non-read-only shell call, rate-limited 1/min" instead of command parsing, a hook that writes to .git is a new side effect to document, and the snapshot is best-effort: on timeout/failure allow and audit `snapshot_failed`.
   - Claude Code's own checkpoints cover its edit tools, not shell side effects (from product knowledge; not re-verified this session).
   - Retention: keep last N (say 30) and 24 h minimum; `agent-flow restore --list|--last` is the human-facing undo.

---------------------------------------------------------------------------------------------------
## 3. SIMPLICITY: what is the smallest design?

### 3a. Surface count in POSTURE-DESIGN.md + PHASE5 B1/B4/B6/B7

Things a user or maintainer must hold in their head: 3 postures x 3 tiers x ~8 postured rules; hot paths (duplicate of protected_paths); `pause --for --rule`; kill-switch env; env-check; 6 detection signals + `doctor` re-suggestion; floored key with a three-way strictest-of (disk/HEAD/default) and a special "relaxations only from default branch" rule that differs from every other floored key; `ask` degrading by capability table; managed-config recommendation; audit-required. About 10 concepts for a tool whose evidence is four live sessions of one owner on one cheap model. `team` and `strict` differ only in `reset --hard`, hot paths and "audit required", none of which has evidence behind it.

### 3b. Alternatives

| | surface | solves "don't block what the coder told" | solves "stop what the agent does alone" | problems |
|---|---|---|---|---|
| (a) per-rule config + 3 bundles | highest: every rule name becomes public API (plan itself will not rename rules because ~22 test assertions and by_rule consumers use them) | yes | yes | schema churn, docs per rule, bundle drift |
| (b) two modes (default + `--yolo-lite`) | low | yes for the one axis | yes | the name tells strangers "unsafe"; a mode with no expiry and no per-rule scope is a bigger hammer than needed; where it is stored decides its security |
| (c) 3 postures (proposed) | medium-high | yes | yes | team/strict unevidenced; detection/spoofing; floor forgeable; 3 names to document |
| (d) no postures, only pause/grants | lowest | only if grants can be standing; otherwise the solo owner re-pauses all day | yes | with a standing grant (no expiry) it collapses into (b) |

### 3c. Recommendation: (b) implemented as (d): one primitive, "grant", plus one init question

- Primitive: a human-run grant: `agent-flow allow <rule-class> [--for 30d]` (default expiry 30 days with a renewal prompt in `status`; a standing no-expiry grant needs `--standing` and is then shown in the session brief and logged on every use, because MAP-2 asks for scope, expiry, revocation, visibility and e519a401 W3 / 110fe80e W4 document permission creep), `agent-flow pause` = grant of "all T1" with a mandatory short expiry, `agent-flow revoke`. User-scope store (outside the repo), audited, shown by `status` as "ALLOWED: landing until 2026-12-11" / "PAUSED until 15:40". Grants and pauses apply to ROLE-LESS sessions only: `push-default-branch` also fires for pipeline roles, and a grant must never let an implementer push to main (that would break the reviewed-PR promise); role sessions are never relaxed and `run --auto-merge` keeps its existing gate. One mechanism replaces: solo posture, pause, kill switch (a kill switch is `pause --all`), and half of B4.
- Only one rule class needs a grant in v1: `landing` (push to the default branch + `gh pr merge`). That is the one axis where the owner of the repo makes a real policy choice and where the evidence (3 episodes, all user-ordered) says the blanket ban hurts. Everything else the evidence complained about is a bug fix that applies to everyone with no posture: merged-branch delete (B3), `git config` read (A4), `fetch ...:refs/remotes/` (A5b), `grep --include` (A5), bare `git push`/`push origin HEAD` (rule 6), `git stash` (rule 7).
- Repo-side tightening is the existing manifest: `protected_paths` (= the hot paths), `deny_read`, `policy.deny_commands` (strict presets), `review_paths`. No `strict` name needed; document a "strict recipe" (a manifest snippet + managed config) instead of a code path.
- Reversibility handled by checkpoints (section 2), not by tier membership.
- Names: no posture names at all. User-facing words: "landing: pull request (default)" or "landing: direct (I push to main myself)". If a name is required, `landing = pr | direct`.
- `agent-flow init` asks at most 2 questions:
  1. "Should agents be able to push or merge straight to `main` in this repo?" Options: "No, pull requests only (default)" / "Yes, I'm the only one pushing here". Show detected facts beside it (remote branch protection on/off, authors in the last 90 days, CI present). If branch protection is detected, do not ask: the server decides and the guard stays at `pr`. "Yes" writes a standing user-scope grant, never a repo file.
  2. (existing bootstrap question) "Which paths must agents never touch?" (writes protected_paths).
- Detection recommends, never decides (in-repo signals CODEOWNERS/CI/contributors are agent-writable and spoofable). Cut `doctor` re-suggestion.

---------------------------------------------------------------------------------------------------
## 4. VALIDATION of the unproven ICP (team, production), no phone-home

What is known: one owner. The README stats come from one research repo with one maintainer ("an example, not a benchmark"); the plan's baseline notes 584 of 756 blocks are role-probe test traffic, so check that README's "150 blocked" does not include such rows (not verified). Zero evidence about teams or production.

Cheapest ways to learn, in order of cost:
1. Public signals (free, no consent needed): npm weekly downloads and dist-tag installs; GitHub code search for committed `CONTEXT_MANIFEST.json` / `.agent-flow-runtime/` and, for those repos, public facts (contributor count, branch protection via API, CODEOWNERS). Tells whether any team repo exists at all and what they committed. Decision: if fewer than ~5 public non-owner repos exist, do not build `strict` or managed-config tooling; ship the manifest-recipe docs only.
2. Beta dist-tag: ship the grant/landing change as `npm i @drix10/agent-flow@next` with a pinned GitHub Discussion "friction reports"; release as latest only after N reports or 3 weeks. Existing installs unchanged on `update` (already planned).
3. Dogfood on 2-3 external repos (ask for maintainers via the Discussion; offer to set up): 1 solo, 1 two-person PR-flow repo, 1 repo with real CI/deploy config. Run for one week with the audit on. Qualitative interview of 15 minutes each: "when did it stop you, was the next step obvious, did you pause/uninstall".
4. `agent-flow friction-report` (local only, prints to stdout or a file, never sends): a markdown summary the user may paste into an issue. Contents: version, harness, landing mode, OS, repo-size bucket; counts by rule (and by `variant`) of blocks; counts of override/pause/grant/uninstall lines; "retry after block" count (same rule within 5 min of a block); "guard-on coverage" (sessions with a live hook vs sessions seen); role-less vs role session ratio. Never: command text, paths, branch names, repo name, reasons. `--preview` shows exactly what would be shared; `--redact-check` greps the output for path-like and token-like strings and fails if found. This fits README:226 ("no telemetry... sends nothing to its author").
5. Issue templates: "false block" (rule name, the command's SHAPE, what the compliant path cost in calls), "missed block", and "I turned it off because" (also `agent-flow uninstall --reason`, stored locally and included in the friction report).

What to measure and what each result triggers:

| measure | trigger |
|---|---|
| per rule: blocks followed by a grant/pause/uninstall within 10 min / total blocks | > 30% for a rule: demote that rule to allow+log by default and keep it blocked only for protected paths; ~0% with at least one catch: keep |
| calls from first block to compliant completion (deny text quality) | > 3 median: rewrite deny text or add an automatic reroute before touching policy |
| uninstalls within 7 days of install (from `--reason` and reports) | any reason naming "blocked X": fix X before any new feature |
| share of init answers = "direct" | > 80% among reporters: make `direct` the default for repos with no remote protection and one author; < 20%: delete question 1 and default to `pr` |
| count of non-owner repos with a committed `landing`/protected_paths | zero after the beta: team/strict stay hypotheses, and Release B contains no team-only code |
| snapshots restored (`restore` calls) | the only direct evidence that checkpoints save work; if restores are 0 across reporters, keep (cost is tiny) but do not market it |
| block counts per day | never a success metric (it improves when users uninstall; plan s4) |

Honest sample size: with fewer than ~10 reporters, results are qualitative; decisions above are "change defaults for the next beta", not statistics.

---------------------------------------------------------------------------------------------------
## 5. SCOPE vs the product promise

Promise (package.json, README:8,15): "Leave your coding agent alone with your repo and come back to a reviewed pull request: separate agents implement, review and test, and a guard blocks what they must never touch."

- There are two products in one package. (1) The reviewed-PR pipeline (`run`, roles, gates, state, 13 role-only rules). (2) The tool-call guard that works for any session, with or without roles (17 role-less rules). The evidence base (4 pi sessions, one cheap model, role-less) is entirely about product 2. README sells product 1 and mentions the guard as one clause.
- A `direct` landing mode does NOT contradict the promise if the pipeline stays the way to get the "reviewed PR" outcome: `run --pr` is unaffected by landing mode (roles still review in worktrees; the PR is still produced). It does contradict the promise if README implies that every protected repo ends in a reviewed PR. So the fix is wording, not code: the guard alone makes no review claim.
- It extends the ICP honestly: from "teams that want reviewed PRs" to "anyone running an autonomous agent on their own repo", which is the only population the data shows. It also puts a stranger, not the owner, in front of the first-minute experience; the default must therefore be the one that leaves a lawful one-command path.
- README/positioning changes:
  - Keep the header promise for the pipeline. Add a second line under Install: "Two ways in: `agent-flow run` (agents implement, review and test, you get a pull request) or just the guard (works in any session: stops pushes to main, force-pushes, `--no-verify`, secret reads, and takes a checkpoint before destructive local commands)."
  - Replace "A guard keeps all three out of what they must never touch" with a statement of enforcement tiers per harness; only Claude Code and Pi block per call (README:37, HARNESS-MATRIX). Landing mode on an instruct-only harness is a no-op and `status` must say so, or `direct`/`pr` is false assurance.
  - SECURITY.md: add the grant model (human-run, user-scope, audited; the user's own terminal is unblockable), keep "protect `main` on the remote" as the real boundary.
  - README "From one real repo" stays labelled as one example; do not add solo numbers until they are live-only (baseline Slice 0).
- NOT to build in Release B (keep the product coherent):
  1. No `strict` posture, hot-path concept, "audit required", managed-config tooling. Document a manifest recipe.
  2. No auto-detection or `doctor` re-suggestion of posture; init shows facts and asks.
  3. No per-harness `ask` machinery (plan B1 `ask` degrade table, capability model as product surface). Deny-with-named-lawful-path is the only verdict shape the hooks all support (plan 2b item 3).
  4. No separate kill-switch env; `pause --all` and "existing installs unchanged on update" replace B7.
  5. No changes to the 13 role-only rules, no new roles.
  6. No network probes in the gate (flaw 4): B3 is a bug fix, so ship the offline subset first (merged = local `merge-base --is-ancestor` against the remote-tracking ref, no `ls-remote`).
  7. B2 beyond `gh pr merge` and `gh api` writes to refs/heads/<default>: defer until the friction report shows demand.
  8. Release C items (warn-on-paste, secret-write scan) stay in C.

---------------------------------------------------------------------------------------------------
## 6. TOP 5 FLAWS the other reviewers are unlikely to catch

### Flaw 1 [critical, replay-verified]: the posture floor is forgeable with allowed local commands, and relaxations are in the wrong scope
POSTURE-DESIGN.md "Mechanism" and PHASE5 B1: "relaxations (`solo`) honoured only from the default-branch copy ... strictest-of wins". But `defaultBase()` (git.ts:68, defaultBranch git.ts:52) returns the LOCAL branch name (`main`), and `defaultBranchManifest` runs `git show main:CONTEXT_MANIFEST.json` (manifest.ts:416). Replay p3floor.out, role-less, manifest with `protected_paths`, no protected path for git ops:
```
allow  git branch -f main agent/x
allow  git checkout main && git merge agent/x
floor policy before: {"max_changed_files":5}
floor policy after `git branch -f main` (local ref): {"max_changed_files":5000} posture: solo
role-less Write of manifest: allow
```
So an agent (or one allowed Write + one allowed `git branch -f`) rewrites the "default-branch copy". The same hole exists today for `policy`; posture inherits it. Also, with no committed copy the working copy is used (manifest.ts `trustedManifest`: `if (!floor) return { manifest: disk }`), so a fresh repo (the prototype ICP) can be set to `solo` by a Write. And "T0: branches, local resets always free" is exactly the set that forges it.
Moving the anchor to `refs/remotes/origin/<default>` does not fix it (p3anchor.out, role-less and implementer): `git remote set-url origin https://example.invalid/r.git` = allow, `git remote add`, `git remote remove origin`, `git config remote.origin.url ...` = allow, and a plain `git fetch origin` (no refspec, so A5b does not apply) then rewrites `refs/remotes/origin/main`. Also allowed: `echo '{}' > ~/.agent-flow/grants.json` and a Write-tool write to `~/.agent-flow/grants.json` (role-less). Conclusion: against a role-less shell NO local ref and NO user-scope file is a trust anchor. Every store is best-effort (the same honest caveat plan B4 already gives the pause record).
What the user-scope move DOES buy is scope, not unforgeability: a relaxation is a statement by the human running the agent on THIS machine, not a property of the repo. Committing it shares it with every contributor and CI run (one teammate's `solo` relaxes everyone). Tightening belongs in the repo; relaxation belongs in user scope.
Fix, in order: (1) say plainly in docs that the store is best-effort against a role-less shell; (2) name the rules that protect it: extend `tamper-proof`/`guard-wiring` to `~/.agent-flow/**` and to remote edits (`git remote add|set-url|remove`, `git config remote.*`), unconditionally and not liftable by ALLOW_PROTECTED; (3) block `git branch -f|-D|-m` and `update-ref` on the local default branch and refs/agent-flow/**; (4) keep A5b narrow: allow `fetch` only to a destination equal to the source name on the same configured remote, never `*/<default>`; (5) the strongest anchor is the server (branch protection) and managed config, which the docs already say.

### Flaw 2 [high]: the tier table is not a description of the guard, and the guard's bulk rule is inverted relative to blast radius
- Today `bulk-git-protected` keys on "protected_paths is non-empty", so a repo that completed bootstrap (the normal installed state) blocks `git stash`, `git stash pop`, `git checkout .`, `git restore .` (p3replay.out), while `git gc --prune=now`, `git reflog expire --expire=now --all`, `git filter-branch`, `git branch -D`, `git worktree remove --force`, `rm -rf .env`, `rm -rf .agent-flow` all pass for a role-less session. `git clean -fdx` deletes `.agent-flow/` (audit chain) and `.env` with no protected_paths.
- Design T1 says `reset --hard` is blocked in `team` (the new-install default), PHASE5 B1 says the default preset equals today (allowed unless protected paths). One of them is wrong; if the design wins, every existing user who runs `update`... (existing installs unchanged, so only new installs) gets a new block with no evidence of harm, in the preset meant for strangers.
- T0 "read-only actions are NEVER blocked" vs T2 secret-read blocks; T2 includes three classes with no default rule (secret write, external publish, remote/prod writes); "hot paths" has no role-less rule.
Fix: build the table from `rule -> what is lost` (section 2), not from command names; generate the table from code (a test that every rule name has a tier row; fails when a new `block("...")` appears) so docs cannot drift again.

### Flaw 3 [high]: priority inversion and a new-block-before-relief sequence in Release A
- Release A is labelled "close holes, same policy", yet A6 makes guard-wiring (settings files, package dir) unconditional and non-liftable, A9 adds a `code-exec` class denied by default, A3 changes audit, A1/A4 change what is allowed (fixes). The `pi remove`/uninstall command blocks and `pause` are B4, one release later, together. So for a role-less solo user with no `protected_paths`, Release A adds NEW blocks (edits to `.claude/settings*.json`, edits to the installed package dir, code-exec tools) while the pause/grant channel that gives "how do I stop this" an answer (R2-01, 01a1ba9a #5409) does not exist yet. That is the trigger of the only observed guard removal, delivered to the only evidenced user in 1.2.8. (The `pi remove` block itself is B4 and is correctly paired with pause.)
- The only evidenced user's relief (landing grant, merged-branch delete, bare `git push`) is last. R2 already argued push policy is small ("one parameter" through decideGit). With the grant design it is the first thing to ship.
Reorder: Release 0 (small, ships first, no new blocks): fixes that remove false blocks for everyone (A4 hooksPath read, A5b fetch refspec, rule 6 HEAD/bare push, stash, include-glob subset of A5) + checkpoint + grant/pause primitive + `landing` grant. Release A security holes after, each new block paired with a named human-run path in its deny text. Keep one rule: no release adds a block without the human-run path it names existing in the same release.

### Flaw 4 [medium-high]: B3 puts network calls in the gate, contradicting the published audit claims
B3: "default branch from `ls-remote --symref`", "remote sha from `ls-remote`", optional `gh pr list --head b --state merged`, inside the guard. SECURITY.md:58 states "Network: nothing that gates a change touches it (the guard, the pre-commit hook, `classify`, `audit-risk`, `gates`)" and SECURITY.md:69 "makes no network calls"; README:226 "no telemetry, ... only traffic is what you start yourself". The two existing lookups are in `doctor` only and skipped in CI/offline. B3 also depends on credentials the hook may not have (non-admin tokens, SSH agents absent in headless), adds up to 3 s per delete, and the hook fails open at 60 s on Claude (plan s7). Either the claim is rewritten (and `AGENT_FLOW_OFFLINE` honoured: offline = stay blocked, with the human-run command named) or B3 uses only local refs (`refs/remotes/origin/<default>` + `merge-base --is-ancestor`), which covers merge-commit and fast-forward merges and needs no network. Ship the offline version first.

### Flaw 5 [medium-high]: the metrics and ICP logic validate the design against its own author
- "Friction budget replay of the owner's days" and the adversarial arena (Claude path, 3 runs, 2 models, one cheap) measure whether the design fits the owner and the corpus. The strangers who decide adoption (team/production) have zero data; yet Release B includes team/strict-only code (hot paths, strict preset, audit required, managed-config guidance, signal-based detection) and sets the stranger default to `team`, the posture that creates the owner's friction. 01a1ba9a W1 is the plan's own evidence that a block without an immediate lawful path gets the guard removed; `team` default blocks `gh pr merge` (owner's accepted path) and bare `git push`/`push origin HEAD` (rule 6) on day one, with no data that this prevents harm (live tally: 0 demonstrable harm prevented across 3 push episodes).
- Posture on instruct-only harnesses is a no-op (Codex/Gemini/Cursor docs-verified only; Cline, Kiro, Qoder, Windsurf, Copilot, Swival, Factory, Command Code have no hook, A-guard-core.md s0; HARNESS-MATRIX). `status` showing `strict` there is false assurance unless it prints the enforcement tier next to the posture.
- Local-only counters (override/pause/uninstall) never reach the maintainer, so the plan has no channel to learn about ICP 2/3; section 4 supplies one.

---------------------------------------------------------------------------------------------------
## 7. EXACT REPLACEMENT TEXT for POSTURE-DESIGN.md

Replace everything from "## Core idea" through "## Mechanism" with:

```
## Core idea: gate by what is lost and who decided, not by command name
| Class | Examples | Behaviour |
|---|---|---|
| Free | edits, commits, local branches, rebases, tests, reads | never blocked |
| Free with a checkpoint | `reset --hard`, `clean -f` (no -x), `checkout .`, `restore .`, `stash drop/clear`, `rm -rf` of untracked, `worktree remove --force`, `branch -D` | guard takes a snapshot ref (`refs/agent-flow/snap/<ts>`, tracked + untracked-not-ignored, plus a small copy of `.env*`, `.agent-flow/`, `.agent-state.json`) and allows; `agent-flow restore` undoes. Snapshot failure = allow + audit `snapshot_failed`. Over-matching is harmless. |
| Needs a human decision (one axis: landing) | push to the default branch, `gh pr merge`, MCP merge | blocked by default with the one-command PR path named; allowed + logged when the user holds a `landing` grant |
| Never for the agent alone | force-push or delete of shared branches, secret reads, disabling or removing the guard, rewriting the local default branch ref or refs/agent-flow/**, `gc --prune=now`, `reflog expire`, `clean -x` without a checkpoint of env/state files, catastrophic delete | blocked in every mode; the deny names the exact human-run command |

Rules that only apply to pipeline roles (reviewer, QA, implementer, gardener) are unchanged and not part of any mode. A role-less session gets the rows above.

A hook cannot know whether the user asked for an action, so intent is declared up front by the human, in a place the agent does not write, and is audited:
- `agent-flow allow landing [--for 30d | --standing]` (role-less sessions only), `agent-flow pause [--for 30m] [--rule X]`, `agent-flow revoke`, `agent-flow status` shows "ALLOWED: landing (standing)" or "PAUSED until 15:40". One mechanism; no mode names.

## What init asks (max 2)
1. "Should agents be able to push or merge straight to <default> in this repo?" (default: no, pull requests only). Facts shown beside it: remote branch protection, authors in the last 90 days, CI present. If remote branch protection is detected, it is not asked. "Yes" creates a 30-day `landing` grant in user scope (renewable; `--standing` is explicit).
2. The existing bootstrap question: which paths must never be touched (`protected_paths`; this is also the hot-path list, there is no separate concept).

## Mechanism
Relaxations live in user scope (`~/.agent-flow/`, keyed by the git common dir), never the repo, because a committed relaxation would apply to every contributor and CI run. The benefit is scope, not unforgeability: the default-branch copy is a local ref the agent can move with `git branch -f main`, and a role-less shell can also write `~/.agent-flow/` and edit `origin` (all replayed as allowed). The store is best-effort and is protected by named rules (`tamper-proof`/`guard-wiring` extended to `~/.agent-flow/**` and remote edits, never liftable by ALLOW_PROTECTED); server-side branch protection is the real boundary. Grants and pauses apply to role-less sessions only: pipeline roles are never relaxed and `run --auto-merge` keeps its existing gate. Grants expire (default 30 days, renewal shown in `status`); a standing grant needs `--standing`, appears in the session brief and is logged on every use. Tightenings live in the repo (committed manifest keys: protected_paths, deny_read, policy.deny_commands, review_paths); a repo that commits `landing: "pr"` cannot be relaxed by a user-scope grant except through an expiring `pause`. Missing or unknown = the strict default. Existing installs are unchanged on `update`. No kill switch beyond `pause --all`. `status` prints the enforcement tier of the current harness next to the landing state; on harnesses with no blocking hook it says "advisory".
```

Replace the "Metrics" and "Open questions" sections with:

```
## Metrics
Harm: fixture false-allow rate per rule. Friction: per rule, share of blocks followed by a grant, pause or uninstall within 10 minutes; calls from first block to compliant completion; snapshots restored. Never blocks per day.

## Validation (no data on teams or production)
Public signals, a `next` dist-tag with a friction-report Discussion, 2-3 external dogfood repos, and a local-only `agent-flow friction-report` (counts by rule; no commands, paths or names; `--preview`). Decisions per result: demote a rule above 30% override rate; delete init question 1 if over 80% answer the same; build no team/strict-only code until a non-owner repo commits `landing` or protected_paths.
```

Line-level corrections if the old structure is kept:
- Tier table T0 row: delete "local resets, worktrees"; add "`branch -f`/`update-ref` on the default branch is T2".
- Tier table T1 row: delete "`reset --hard`" and "recursive search near env files?" (secret search is T2, never relaxed).
- T2 row: delete "read/write secrets" -> "read secrets (write: Release C)"; delete "external publish/post" and "destructive remote/prod writes" unless a rule is named for each (none exists at defaults).
- "Hot-path overrides" paragraph: replace with "protected_paths are never relaxed by a grant".
- `team` bullet: delete "agent self-merge blocked for ... role-less sessions" unless the deny text names the one-command human path and the grant exists in the same release.

---------------------------------------------------------------------------------------------------
## 8. What I could not verify
- Live hook behaviour on any harness this session (everything about Claude/Pi/Codex/Gemini/Cursor semantics is from the plan's section 7, not re-run).
- Snapshot cost on large or cold-disk repos and on macOS/Linux; behaviour with submodules, sparse checkouts and `core.fsmonitor`; whether a snapshot inside a worktree session behaves identically (the object store is shared; refs are common).
- Whether Claude Code's native checkpointing already covers shell side effects (I believe not; unverified).
- Whether README "150 blocks" includes role-probe/test rows.
- `git clean -fdx` effect on `.agent-state.json`/`.agent-flow/` in a real agent-flow install (I used the ignored-dirs shape and read bin:2253 for .git/info/exclude).
- FAILURE_MODES.md, docs/ADOPTION.md, TRUST_LOOP.md and 00-MATRIX.md were skimmed or grepped, not read end to end; per-whale 07 files read for 110fe80e, 01a1ba9a, e519a401, 6666fa97 only.
- I did not read raw transcripts; evidence quotes rely on plan section 1a and R2.
