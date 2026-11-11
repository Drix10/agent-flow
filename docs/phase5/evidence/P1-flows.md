# P1: end-to-end flow simulation of POSTURE-DESIGN.md (solo / team / strict) vs guard 1.2.7, using the real solo builder

Reviewer: adversarial UX/flow. Read-only. Repo at HEAD d9f7146 (== 1.2.7 code). Nothing outside the scratchpad was written.
Source note: `plan/PHASE5-PLAN.md` and `docs/phase5/evidence/` are NOT in the working tree (plan/ is gitignored, files absent). I read the plan from the scratchpad copy `PHASE5.md` (v3) and the reviews from the scratchpad copies (A,B,C,R1-R3,V1-V4). I also skimmed peer reports P2 (trust anchor) and P3 (taxonomy); I cite them but did not re-run them.

Legend: [RAW] I read the raw transcript (skl range, or the local jsonl). [REPLAY] I ran the command text through the built `extensions/lib/guard.js` `decide()` (role-less, manifest with empty `protected_paths`, temp git repo with a root `.env`; nothing was executed). [DIST] machine-local distillate only. [COUNT] regex count over the local transcripts (upper bound: a heredoc that merely mentions a command also counts). [EST] my estimate.
Scripts and data (all in scratchpad): `p1replay.mjs`, `p1replay2.mjs`, `p1msg.mjs`, `p1key.mjs`, `p1cred.mjs`, `p1first.mjs`, `p1env.mjs`, `p1corpus.mjs` (whole 110fe80e replay, output `corpus-ex-calls110.json`), `p1count.py`, `p1origin.py`, `p1sub.py` (857 subagents), `p1hot.py`.

## 0. Method and three numbers that frame everything

1. I extracted every shell call from the real solo builder's 19-day run (110fe80e main thread: 10,490 Bash/PowerShell calls) and replayed each through today's guard. Result [REPLAY, whole corpus]: 366 calls (3.5%, about 19/day) would be denied: push-default-branch 124, secret-read 123, explicit-refspec 63, force-push/delete 35 (34 are `--delete`, 1 real force), ref-rewrite 19, fetch-refspec 1, no-verify 1. Replay was in a tiny temp repo, so the recursive-search share is an upper bound.
2. Of those 366, the design's `solo` removes only the 124 push-default blocks (34%). The other 242 (66%) are rules the design keeps in T2 or never mentions (secret-read, bare `git push -u origin HEAD`, branch delete of non-`agent/` branches, `git update-ref`). Answer to the design's open question "does solo actually remove the friction": no, not for this user.
3. The same user's workflow changed on 2026-10-25 [RAW 110fe80e #29169-29176, plus lead-to-subagent messages "New owner rule, effective now: never push to main" at #29176-29178 span]: direct-to-main became "branch `pr/<name>` -> `gh pr create` -> agent runs `gh pr merge <n> --merge --delete-branch`", at a fixed 22:30 merge time. Main thread: 124 push-main attempts all dated Oct 18-24; 110 `gh pr create` (all Oct 23+, 108 from Oct 25) and 165 `gh pr merge` (161 from Oct 25, 4 on Oct 23-24) after. Subagents [COUNT, 857 agents, 100,253 shell calls]: 199 subagents ran `gh pr merge` (419 cmds), 259 ran `gh pr create` (466), 81 pushed to main (188), 93 ran a bare `git push`/`push origin HEAD` (221). POSTURE-DESIGN's ICP says "direct-to-main normal". The last 11 days of the corpus say "agent self-merged PRs". That flow is unguarded today (replay: `gh pr merge N --admin` allowed), blocked by design in `team` and `strict`, and not covered by the scoped delete (prefix is `pr/`, not `agent/`).

## 1. Flow simulations (22 flows)

Format per flow: Today = guard 1.2.7 (replay or raw). solo / team / strict = POSTURE-DESIGN as written, with my reading where the text is silent (marked "reading:"). Blocked? / calls / harm prevented? / what the agent sees.
Reading used throughout: solo = T1 allow+log; team = T1 blocked, scoped merged delete allowed, self-merge blocked for role-less and non-orchestrator; strict = team + reset --hard blocked + hot paths + `ask` never. Every ordinary Claude/Pi session and every subagent is role-less (roles exist only inside agent-flow's own pipeline).

### F1. Heartbeat/loop turn at 3am commits and pushes to main (the Oct 18-24 style)
- Today: `git add -A && git commit ... && git push origin main` is denied as ONE call (push-default-branch). The commit never runs (V4 #232-233 confirmed in raw). Message: "agents never push to the default branch - push agent/issue-N and open a PR." Nobody is there; the agent either stops (heartbeat says "stay quiet") or reroutes. Raw cost when a human is present: 01a1af0d #232-243 about 6 calls (empty branch pushed, `gh pr create` failed "No commits between", rerun) for 1 intended call.
- solo: allowed + logged, 1 call. Nothing reads the log at 3am.
- team/strict: same deny as today. With nobody present the reroute is push `agent/x` + PR, then the merge is blocked (role-less). Work stops at an open PR until morning. Each later heartbeat (cron 17,47: 48 ticks/night) re-reads the context and re-hits the same wall, or the agent probes for another route (01a1ba9a #5390-5412 probed hooks, config, PATH).
- Blocked? team/strict yes, the whole chain. Harm prevented: 0 demonstrable (private repos; every push was ordered or under a standing order).
- Measured turn origins [COUNT, p1origin.py]: of 128 main-thread `git push ... main` commands, 76 followed a human message, 42 followed a subagent task-notification, 10 followed a context continuation, 0 followed a heartbeat turn. So the "3am" risk is not the heartbeat prompt itself; it is autonomous turns (notification + continuation = 41% of pushes) that carry no human message.

### F2. Scheduled agent PR self-merge (the real post-Oct-25 factory loop)
- Today: `git push -u origin pr/x` (named) allowed; `gh pr create` allowed; `gh pr merge 93 --merge --delete-branch` allowed [REPLAY]; `--admin` also allowed. Zero blocks. [RAW 110fe80e #29169-29172: PR 93 merged in 2 calls].
- solo: allowed + logged. Fine.
- team: `gh pr merge` blocked for role-less. In this corpus that is 165 (main) + 419 (subagents) merges. The 22:30 scheduled merge stops. Deny must say who merges; at 22:30 nobody does.
- strict: same, plus the agent cannot open a PR that changes `.github/workflows/` (hot path) - #29162-29164 is exactly that edit (the owner's CI-cost cut).
- Harm prevented under team: nothing in the data (author = merger = owner). Under team in a real team: that is the intended control (review gate), so the block is right there but the posture must be declared per team, not defaulted onto a solo repo.
- Message the agent sees today under team (must be written): none exists; `gh pr merge` has no rule in 1.2.7.

### F3. User says once: "also push your commits" (01a1ba9a #5385)
- Today [RAW #5388-5408]: push main denied (#5389); agent retried identical command + probed `.git/hooks` (#5390), `git config --list`/hooksPath (#5392, itself blocked #5393), took the PR path (#5396-5400: branch, push, `gh pr create`, `gh pr merge` unguarded), tried to delete the merged branch (#5402, denied "force-push / delete rewrites shared history. Push a new commit instead.", names no lawful path). 10 calls for 1 intended; 3 pure probing; final delete never done.
- solo: 1 call. team/strict: same 10-call ladder, but now merge is also blocked (role-less) and delete is allowed only for `agent/*`: the agent opens the PR and must stop with "ask the user to run `! gh pr merge 594 --merge`". That is 1 human turn instead of 0.
- The design cannot tell "once" from "standing": posture is repo-wide and permanent; `pause --for 30m` is the only per-instruction tool and it is human-run. For a one-shot order the correct path is `! git push origin main` typed by the user (Claude `!`, Pi `!` - verified in Pi docs on disk, usage.md "Run a terminal command").
- Message: today's text is fine for the push; the delete text is wrong (R2-13).

### F4. Standing "push to main after all changes" (6666fa97 #12480; continuation summaries "run `git push origin main` alone")
- Today [RAW per V4 section 5]: ~10 agent pushes to main Oct 11-16, no agent-flow in that repo (tracekit only). If installed: every push denied; the order lives in a chat summary, so after each of the 62 context continuations the new agent context [DIST 110fe80e CONTINUATIONS-FULL] starts from "push main alone", is denied, re-learns the PR path. Expect 62 re-learnings of 3-8 calls [EST ~190-500 calls].
- solo: free + logged. The posture is the grant; it has no expiry and no scope; 6666fa97's standing order covered "respective repos" including a PUBLIC repo whose history had a `.env` leaked for a year (#4718). Solo on a public repo should not be a silent default.
- team/strict: blocked; the standing order is not a channel (a summary is agent-written text; the platform itself teaches "not a user message", 110fe80e F1).
- Fix needed: time-boxed, scoped, human-run grant (section 5, G1) and a posture line injected at session start so a fresh context starts compliant.

### F5. Cleanup of 34 merged remote branches (01a1ba9a #5437-5440, Nov 9)
- Today: `git push origin --delete <b>` = force-push rule; a loop dies at the first segment (REPLAY: `for b in a b c; do git push origin --delete $b; done` -> force-push). The first delete (#5403) is what caused the user to ask how to stop agent-flow (#5409) and the agent to run `pi remove` (#5425) [RAW].
- Branch names in that sweep: `feat/*`, `fix/*`, `docs/*`, `chore/*` (#5387 listing), NONE are `agent/*`.
- solo: "delete merged agent branch" is T1-free. Reading A (agent/* only, as plan B3 and R2-04 propose): the 33 branches stay blocked; same failure as today. Reading B (any merged): allowed, but also a `staging`/`release/1.x` equal to main (R1-S4) and a loop of 33 deletes with no cap.
- team: scoped delete is `agent/*` only: all 33 blocked, plus a `pr/*` branch (the owner's own prefix) blocked; the user must run the loop with `!`.
- strict: blocked.
- Squash/rebase merges: `git branch -r --merged` returns nothing, so an ancestry probe says unmerged (R2-04.2). The 33 here were merge-commit merges, so the owner's data happens to pass.
- Message needed: "could not prove `feat/x` merged into main; merged branches: `agent-flow clean --yes`; or ask the user to run `! git push origin --delete feat/x`".

### F6. Windows worktree delete locks (110fe80e Oct 28: 34 os-permission hits; 51 main + 187 subagent `worktree remove --force`)
- Today: agent-flow does not touch worktree remove (REPLAY: allowed). Windows locks are OS errors; agents route around (rmdir junctions, retry). One identical remove was blocked by tracekit, not agent-flow [RAW V4 4(c)].
- All postures: T0 free in the design text, but the design's own open question lists `worktree remove --force` as possibly irreversible. If a reviewer moves it to strict-block, strict blocks 238 commands in this corpus for 0 observed harm. Keep T0; protect uncommitted work with a pre-remove check (refuse only when `git -C <wt> status --porcelain` is non-empty AND the remove is `--force`), not a blanket block.
- Hook latency matters here: replay mean decide() cost was about 128 ms/call on this Windows machine (22.4 min / 10,490), excluding node startup. 110k shell calls by 857 subagents means hours of cumulative hook time; not measured per hook, flagging only.

### F7. Agent reads `.env` through `node -e` / `python -c` (110fe80e F7, Oct 28)
- Today: `node -e "...readFileSync('.env')..."` ALLOW; `python -c "print(open('.env').read())"` ALLOW; `cat .env` blocked [REPLAY]. 01a1af30 #155 reroute used `node -e dotenv` as the compliant path (V4 section 6).
- All postures: T2 says "read/write secrets blocked in every posture". That is not what the guard does; the interpreter route is open in every posture and the design text promises otherwise. See section 2.
- What the agent sees when it works around: nothing; no log line.

### F8. Recursive search that happens to traverse `.env` (the biggest friction class in the owner's data)
- Today [REPLAY whole corpus]: 123 secret-read denies. Heuristic classes (not hand-labelled): about 52 recursive search with no explicit `.env`, 29 extract a key value or names (incl. sha256 fingerprint compares and `grep -o '^[A-Z_]*='` names-only), 16 direct file tools on env files, 12 interpreter scripts that merely mention `.env`, 5 `set -a; . ./.env.local` / `--env-file` app launches, 9 other. So about 56% are not secret reads at all in intent.
- Raw: 01a1af0d #96-98 recursive grep with `--include="*.js"` denied (can never match `.env`); #210-212 names-only `grep ... .env | sed 's/=.*/=.../'` killed a whole chain [V4].
- solo: unchanged (design leaves secret read in T2; "recursive search near env files?" appears in T1 with a question mark).
- team/strict: unchanged or stricter.
- Message today: "`grep` reads . recursively, which holds .env" then, in the generic text, "(human only) launch with AGENT_FLOW_ALLOW_SECRET_READ=1" printed to the agent. The agent should never be shown an override name.

### F9. User pastes a live key in chat, agent files it (110fe80e Oct 21, #15196 region)
- What happened [RAW #15192-15197]: user asked ".env git ignored, paste the keys here in chat". The agent checked the file is ignored, rewrote the key into `.env.local` with `grep -v ... > .env.tmp && printf ... >> .env.tmp && mv`, proved it was ignored, printed masked values (`sed 's/=.*/=.../'`), then tested the key with a local checkout call. Careful and correct. The key is now in the transcript.
- Today [REPLAY p1key.mjs]: that chain is denied as secret-read (the `grep -v` reads `.env.local`); `printf ... >> .env.local` ALLOW; `sed 's/=.*/=.../' .env.local` denied; Write/Edit tool on `.env.local` ALLOW; `set -a; . ./.env.local` denied.
- All postures: T2 "write secrets" would deny the very flow the owner sanctioned and the agent did safely. No posture detects the paste, and nothing warns the user the key is now in a logged transcript (Oct 21 rclone OAuth tokens too).
- Harm today: key lives in transcript; the guard saw 0 events that day (audit join, 06-VERDICTS "missed (structural)").

### F10. 400-command chained script with one T1 command
- Today [REPLAY]: a 400-segment `&&` chain with `git push origin main` last is denied in 2 ms, whole call. In this corpus 1,128 of 10,490 main calls (10.8%) and 764 of 4,343 in 6666fa97 (17.6%) have 15+ separators [COUNT]. Heredoc commit messages are scanned: `git commit -F - <<EOF ... ; git push origin main` -> push-default-branch; CRLF variant same. `bash run.sh` after a script that contains the push: heredoc creation denied, running an existing script allowed; `echo 'git push origin main' | sh` and python `subprocess.run(['git','push','origin','main'])` ALLOW.
- All postures: a deny of any segment discards every segment. The design's metrics mention "commands that never ran because a chain was denied" but the deny text does not tell the agent that earlier segments did not run (V4 #233: agent believed the commit was blocked).
- Fix: message lists the offending segment and states "the whole call was refused; nothing in it ran".

### F11. Usage-limit stop and resume (237 limit hits, 62 continuations, 286 heartbeat turns)
- Today: agent-flow plays no role. Native classifier denied `--resume` ("Interfere With Workloads") and allowed it after the user ordered it in chat (F3 in 09-FULLTEXT).
- Postures: `pause --for 30m` is wall-clock; a limit stop lasts hours, so a pause granted before a limit stop expires while the agent sleeps and the first call after resume hits the block with nobody there. Posture and pauses are read fresh per call (stateless), good; but nothing carries "what I learned about this repo's rules" across the 62 continuations, so every continuation re-trips the same denies (F4).

### F12. Fan-out: 857 subagents each pushing/merging
- Today [COUNT subagents]: 81 subagents pushed main (188 cmds), 93 bare pushes (221), 17 `push --delete` (25), 18 force pushes (18), 199 `gh pr merge` (419), 143 `worktree remove --force` (187), 98 `branch -D` (159), 389 `rm -rf` (1,288), `git reset --hard` 0, `git clean -f` 5. Under 1.2.7 role-less rules: 188+221 pushes plus 25 deletes plus 18 forces = about 450 denied commands.
- solo: none of the push/merge ones block. team: +419 merge denies. Each subagent has no memory of siblings' denies: [EST] 8 calls x (81 push + 199 merge) = ~2,200 wasted calls (2.2% of 100k) plus a handback that re-enters the main transcript (779 handbacks already drive cost, 05-COST). Halt-and-hand example [RAW V4 4(b) #25342]: "denied `git push origin HEAD:main`... Someone with push permission should run [it]".
- One block repeated by 40 subagents should become one entry for the human, not 40 handbacks.
- Pi caveat (V3): project-scope guard is skipped in headless/child runs, so on Pi fan-out is exactly where the guard is absent.

### F13. Release / tag / publish
- Today [REPLAY]: `npm publish`, `npm publish --provenance`, `gh release create --target main`, `git tag` + `git push origin v1.0.0`, `git push --tags` all ALLOW (no rule). `npm version patch && git push origin main --follow-tags` blocked only because of `main`.
- solo: T2 says "external publish/post blocked in every posture"; implemented: nothing. team/strict same gap. Under solo the T1 push of main is free, so the release path is fully open despite the T2 claim.
- Data: 2 `git tag` in 110fe80e main; publish not exercised. This is a promise with no rule and no data; either implement a short verb list (npm/pnpm/yarn publish, `gh release create|edit`, `twine upload`, `cargo publish`, `docker push`) or delete the sentence.

### F14. Deploy step (`npm run deploy` of the site, wrangler/vercel)
- Today: allowed. 110fe80e main [COUNT] 71 deploy-ish commands; the Oct 21 "deploy so we can verify" order. Under solo hot-path `deploy/` is path-based: it blocks editing files under `deploy/`, not running a deploy. T2 "destructive remote/prod writes" has no detector.
- Native layer did gate publication-class actions (54 native denials in 110fe80e, incl. Out-of-Place Publication, Real-World Transactions, Modify Shared Resources). Agent-flow added nothing there; stacking a second layer of unlike deny texts doubles friction where the native layer already stops the agent.

### F15. User asks "how do I stop agent flow" (01a1ba9a #5409)
- Today: no `pause`; the only answer the agent found was uninstall; it ran `pi remove` itself (#5425). User: "ok, now continue, its removed" (#5427); the in-memory extension still blocked (#5429-5430); a restart fixed it.
- solo/team/strict with plan B4: agent-run uninstall is blocked; the answer becomes "ask the user to run `agent-flow pause --for 30m`" in the user's own terminal. Pi `!` works (verified in docs); Claude Code `!` works (6666fa97 #4719 used it).
- Gaps: (1) in a heartbeat session the user is not there to type it; (2) the reply must not leave the agent holding a one-liner that disables the guard (the deny text for self-disable is itself the instruction the agent may relay); (3) if the user's real wish is "switch to solo", pause is the wrong tool: `agent-flow posture set solo` should be the first answer, `pause` the second.

### F16. First run, brand-new solo repo (details in section 4)
- Today: `install --harness claude` makes the push ban live before `init` (REPLAY p1first.mjs: with manifest=null, `git push origin main` still denied, `cat .env` denied, `git push -u origin HEAD` denied explicit-refspec).
- Design: unknown posture = team, solo only from the default-branch committed manifest. First deny arrives within the first task.

### F17. Leaked-key purge (6666fa97 #4701-4720)
- What happened: agent found `.env` in public history, rebuilt history in a mirror with `git filter-repo`, tried `git push --force` to the public repo, blocked by tracekit (#4716), handed the exact command with sequencing warnings (#4718), user ran it with `!` (#4719-4720). Agent also listed which keys to rotate.
- Today agent-flow [REPLAY]: `git filter-repo ...` ALLOW, `git filter-branch ...` ALLOW, `git push --force origin main` blocked (force-push). So the agent-flow guard would have stopped the same step, correctly, with a message that names no human-run path.
- solo: T2 force-push still blocks; correct. The rewrite itself and the mirror clone are unguarded and fine. Needs: halt-and-hand message with exact `!` command, and a rotate-keys checklist (R2-07). No posture stops the leak that preceded it: `.env` was committed and public from Nov 2024; `git add .env` is allowed today [REPLAY] in every posture.

### F18. Binary pushed by a sweeping `git add` (110fe80e #33755: 18 MB `yt-dlp.exe` + intake files on a remote branch)
- Today: `git add yt-dlp.exe`, `git add -A` ALLOW; nothing checks size or binary type. The agent caught it, then "deleted that unmerged branch and opened the PR from a clean one".
- solo: T1 push free; a binary can reach main. team: reaches an agent branch; PR is the catch. No posture addresses it. Hint of substitution: a blocked op (force) was replaced by an equal-effect op (delete + fresh branch); the design treats branch delete as T1 and cannot see substitution.

### F19. Force-push of own branch after a rebase (110fe80e Nov 1; 7 tracekit blocks)
- Today: `git push --force-with-lease origin agent/x` denied (REPLAY `+agent/x` also). T2 in all postures. Handbacks: "Rebasing would have needed a force push, which the tracekit hook blocks" and Oct 27 "I deleted that unmerged branch and opened the PR from a clean one" [V4 4(d)]. 31 `git rebase` commands in main; 18 force-push commands in 18 subagents.
- The block is on the owner's own, unshared feature branch. The design's T2 wording is "force-push shared history"; the guard has no notion of shared. Needs: allow `--force-with-lease` to a branch prefix the agent created (agent/, pr/) in all postures; keep default/protected/tags blocked.

### F20. "env in git is fine, private repo" (110fe80e Oct 21 09:48 [DIST SECRET-PROMPTS])
- Today [REPLAY]: `git add .env`, `git add -f .env`, `git commit -m x .env` ALLOW; `git rm --cached .env` ALLOW. Only the pre-commit hook/secret scan (if installed) could stop it.
- solo (hot path `.env*` strict): ambiguous: strict for what? If "no agent write", it blocks the owner's own filing of keys (F9). If "no staging", it fixes this. Say staging.

### F21. Spend (8.35B cache-read tokens in 110fe80e; ~$11-13k ESTIMATE; accidental bench launch F8 in 09-FULLTEXT)
- Today: no spend rule. Design: none. solo T1 push-to-main can trigger billed CI/deploy; the owner moved CI to label-only because "the private repo bills every minute" (#29161-29164), and that very workflow edit is a solo hot path (`.github/workflows/`).
- Cost caps are on the ROADMAP for pipeline runs only. A guard cannot meter interactive spend. Honest statement needed in the design (section 5, N7).

### F22. `rm -rf` of untracked scratch (110fe80e #4535, Oct 18)
- Native classifier (not agent-flow) denied `rm -rf out public` (147 MB, untracked, confirmed unreferenced), then also denied the follow-up read-only `git diff --stat` (#4539, #4542): spillover from a destructive denial onto reads. The agent stopped and handed the list to the user (#4538).
- Agent-flow: T0 free. 1,400 `rm -rf` commands in the corpus (112 main, 1,288 subagent) [COUNT]. Blocking any of these would be the largest single friction source in the data; leave T0.

## 2. Where `solo` is too loose (real harm seen, or a stated T2 promise the guard does not keep)

Ranked by distance between the design text and what I replayed.

1. Home-directory credential stores are fully readable in every posture [REPLAY p1cred.mjs]: `cat ~/.aws/credentials`, `~/.ssh/id_ed25519`, `~/.config/gh/hosts.yml`, `~/.npmrc`, `~/.git-credentials`, `~/.pi/agent/auth.json` (this machine has it, 01a1ba9a #5411 lists it), `gh auth token`, `git credential fill`: all ALLOW; Read tool on the same: ALLOW. Only repo `.env*` is protected. T2 "read secrets" is false for the stores that hold the strongest keys. `printenv`, `echo $KEY`, `curl -H "Authorization: Bearer $TOKEN"` ALLOW. 110fe80e used rclone OAuth, GitHub tokens, payment keys; the agent was told "take all credentials from that folder" (Oct 21 18:49).
2. Interpreter reads of `.env` (node -e, python -c) ALLOW in every posture (F7). Hole predates the design, but T2 claims it.
3. Committing credentials (F20): `git add -f .env` ALLOW. Real harm in the data: 6666fa97 public `.env` since Nov 2024.
4. Binary/large file push (F18): no check; real case 18 MB exe on a remote branch.
5. Mass delete: reading B of F5 lets a loop remove every remote branch whose tip is an ancestor of main, including long-lived `staging`/`release/*`; no per-command cap. Real precedent: Nov 3 "git push origin --delete across all non-main branches (user-pasted, executed)" [DIST 08-DEEP-DIVE] - a human decision; as an agent action under solo it would be unattended.
6. Direct-main push to a PUBLIC repo (6666fa97 pushed ~10x; the host repo was public). Solo should not be recommendable when `gh repo view --json visibility` says public.
7. History rewrite of the default branch: `git filter-repo`/`filter-branch`/`rebase --root` ALLOW locally (01a1b7ed #45-46 `rebase --root` rewrote local master; then a push of unrelated-history branch). Then `git push origin main` is T1-free under solo; only force is blocked, so a fast-forward-looking push after a local rewrite is impossible, but a rewrite + `--force-with-lease` to an `agent/` branch is the F19 case. Low residual harm; flag for the strict preset only.
8. Spend (F21): push-to-main triggers billed CI and deploy in repos that have push workflows; no rule.
9. External publish/post (E-autopost-arm, e519a401 U31: autonomous Instagram posting gated by an env flag): the design lists "external publish/post" in T2, but the agent posts through a browser or `curl localhost`; no command shape identifies it (35 `curl ... localhost:10086/command` posts in 110fe80e). T2 cannot keep that promise for browser-driven or HTTP posts.
10. `gh api` / `curl -X PUT` writes to the default branch and `gh pr merge --admin` are open in every posture (R1-S2, R2-03 REPLAYED, I re-ran `gh api -X PUT repos/o/r/contents/x -f branch=main`: ALLOW). Under solo this is moot (main push is free); under team it makes the T1 block a speed bump.
11. Posture trust anchor (P2-F1, read not re-run): "default-branch committed copy" is the local `main` ref; `git branch -f main feat` or a local self-merge moves it. A posture that only a human can relax (user-level setting plus a committed ratchet) fixes it; I recommend adopting P2's text.

## 3. Friction hot-spots the design still leaves (ranked by frequency in the real data)

Counts: [REPLAY whole 110fe80e main thread] unless marked; the subagent column is [COUNT].

| # | Hot-spot | Main (110fe80e) | Subagents | Design status |
|---|---|---|---|---|
| 1 | secret-read false positives (recursive search without `.env`, key-name/fingerprint extraction, app launch with `set -a; . ./.env`, interpreter mentions) | 123 blocks (about 56% not a read by intent) | 376 `.env`-mentioning cmds in 113 subagents | Not addressed ("?" in T1, T2 forbids) |
| 2 | push-default-branch | 124 (all Oct 18-24) | 188 cmds / 81 agents | Solves it only in solo |
| 3 | `gh pr merge` after Oct 25 | 165 cmds (118 after human msg, 38 after notifications) | 419 / 199 agents | Blocks it in team/strict; no PR-flow posture |
| 4 | bare `git push`, `git push -u origin HEAD`, `git push origin $(git branch --show-current)` | 63 blocks (explicit-refspec; some chains) | 221 / 93 agents | Not mentioned; blocks even feature-branch pushes in team/strict |
| 5 | `worktree remove --force` / `rm -rf` / `branch -D` (T0) | 51 / 112 / 104 | 187 / 1,288 / 159 | Free in T0 (open question risks moving them) |
| 6 | push --delete / `:branch` | 35 (34 deletes + 1 force) | 25 / 17 agents | Scoped delete only for agent/* (owner uses `pr/`, `feat/`, `fix/`) |
| 7 | `git update-ref`/for-each-ref snapshot scripts (ref-rewrite) | 19 | n/a | Not mentioned; legit factory snapshot tooling |
| 8 | chain denial discards the whole call | 1,128 calls with 15+ separators | n/a | Counted in metrics; not in the message |
| 9 | force-push of own feature branch | 1 main (7 tracekit blocks per V4) | 18 / 18 agents | T2, no own-branch carve-out |
| 10 | fetch refspec (`fetch origin a:refs/remotes/origin/a`) | 1 | n/a | P3 flagged; not in design |
| 11 | read-only `git config core.hooksPath` denied (no-verify text scan) | 1 (01a1ba9a #5393) | n/a | Plan A fix; message ("Fix the hook failure instead") is wrong for a read |
| 12 | native classifier layered on top | 54 denies in 110fe80e | n/a | Out of scope but compounds; 3 of 54 spilled onto read-only calls |

Total for the owner's run: 366 of 10,490 shell calls denied today (3.5%); under the design's solo about 242; under team about 366 + the 165 merges.

## 4. First-run experience

What exists today [READ bin/agent-flow.js cmdInstall 2161-2247, cmdInit 2563-2625]:
- `npx @drix10/agent-flow install --harness claude`: copies skills, writes the Claude hook into `.claude/settings.json`, vendors the runtime, imports AGENTS.md, prints "Next: doctor; ask Claude to use the agent-flow-bootstrap skill; hook install; commit what install wrote".
- `agent-flow init`: shows AGENTS.md + CONTEXT_MANIFEST.json, asks one question "Write ...? [y/N]". No TTY (the agent runs it) -> "nothing written (not a terminal) - re-run with --yes".
- It asks no posture question today; the design adds "who is this repo for?".

Simulated first 5 minutes of a brand-new solo repo (one human, no remote protection, no CI, `gh` maybe unauthenticated):
- 0:00 install. The hook is live immediately: even with no manifest `git push origin main` denied, `git push -u origin HEAD` denied, `cat .env` denied [REPLAY p1first.mjs].
- 1:00 init -> [y/N]. New design asks "who is this repo for?". Signals: no protection, no CODEOWNERS, no CI, contributors = 1, private. Design text: "No signals -> team". But 1 contributor and private are signals. As written the solo builder is recommended `team`.
- 1:30 user says "use the bootstrap skill"; the agent runs `init --yes` (no TTY). If the new init takes `--posture solo` as a flag, the agent chooses its own posture; if it prompts, the agent cannot answer; either way the agent must not be the one relaxing.
- 2:00 "commit what install wrote": the first commit and push of the installed guard is blocked by the guard just installed (push main). Chicken-and-egg: the human must push it.
- 2:30 solo is honoured "only from the default-branch committed copy". The manifest exists only in the working tree until committed AND pushed (or merged locally, which P2-F1 shows is forgeable). Existing code reads the working copy when no committed copy exists anywhere (manifest.ts:371), i.e. at this moment the agent can edit its own posture; the design says missing = team. These conflict; first-run is the weakest moment.
- 3:00 first real task. Agent commits + pushes. Deny: "agents never push to the default branch - push agent/issue-N and open a PR." Agent retries/probes (3 calls), then branch + PR; the user has no reviewer. Cost: 6-10 calls for 1 (01a1ba9a #5388-5402; 01a1af0d #232-243).
- 4:00 the agent greps the repo (`grep -rn X .`): secret-read deny: "...use the variable name, ask a human, or (human only) launch with AGENT_FLOW_ALLOW_SECRET_READ=1". The user has no secret in mind.
- 5:00 the user asks "how do I stop this"; the honest answers today: `pi remove` or deleting the hook. This is the 01a1ba9a failure chain (3 human turns, 22 tool calls, then the guard gone for the session).

What makes them uninstall, in order (all seen): (1) a block on a routine action with no one-line lawful path (01a1ba9a #5403: delete; push main); (2) the same deny re-appearing every new context (62 continuations); (3) a deny on a read or search (secret-read recursive 52/123; hooksPath read) with a message that blames the user's code ("Fix the hook failure"); (4) a chain denied so a commit silently did not happen; (5) the guard blocking the user's own sanctioned flow (env key filing). The author, who knows how to remove it, did; a stranger will uninstall silently, and the design has no signal for that.

## 5. Subagent fan-out, heartbeat and unattended runs

Who is the human? In an unattended run, nobody. The design's escape hatches (`pause --for 30m`, human-run `!` commands, `ask`) all need a person at a keyboard in the next 30 minutes.

What the guard does at 3am (today and under the design):
- It is stateless and deny-only: same rules as noon. It cannot ask: hook `ask` needs an interactive harness, and the plan (B1) already says `ask` degrades to the stricter side anywhere unverified or headless. I did not verify Claude `ask` behaviour under auto mode or `-p`.
- Pi: project-scope guard skipped in headless/child runs (V3): at 3am on Pi, the fan-out child runs have no guard at all, so any solo/team distinction there is moot.
- Heartbeat prompts are written by the agent itself (CronCreate prompt text, 110fe80e); they carry no human authority. A standing grant cannot be inferred from a cron prompt, a continuation summary or a handback (platform's own framing, 110fe80e F1).
- A denial with nobody present has three outcomes in the data: halt-and-hand (best: 6666fa97 #4718, 110fe80e #25342), reroute (fine: 01a1ba9a #5396), probe or substitute (bad: 01a1ba9a #5390-5412; 110fe80e #33755). The design only helps the first two if the deny text says what to do when no human is present.
- Cost of halting: 48 heartbeat ticks/night x context re-read. 110fe80e burned about 0.4-1.0B cache-read tokens/day; a guard that makes every tick re-attempt a blocked step multiplies that for no output.

Fan-out numbers [COUNT p1sub.py over 857 subagent transcripts, 100,253 shell calls]: 81 subagents pushed main, 199 merged PRs, 143 force-removed worktrees, 389 ran `rm -rf`, 0 ran `git reset --hard`. Each subagent is role-less, so team's rules hit all of them, each learning the PR path alone (about 8 calls each, [EST] about 2,200 calls), each returning a handback into the lead's context. One deny reaching the human 40 times is a UX failure. Needed: (a) the deny writes a de-duplicated "needs-me" entry (rule, command class, count) in the repo's local `.agent-flow/` and says so; (b) the lead's status line / SessionStart text surfaces it once; (c) the posture/grant line is injected into every subagent's context at start (AGENTS.md block), so they begin on the compliant path.

Pause/grant semantics for unattended work: wall-clock `--for 30m` expires during a usage-limit stop and overnight. Use a human-run grant with an absolute `--until` and a scope and a max-use count (G1 below), store it outside the repo, never in a file the agent can write, and log each use. The agent never creates or extends one.

## 6. Concrete changes to POSTURE-DESIGN.md (exact replacement text)

Replace sections in order. Text in quotes is the proposed file text.

### C1. Replace the tier table and the sentence under it

"## Core idea: gate by blast radius, not by action name
| Tier | Examples | Behaviour |
|---|---|---|
| T0 free | edits, commits, local branches and merges, worktrees (including `remove --force` when the worktree is clean), tests, `rm -rf` of untracked non-credential paths, `reset --hard`, reads and searches of repository files | Never blocked. Exception: credential material (T2). |
| T1 posture-dependent | push or merge into the default branch (any channel: git, `gh pr merge`, `gh api`, MCP), delete a remote branch the agent can prove merged, `--force-with-lease` to a branch the agent created (`agent/`, `pr/`) | solo: allow + log; team: PR path (a person merges); strict: blocked |
| T2 always gated | force-push or delete of the default branch, tags or any branch the agent did not create; staging or committing credential files (`git add .env*`); reading credential material (repo `.env*`, home credential stores: `~/.aws`, `~/.ssh`, `~/.config/gh`, `~/.npmrc`, `~/.git-credentials`, host agent `auth.json`, `gh auth token`); disabling the guard; the listed publish verbs (`npm|pnpm|yarn publish`, `gh release create|edit`, `cargo publish`, `twine upload`, `docker push`) | Blocked in every posture; the deny names the human-run command. |
Not claimed: a hook cannot see browser posts, HTTP calls to a local service, or code run inside an interpreter. T2 covers named command shapes only and says so in `status`."

(Reason: the old T2 promised external post/prod writes and secret reads the guard cannot keep; old T0 said "read-only never blocked" and T2 said "read secrets blocked": both cannot be true.)

### C2. Replace the Postures section

"## Postures (one real axis: who lands code on the default branch)
- `solo`: the agent may push to and merge into the default branch. Logged. `agent-flow status` prints a one-line digest of what landed since the last human prompt. Not recommended for public repos or repos with a tracked `.env`.
- `team` (default fallback): the agent pushes `agent/*` or `pr/*` branches and opens PRs; a person merges (`merge: human`). A repo whose person is the owner may set `merge: agent` (agent runs `gh pr merge` on its own PR, never `--admin`, never on a PR it did not open), which is the owner's actual post-Oct-25 workflow.
- `strict`: team with `merge: human`, hot paths enforced, no `ask` anywhere, audit required, `reset --hard` blocked.
Branch prefixes the agent owns are configurable: `branch_prefixes: [\"agent/\", \"pr/\"]` (default `agent/`)."

### C3. Replace Hot-path overrides

"Hot paths (`.github/workflows/`, `deploy/`, infra, migrations) are enforced in `team` and `strict`; in `solo` edits are allowed and logged except edits that add `permissions: write-all`, `secrets.*` exfiltration or `pull_request_target`. Credential files are not a path rule: they are T2 (never staged, never read), but writing a value into a gitignored env file by append or by the Write tool is allowed, followed by `agent-flow env-check NAME`."

### C4. Replace Selection

"## Selection
Posture is user state, not repo state. A repo may only tighten (`min_posture` committed to the default branch, strictest of disk/HEAD/default/origin wins). Relaxing to `solo` is done by a human: `agent-flow posture set solo` (refuses a non-TTY, refuses when AGENT_FLOW_ROLE or any agent session env is present), stored under the user's profile. `init` asks \"who is this repo for?\" only on a TTY and recommends: private + no remote protection + one contributor + no CODEOWNERS -> solo; public, protection on, CODEOWNERS or 2+ contributors -> team; deploy config or migrations -> strict. If the answer is not given by a human, the posture is `team`. `init --yes` run by an agent never changes posture."

### C5. New section: Unattended runs

"## Unattended runs (heartbeats, loops, subagent fan-out)
- There is no human; the guard never asks, never waits and never reads a standing order from chat, a cron prompt, a continuation summary or a subagent handback.
- A human may issue a grant outside the repo: `agent-flow grant <rule> --until <timestamp> [--scope <branch|path>] [--max 20] --reason \"...\"` (TTY only). Grants are absolute-time, scoped, counted, logged, and never writable by an agent session. `pause --for` is for attended use only and is shown in `status`.
- A denial in an unattended run writes one de-duplicated entry to `.agent-flow/needs-me.jsonl` (rule, command class, count, first/last time) and the deny text tells the agent to continue other work and stop pursuing the same outcome.
- At session start the guard injects one line into the agent context: `agent-flow: posture=<x>; land work by <rule>; blocked actions: <list>`. This is cheaper than every context re-learning it from denials (62 continuations in the reference run)."

### C6. Replace the deny contract

"Every deny has four parts and one fixed sentence: (1) the rule and the segment that fired; (2) what did NOT run (`The whole command was refused; nothing in it ran`); (3) the lawful alternative as an exact command, or `none: ask the user`; (4) for halt rules, the human-run form (`ask the user to run \`! <command>\``). Fixed sentence: `This is agent-flow's guard, not a git hook; re-running, inspecting hooks or reaching the same outcome another way will not change it. Do the rest of the task, then stop and tell the user.` No deny message names an override variable or a way to loosen the guard."

### C7. Exact messages for the top rules

- push-default-branch (team): `[agent-flow guard] push-default-branch: pushing to main is not allowed in a team repo. Nothing in this command ran. Instead: git push -u origin agent/<topic> && gh pr create --fill. A person merges. If the user wants this pushed now, ask them to run: ! git push origin main  (or: agent-flow posture set solo).`
- merge (team, merge: human): `[agent-flow guard] agent-merge: this repo wants a person to merge. Your PR is open; tell the user its number and stop. To merge it themselves: ! gh pr merge <n> --merge`
- branch delete (cannot prove merged): `[agent-flow guard] branch-delete: could not prove origin/<b> is merged into main (remote tip <sha> is not an ancestor; no merged PR). Merged agent branches: agent-flow clean --yes. Others: leave them, or ask the user to run: ! git push origin --delete <b>`
- bare push on a non-default branch: allow; resolve `HEAD`/`push -u origin HEAD` against the current branch (no message needed).
- secret-read (search that only traverses an env file): `[agent-flow guard] secret-read: this search would read .env. Narrow the path (e.g. src/) or add --exclude='.env*'. To check a variable: agent-flow env-check NAME (prints set/missing, never the value).`
- credential store read: `[agent-flow guard] credential-store: ~/.aws, ~/.ssh and similar hold keys that unlock other systems. Ask the user to run the command and paste only the non-secret part.`
- self-disable: `[agent-flow guard] self-disable: removing or bypassing the guard is the user's decision. Tell the user: run agent-flow posture set solo, or agent-flow pause --for 30m (in your own terminal; in Pi or Claude type ! before it).`

### C8. Replace Mechanism's last line and Metrics

"A kill switch (`AGENT_FLOW_GUARD_LEGACY=1`, human launch only) restores pre-posture behaviour and is logged.
## Metrics
Per rule: false-block and false-allow rate on a labelled corpus built from the reference run (366 denied / 10,490 shell calls today; solo must remove at least the 124 push + 63 explicit-refspec + 52 recursive-search blocks without flipping any harm fixture). Friction budget per compliant landing: at most 3 extra calls (today 6-10). Report: chain-denials, retries of an identical command after a deny (stop-and-ask after 2), needs-me entries per night, grants used, pauses, uninstalls, guard-on coverage."

### C9. Replace the open question list with decisions

"Decided: three postures are two (solo, team) plus one preset (strict = team + more). T0/T1/T2 are as in C1. Posture is user state (C4). Unknown: whether `ask` exists in headless/auto mode on each harness; whether hook input rewriting (appending `--exclude='.env*'` to a recursive grep) is available on Claude/Pi; squash-merge detection offline."

## 7. What I could not verify

- Claude Code hook `ask` and `updatedInput` behaviour (auto mode, `-p`, bypass modes) and which harnesses implement them. Pi `!` and `user_bash` were verified only from docs on disk.
- Whether the PreToolUse hook fires for every subagent tool call on Claude in the owner's setup (the corpus's subagents ran with no agent-flow installed); the fan-out numbers are what the subagents did, not what a hook did.
- Replay realism: temp repo with a root `.env`, empty protected_paths, role-less; commands were judged, never run. The recursive-search share (52 of 123) depends on repo layout and is an upper bound. The secret-read class split is a regex heuristic, not hand-labelled.
- Turn-origin attribution (p1origin.py) uses the last non-tool-result user message; chains after a human message are labelled "human" even when the agent acted alone. Subagent calls are not in the main transcript, so the heartbeat share of subagent pushes is unknown.
- `gh pr merge` self-merge date and the owner's reason (contribution counting, "22:30" timing): inferred from agent-to-agent messages and PR 93, not from a human message.
- Wasted-call estimates for fan-out and continuations are [EST]; raw ladders (01a1ba9a, 01a1af0d) are the only measured ones.
- Whether `gh pr list --state merged` or branch-protection lookups work offline or with a non-admin token.
- Not re-run: P2's trust-anchor replays, R1's refspec/quoting replays (cited from their reports).
