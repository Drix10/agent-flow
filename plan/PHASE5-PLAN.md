# Phase 5 plan v3: rebuild agent-flow guards from the eval (DRAFT for maintainer decision)

Status: draft v3 = v2 (three-way adversarial critique) + full verification pass (live hook tests on Claude Code, local stubs on Pi/OpenCode,
docs/source for Codex/Gemini/Cursor/others, raw-transcript re-reads, local git/rg/gh/node checks). Harness- and model-neutral architecture added (section 2b). Nothing is built.
Verification reports: plan/reviews/V1-claude.md, V2-codex-gemini-cursor.md, V3-pi-opencode-others.md, V4-raw.md.
`plan/` is gitignored; reviewer reports are copied to `plan/reviews/` (A/B/C = code+evidence audits, R1/R2/R3 = critiques).
Code line numbers are at HEAD d9f7146 (== v1.2.7 for all code).
Verification legend: [RAW] I read the raw transcript; [REPLAY] I replayed it against the built guard or real hook; [REPORT] a reviewer claims it, unverified by me.

## 0. The one-paragraph answer

Draft v1 was a good false-block plan built on a guard that has live holes. v2 reorders: first close the holes that make any relaxation
meaningless (Release A, a security patch with the same policy), then ship the user-facing relief as configurable strictness presets
(Release B), then the detection/UX extras (Release C). The data supports neither keeping nor deleting the blanket blocks (about 1 clear
catch vs 4 false or over-broad blocks in live agent-flow events, all from one owner on one cheap model), so the right output is
floored, configurable presets, not hardcoded relaxations, and not a personal allowlist.

## 1. Facts that drive the plan

### 1a. Corrections to the eval (fix records before building)
- [RAW] 01a1ba9a: the AGENT ran `pi remove npm:@drix10/agent-flow` (#5425) after the user asked "...or tell me how to stop agent flow" (#5409); nothing blocked it.
  Ledger/MAP-1/MAP-15/04-HUMAN say "user removed". The guard also stayed live in the running session until restart (#5429-5430).
- [RAW] The delete of an already-merged branch was blocked twice (#5403, #5429); the agent itself wrote that for a merged branch the stated reason does not apply (#5408).
  That false block is what led to #5409. Also [RAW] #5393 blocked a read-only chain ending in `git config core.hooksPath`.
- [RAW+REPLAY] The "compliant path" ended in the agent running `gh pr merge` (#5400, under a standing user merge instruction); `gh pr merge` has no rule.
- "worked x4" is overstated (#5389/#5391 one retried push); scorecard force-push count "3" contains 2 deletes (only 1 real force-push block, 01a1b7ed #48);
  the Nov 8 "missed-unwired" exhibit was retracted in the ledger but scorecard.md still cites it.
- [RAW, V4] 01a1af0d: push block = worked (user-ordered push; the whole `add && commit && push` chain was denied so the commit never ran; agent took a PR path, ~3 wasted calls);
  secret block #96-97 used `grep --include="*.js"` (cannot match .env) = over-broad, so "warn-only would have leaked .env at 04:23" is REFUTED; secret block #210-212 denied a chain whose .env grep was already value-masked = over-broad;
  fetch block (~#1194) `fetch ...:refs/remotes/...` writes a remote-tracking ref only = false block. The note "rerouted to sed-redacted read" is wrong.
- [RAW, V4] f1c432dc: verdict is NEUTRAL (the quoted reset-hard block is the agent's own words inside pasted history; skl labels pasted text as user; the "37 mentions" figure does not hold; the one real event was a mixed protected-path command, agent rerouted via a generator script).
- [RAW, V4] 01a1b7ed: block CONFIRMED but "dodge" REFUTED: #47 chain was denied whole, so `branch -D master`/orphan commit never ran; #49 `reset --hard ...; push` was an attempt to follow the deny text and was itself denied (~4 calls of friction). A local `rebase --root` (#45-46) ran unguarded.
- [RAW, V4] 110fe80e: Oct 23 `HEAD:main` denial = native classifier (agent obeyed); Oct 25 `worktree remove --force` = tracekit (only the second ran blocked); Oct 27 "deleted the unmerged branch to dodge" = self-reported, hook unnamed (probably tracekit), unverifiable; the standing "run `git push origin main` alone" is a tracekit workaround. None of these is agent-flow.
- [RAW, V4] 6666fa97: all ten pushes were agent-run Opus Bash pushes in non-flow repos, none blocked, no agent-flow text; only `push --force` (#4715) was denied by tracekit and the user ran it with `!`. Message numbers cited in the knowledge base are off by one.
- [RAW, V4] 01a1af30 #151-155 CONFIRMED: the chain was denied whole on a names-only `grep -o "^[A-Z_]*=" .env`; the reroute was `node -e` dotenv set/MISSING, which the guard cannot see into.
- Live-event tally (agent-flow only, corrected): push-default-branch 3 episodes / 0 demonstrable harm prevented (1 user-ordered, 1 user-ordered chain, 1 factory); force-push 1 plausible; branch delete 2 false; hooksPath 1 false; secret-read 5 events with 0-1 real catch (2 over-broad, 1 over-broad chain, 1 worked); fetch 1 false.
  Hooks block WHOLE chains, so the real cost includes commands that never ran (01a1af0d #233). "5 live push blocks ended fine" is really 3 episodes on one model.
- MODEL EVIDENCE (V4): sessions since Oct 1 by model: opus-5-5 x121, sonnet-5-5 x19, muse-spark x17, haiku x8, codex x1. Under agent-flow: ONLY muse-spark (obeyed and rerouted; also probed the guard as if it were a git hook, #5389-93, and ran `pi remove`, #5425). Opus/Sonnet/GPT never ran under agent-flow here; under tracekit and the native classifier Opus and Sonnet halted and handed the command to the human, adapted command shapes (`commit --file=-`, push alone), and made one self-reported equal-effect reroute.
  No evidence of a frontier model attacking or disabling a guard, and none of one being under agent-flow. Model-neutrality is therefore a DESIGN property here, not an evidenced one; do not claim otherwise.
- Unplanned harm in the data: a 2024 `.env` found in public git history (leaked since Nov 2024, 6666fa97); an 18 MB binary pushed to a remote branch (110fe80e #33755); local history rewrites (`rebase --root`, `branch -D`) unguarded.
- a8c1e208 "sudo": a tracekit block (another product) on slide text; agent-flow has no sudo word-match. MAP-17 is retargeted to agent-flow's own overblocks.
  The substring hazards below are CODE-AUDIT findings (synthetic replays), except the positional hooksPath read, which is live.
- Corpus limits: one human who authors agent-flow; 110fe80e is ~47% of tokens and ~77% of the "worked" count with zero agent-flow events; live agent-flow enforcement
  with a transcript is 4 pi sessions (Nov 6-9) on one cheap, obedient model; Windows only. No strong autonomous model has run under agent-flow here.
- 584 of 756 baseline blocks are `agent-flow update` role probes (test traffic); `source` is spoofable, so it is a dev-hygiene tag, not an authenticated one.
- Hygiene: key-shaped tokens remain in knowledge/whales/01a1af30 (00-COMPACT.md, 01-INTENT.md); the raw skl store holds an OpenRouter key (01a0b38f #1331) and PATs (01a0b5f7 #4258/#4272).
- SECURITY.md:42 says recursive `grep -r` over an env file is "not detected"; CHANGELOG:159 and the guard say it is. Fix the doc.

### 1b. Holes in the CURRENT guard (all role-less unless noted; these were not in draft v1)
| ID | Hole | Evidence |
|---|---|---|
| H1 | Quoting defeats the push ban: `git push origin 'HEAD~0:main'`, `"HEAD^{commit}:main"`, `'+HEAD~0:agent/x'`, `'+refs/heads/*:refs/heads/*'` all allowed (decideGit parses stripQuoted text, guard.ts pipeline A) | [REPLAY] |
| H2 | Corrupting the manifest disables the floor: write `{` to CONTEXT_MANIFEST.json (role-less Write is allowed), then `cat secrets/db.txt` goes block -> allow through the real `agent-flow guard` hook (loadManifestForGuard returns null on parse error, manifest.ts:348) | [REPLAY via real hook] |
| H3 | CRLF heredoc hides what follows: `cat <<EOF\r\nhi\r\nEOF\r\ncat .env` is allowed (LF version blocks) | [REPLAY] |
| H4 | Remote default-branch writes are unguarded: `gh pr merge --admin/--auto`, `gh api -X PATCH .../git/refs/heads/main -F force=true`, `-X DELETE .../refs/heads/main`, `-X PUT .../contents/x -f branch=main`, `curl` to the API; also (REPORT) `gh repo edit --default-branch`, `gh release create --target main`, GraphQL mergePullRequest/auto-merge | [REPLAY] first five |
| H5 | `git config --show-scope core.hooksPath /dev/null` is a real write but allowed (`--show-*` treated as read marker); also (REPORT) `core.hooks''Path`, `GIT_CONFIG_*` env forms, `alias.ci 'commit --no-verify'`, `echo >> .git/config` | [REPLAY] first; rest [REPORT] |
| H6 | Self-removal routes allowed for role-less sessions: `pi remove`, `npm uninstall @drix10/agent-flow`, `rm -rf node_modules/@drix10/agent-flow`, `agent-flow uninstall --yes`; (REPORT) host-config edits under `~`, `pi --no-extensions`, `claude --settings`, missing guard file makes the hook exit 1 = non-blocking | [REPLAY] first four |
| H7 | Secret-read gaps: walk budget returns allow when exhausted (20k entries / 1.5 s; guard.ts:1454,1463); (REPORT) `grep -r KEY $PWD`, `grep -rn KEY *`, `rg -g '.env*'`, `git grep --no-index`, `find -exec cat`, `| xargs cat` | budget [code]; rest [REPORT] |
| H8 | `AGENT_FLOW_ALLOW_PROTECTED=1` lifts far more than protected paths: bulk-git, catastrophic-delete, obfuscated-command, deny-command, guard-wiring (and `reset --hard`) | [code] bin:1301, guard.ts |
| H9 | Role-less sessions get no agent-config, no role-tool, no outside-repo check; no scan for secrets being WRITTEN (Oct 21 class) | [REPORT] |
| H10 | Audit: harness hardcoded `"claude"` for all CLI-path blocks (bin:1306); Pi logs none; `reason` appended unredacted; redaction misses `curl -u u:p`, URL userinfo, `--password x`, JWT, `glpat-`, `sk_live_`, AWS secrets; `touch .agent-flow/audit.lock` forces `unchained`; `rm -rf .agent-flow` restarts the chain | [code]/[REPORT] |
| H11 | Hook exit semantics: Claude treats exit 1 (and a 60 s timeout) as non-blocking | [REPORT, unverified live] |

### 1c. Current code reality (agent-flow 1.2.7)
- One decision function `decide(g)` (guard.ts:1877), all rules through `block(rule, reason)` (:207), ~30 rule names. Hook harnesses call `agent-flow guard` (bin:1261); Pi has its own `tool_call` hook (extensions/guard.ts:69).
  It is NOT purely pure: `reviewedScript` already runs git with a 10 s timeout (guard.ts:1800). [REPORT]
- Two shell pipelines in guard.ts: (A) string-based `expandCommand/segments/parseGit/decideGit` (git rules); (B) real tokenizer `lexShell` + `effectiveArgv` (:593-792; secret-read and write targets). Neither enters `bash -c` bodies. [REPORT]
- Push to main/master always forbidden, no manifest key. `reset --hard` is `bulk-git-protected`, only while `protected_paths` is non-empty. hooksPath = `no-verify` (raw regex guard.ts:1683). Branch delete = `force-push`.
- Manifest: `FLOORED_KEYS = gates, policy, secret_scan, pipeline, review_paths` come from the default branch's committed copy, else HEAD, else disk (manifest.ts:358-375). `policy` has `additionalProperties:false` in the schema. Only the implementer role is blocked from editing the manifest ("governance").
- Hook can only deny: output is hardcoded `permissionDecision:"deny"` (bin:1314); repo precedent is "deny, not ask: a headless pipeline has nobody to answer". `confirm.ts` is a Pi-only dialog for three agent-flow write tools.
- `status`: one guard row per repo; Claude verified via `guard --check`; codex/gemini/cursor/opencode = file-presence warn (tests/status.test.js:70,76-77 pin wording). `doctor` reports nothing about the guard. hooksPath-elsewhere gives a warn that never names hooksPath.
- `codex exec` IS supported (pipeline launches roles with it; hook live-verified headless on Linux/WSL); nothing detects an untrusted hook or bypass flags. docs/HARNESS-MATRIX.md contradicts itself (rows 12-15 vs lines 30-34).
- Existing corpus: tests/redteam/corpus.json 143 entries (92 block, 43 allow, 8 gap) asserting block/allow only, no rule name. 514 tests overall.
- Release mechanics: lint -> test (pretest builds); 7 version slots (package.json, package-lock x2, 2 plugin.json, marketplace.json, gemini-extension.json) + README/docs/ADOPTION.md tag refs + `## [X.Y.Z]` CHANGELOG (scripts/check-versions.mjs);
  publish via GitHub Release (npm-publish.yml, provenance). Skill/template copies are hand-synced (5 copies; dogfood.test.js fails on drift). Installed hook commands match `canonicalOurs` regexes requiring `guard\s*$` (bin:2352, 2465).
- Precedent: 1.2.6 and 1.2.7 patches already carried guard false-block fixes and audit fields.

## 2. Principles for the design (what "balanced" means here)
1. Close holes before relaxing anything. A relaxation on a bypassable rule is theater; a hole fix is a security patch with no policy change.
2. Relaxations are data, not code: floored manifest presets plus a never-relaxed floor. No personal allowlist, no one-off hardcoded allows.
3. Prefer reroute over halt only when a lawful path exists and works in one step; otherwise halt-and-hand with the exact human command. Every deny names which.
4. Never honor something we cannot evaluate exactly (a false allow leaks or loses data); do not re-implement grep/rg/git matching.
5. Every change ships with a failing fixture first, a regression test, a CHANGELOG line, and a way back (kill switch + patch release).
6. Say honestly what the guard cannot do: the user's own terminal is unblockable; server-side branch protection is the real boundary for default-branch writes; the audit is unauthenticated.

## 2b. Harness- and model-neutral architecture (what "supports every agent after" means)

Design rule: enforcement never depends on which model is driving or on the model cooperating. Everything model-specific stays out of the core; everything harness-specific stays in a thin adapter.

1. ONE decision core (`decide`, pure-ish, probe injected) + `lib/guardrun.ts` (decision -> audit -> verdict) shared by every adapter.
2. ADAPTERS only translate: harness stdin/plugin event -> normalised `GuardInput` (tool kind, command argv, paths, cwd, session, agent_id, model if given), and verdict -> that harness's deny wire format.
   Common denominator verified across Claude Code, Codex, Gemini, Cursor, Copilot, Qoder, Factory, Command Code, Augment, Windsurf (docs): a command hook with stdin JSON that denies via exit 2 and/or JSON `permissionDecision:"deny"`. So one `agent-flow guard --harness <h>` serves all of them; only the config writer and the field map differ.
   Normalise tool KIND (shell / write / edit / read / mcp / subagent / code-exec), not tool names: Claude `Bash`, Gemini `run_shell_command`, OpenCode v2 `shell`, Codex `apply_patch`, Cursor `Shell`. Gap found: OpenCode v2 `execute` (Code Mode) and `subagent` pass `git push origin main` and `cat .env` today [REPLAY]; add `code-exec` as an opaque-script class (deny by default or inspect).
3. VERDICT is deny-only, emitted on all three channels at once (JSON deny on stdout, reason on stderr, exit 2). Already true in bin:1311-1314. Verified why: Gemini ignores a bare exit 2, Codex's prompt hook ignored exit 2, Claude accepts either. Never `ask` for enforcement: Codex PreToolUse has none, Cursor ignores it on `preToolUse`, Gemini and Claude headless turn it into deny, OpenCode `--auto` auto-approves it.
4. FAIL-CLOSED WRAPPER: every verified harness fails OPEN on crash, missing script, exit 1, timeout and bad JSON (Cursor only with `failClosed:true`, already set at bin:2480). The guard must catch its own errors and emit the explicit deny itself, set an explicit hook timeout, use absolute paths (`${CLAUDE_PROJECT_DIR}`; relative paths fail open on a wrong cwd), and strip a stdin BOM (already, bin:1275). Claude 2.1.295+ also has hook field `onFailure:"block"` (ignored on 2.1.287): add it and state a minimum version.
5. CAPABILITY MODEL per adapter (data, drives presets and `status`): can_deny, can_ask(never used), headless_runs_hooks, covers_subagents, covers_file_edits, covers_mcp, trust_gate (Codex hash-trust, Pi project-trust, Cursor workspace-trust), fail_open_on, managed_policy_available, model_in_event. A preset that needs a capability the harness lacks degrades to the stricter side, never to allow.
6. ENFORCEMENT TIERS shown honestly in `status`/docs: ENFORCED (live-probed hard block), DOCUMENTED (docs/source says it blocks, not live-probed), INSTRUCTED (rules/skills only, plus pre-commit/CI as the check). Today only Claude Code (live) and Pi (live) are probed; Codex/Gemini/Cursor/OpenCode are docs/source; Copilot, Qoder, Factory, Command Code, Augment, Windsurf, Kiro, Cline now document pre-tool hooks (docs-only) and move from INSTRUCTED to DOCUMENTED once an adapter + probe exists; Swival has no hook.
7. CONFORMANCE KIT (how new harnesses are added later): `agent-flow harness probe <name>` runs a canary event through that harness's wire format and reports tier; the whole fixture corpus is replayed through each adapter's wire format in CI; a new harness = adapter file + config writer + field map + capability row + probe + corpus pass. No core change.
8. TAMPER SURFACE is per harness and the guard must protect its own wiring for all of them (not only when `protected_paths` is set): `.claude/settings*.json`, `.codex/hooks.json` + `config.toml`, `.gemini/settings.json`, `.cursor/hooks.json`, `.opencode/**` + `opencode.json`, `.pi/**` + `~/.pi/agent/settings.json`, `.github/hooks/**`, the hook scripts, and `node_modules/@drix10/agent-flow`.
   Verified user-side/agent-side kill switches the launcher or docs must address: Claude `--settings '{"disableAllHooks":true}'` (live), mid-session settings rewrite under bypass (live); Pi `-ne`, `PI_CODING_AGENT_DIR`, settings.json rewrite applies next start (live), and a PROJECT-ONLY Pi guard is silently skipped in print/json/rpc and in child `pi` processes unless user-level or `-e` (live); OpenCode `OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_CONFIG_PROJECT_DISABLE`, `OPENCODE_CONFIG_CONTENT`, plugin hot-reload overwrite (live), plugin load failure is fail-open and silent (live); Codex `--dangerously-bypass-hook-trust`, `[features] hooks=false`, project hooks inert until hash-trusted and any edit invalidates trust (live); Gemini `/hooks disable-all`, `disabledHooks`; Cursor user-level hooks.
   Only managed/enterprise config is tamper-resistant: Claude managed settings (`allowManagedHooksOnly`), Codex `requirements.toml`, Gemini admin policy, Cursor enterprise `hooks.json`, OpenCode managed config, Factory/Augment. Docs say so plainly: a project guard is advisory against a determined user or agent; managed config is the enforced tier.
9. AUDIT is model-neutral but model-aware: log `harness`, `session_id`, `agent_id`/`agent_type` where present, and `model` where the harness gives it (Pi `ctx.model`, Codex `model`, Cursor `model`); Claude via transcript/SessionStart, Gemini and OpenCode give none, so `model:"unknown"`. Metrics are never keyed to a model.
10. MODEL-NEUTRAL TEST DESIGN: rules are validated on the fixture corpus (model-free). The adversarial run uses at least one cheap and one strong model per preset, but there is no frontier-model evidence yet (section 1a), so no "model-neutral" claim in docs beyond "enforcement is independent of the model".

## 3. Release plan

### Slice 0 (no release; do first)
1. Baseline: compute the historical LIVE-ONLY baseline now (exclude the 584 role-probe rows of Oct 1-12 and test/probe cwds); record as "before". Also run the whole fixture corpus on v1.2.7 as the before-number.
2. Fix eval records per section 1a (ledger 01a1ba9a, scorecard counts, delete the Nov 8 citation, retarget MAP-17, MAP-1/15 wording, f1c432dc row). Re-read raw 01a1af0d and f1c432dc before they carry weight.
3. Hygiene (human): rotate exposed keys unless already rotated; I can redact the two 01a1af30 knowledge files on request.
4. Fixtures, test-first: extend `tests/redteam/corpus.json` with `rule` (mandatory for block entries), `cwd`, `manifest`, `role`, optional stub `probe`; add ~60 sanitized entries covering H1-H8, the 01a1ba9a 7-step ladder
   (`git push origin main` block; retry chained with `cat .git/hooks/pre-push` block; positional hooksPath read allow; branch+PR allow; `git push origin --delete agent/launch-fixes` allow only under the scoped rule; agent `pi remove` block; post-removal direct push),
   01a1af30 key-names-only chained grep (expect BLOCK with the reason naming the `.env` segment and the re-issue form: a hook allows or blocks the whole call and cannot run the read-only parts), 6666fa97 explicit-URL force-push shape,
   110fe80e agent-run `git push origin main`, commit-message/heredoc hooksPath mentions, CRLF cases, 30k-file perf case (budget injected, never assert wall time). No machine paths, no token-bearing URLs.
   Pull raw via skl before use: 110fe80e standing push rule, 6666fa97 pushes (distillate-only today).
5. Gate semantics: any block->allow OR allow->block flip must be listed with the preset that permits it (the old gate caught only one direction).
6. Verification pass: DONE (section 7). Remaining items there marked OPEN are rechecked before the release that depends on them.

### Release A: "close holes, same policy" (suggest 1.2.8; call it 1.3.0 if you prefer minors for behaviour changes)
Order inside A (each step: failing fixture -> fix -> test -> CHANGELOG):
- A1 [H1,H3] decideGit consumes `lexShell` words, not stripQuoted text; any dynamic/glob/`~ ^ { } $ * ?` refspec = `explicit-refspec` block; normalise `\r\n` once in `commandText()`. Effort M.
- A2 [H2] Manifest loader: on parse error use the default-branch/HEAD committed manifest as floor, never `null` -> allow; `manifest-unreadable` keeps failing closed for protected actions. Effort S-M.
- A3 [H10, observability, additive only] One `lib/guardrun.ts` used by `cmdGuard` and the Pi handler: real `harness` (installed hooks get `--harness <h>`; old installs log `unknown`, never "claude"; update `canonicalOurs` regexes; OpenCode template + `.opencode` copy together),
  `source` (default `live`; `AGENT_FLOW_AUDIT_SOURCE` set by probes/dogfood; node:test context auto-tags `test`), repo-relative `cwd`, `override` list when an override env is set, audit of CLI guard errors; redact and cap `reason` and `target`
  (broaden redaction: `curl -u`, URL userinfo, `--password`, JWT, `glpat-`, `sk_live_`, AWS, `Authorization: Token`); never log command text for allows; add `variant` (`hooks-path`, `branch-delete`, `reset-hard`) and `by_variant` in `audit summary`
  (rules are NOT renamed; ~9 `no-verify` + 13 `force-push` test assertions and by_rule consumers keep working); make `audit.lock` and `.agent-flow/` tamper-proof; `audit verify` flags `unchained` lines. Update tests/audit.test.js:142. Effort M.
- A4 [H5] git config semantics on argv: no action flag -> one positional = read, two or more = write; action flags decide otherwise; `--show-*`, `--global`, `-z` are neutral modifiers; a dynamic word in a `git config` or `-c` segment = block;
  block `GIT_CONFIG_*` env forms, `--config-env`, alias writes, `.git/config` writes. Subtract data regions (`-m` values, echo data, heredoc bodies) reusing `pathWords`; keep the raw regex only as a fallback for unparseable git segments (limited to that segment).
  Net effect: closes H5 and fixes the live false block (positional read) plus the synthetic ones (`-m`, heredoc commit message, `git log --grep=`, `echo`). Effort S (hooksPath) .
- A5 [H7] Secret-read: operands that are dynamic or glob in recursive searches are treated as `.`; add `git grep --no-index`; walk budget = TIME only (injectable, like `walkLimit`), fail closed on time-out and immediately for `/`, `~` or an ancestor of the root;
  on exhaustion enumerate with `git ls-files -z -co --ignored --exclude-standard` filtered by `isEnvFile`. Do NOT honour `--exclude`/`-g` (diverging reimplementations; false allow = leak). Reroute text names forms that already pass: `git grep`, `rg <dir>`, `grep -r src/`.
  Exception that IS safe (V4, 01a1af0d #96-97): honour `grep --include=<glob>` only when every include glob (basename fnmatch, grep's exact semantics) cannot match ANY env filename the walk found; anything else stays a block.
  Also verified live: `rg -g '.env*' K` reads `.env` WITHOUT `--hidden` and the current guard allows it [REPLAY]; rg `-g '!.env'` also hid `sub/.env` but not `.env.local` (glob semantics are subtle), so `-g`/`--exclude` are never honoured.
  Rejected from draft v1: "honor exclusions" and "fail closed on the entry cap" (blocks every big-repo `grep -r .` with no env file; cold Windows disk non-determinism). Effort M.
- A5b Fetch rule (V4, 01a1af0d ~#1194): `git fetch <remote> <src>:refs/remotes/...` writes a remote-tracking ref only; allow destinations under `refs/remotes/`, keep blocking any other destination. Effort S.
- A6 [H6 partial, H8] GUARD_WIRING protection unconditional (not only when `protected_paths` is non-empty) and not liftable by any `AGENT_FLOW_ALLOW_*`; split ALLOW_PROTECTED into named per-rule overrides (old var stays as a logged, deprecated alias).
  Do not block `install`/`update` for role-less sessions (the bootstrap skill runs `install`). Effort S-M.
- A7 `status`: honest tiers per repo x harness: wired (file + target exists) / self-test (canary event through `agent-flow guard`; proves the CLI, not the harness) / fired (last `guard_block`/heartbeat per harness from A3) / "not detectable here" (user-level disable, untrusted-folder hooks, Pi package list, Codex bypass flags).
  hooksPath-elsewhere warning names hooksPath. Fix docs/HARNESS-MATRIX.md and SECURITY.md:42. Update tests/status.test.js:76-77. Effort M.
- A8 Docs: the push ban stops the push command, not the merge, until Release B; user's own terminal is unblockable; audit unauthenticated.
- A9 Adapter hardening (section 2b, verified): fail-closed wrapper in `guardrun` (catch -> explicit deny + exit 2, explicit hook timeout, absolute `${CLAUDE_PROJECT_DIR}` paths, `onFailure:"block"` where supported with a stated minimum version);
  tool-KIND normalisation incl. a `code-exec` class (OpenCode v2 `execute`, `subagent`) closing the verified gap; unconditional wiring-protection list for all harnesses (section 2b item 8);
  Pi: warn in `status`/`install` when the guard is project-scope only (silently skipped in print/json/rpc and child `pi`), recommend user scope or `-e`; Codex: `init`/`status` tell the user the hook is inert until hash-trusted and re-trust after any hook edit;
  OpenCode: startup self-check because a plugin load failure is fail-open and silent; capability table as data; `agent-flow harness probe <name>` skeleton. Effort M-L.
- A10 Deny-text rule for chains (V4): hooks deny a WHOLE chain, so the message names the offending segment and says to re-issue the remaining commands separately (01a1af0d #233: the user-ordered commit never ran). Effort S.
Release A gate: lint/test green on 3 OSes x node 20/22; fixture flips listed; free arena step (section 4); no policy change except holes closed.

### Release B: "user relief as presets" (1.3.0)
- B1 `strictness` presets (floored; read only from the default branch's committed copy, never HEAD/disk; missing or unknown = `standard`; relaxations honoured only from the default-branch copy; strictest-of disk/HEAD/default wins; existing installs unchanged on `update`).
  Key placement: a new root key like `guard_strictness`/`push_policy`, NOT under `policy` (its schema is `additionalProperties:false`); add to FLOORED_KEYS (manifest.ts:358); old versions ignore it and keep enforcing today's behaviour. Schema + docs. Effort M.
  Presets are data (rule -> block | ask | allow+log):
  | Rule | strict | standard (new-install default; = today + A fixes) | solo |
  |---|---|---|---|
  | push to default branch | block | block, deny names the PR path | allow + log (status warns if remote branch protection unverifiable) |
  | agent merge into default branch (`gh pr merge`, MCP) | block | block for non-orchestrator roles and role-less; reroute text | allow + log |
  | scoped branch delete (B3) | block | allow when probe passes | allow when probe passes |
  | `reset --hard` | block always | current behaviour, named variant logged | allow + log |
  | secret recursive search | block | block + reroute | block + reroute (never relaxed) |
  `ask` exists only where verified (Claude/Cursor via hook `ask` output, Pi via confirm); anywhere else or headless it degrades to the stricter side. No file- or env-based approval channel (agent-writable).
  Never relaxed (floor): force-push, ref-rewrite, `--no-verify`, hooksPath write, self-disable, tamper-proof, catastrophic-delete, guard-wiring, remote branch-protection/settings writes.
- B2 `remote-write` rule for every session (H4): default-branch writes through any channel: `gh pr merge` (incl. `--admin`, `--auto`), `gh api`/`curl` with non-GET to endpoints in the dangerous class (`.../merge`, `git/refs/heads/<default|release*>`, `contents/*` with default branch,
  `branches/*/protection`, repo default-branch/settings, release `--target <default>`, workflow dispatch, GraphQL merge/auto-merge); dynamic words inside a dangerous-class endpoint = block. Everything else (issue/PR comments, create-PR, reads) stays allowed.
  Rejected from R1: a blanket allow-list of forge calls (friction). Server-side branch protection remains the real boundary; docs say so. Effort M-L.
- B3 Scoped branch delete (the single most valuable false-block fix; ships with its own tests): allow only a single `:<name>` or `--delete <name>` refspec where: name matches `^agent/` and is not default or release-like; the remote is a configured remote name; the probe runs in the push's own directory (segments do not track `cd`);
  default branch comes from `ls-remote --symref`, never the disk manifest; remote sha from `ls-remote` (freshness), then `merge-base --is-ancestor` exits 0; branch tip differs from the default tip; probe timeout <= 3 s (Claude kills hooks at 60 s and then does NOT block); whole probe in try/catch returning the existing block;
  stays blocked when combined with `--force`, `-f`, `--mirror`, `--prune`, tags, non-`refs/heads`; empty probe output = not merged. Probe injected via `GuardInput.probe` (stub per corpus entry; one real bare-remote test). Squash merges (no ancestor): optional `gh pr list --head b --state merged`; deny text points at `agent-flow clean --yes`.
  `gh api -X DELETE .../refs/heads/<b>` stays blocked in B2 (reroute: `git push origin --delete agent/x`). Effort M, its own release candidate.
- B4 Self-disable + pause (answers 01a1ba9a #5409 "how do I stop this"): `self-disable` rule for every session: package removal (`pi remove`, `npm/pnpm/yarn uninstall`), delete/move/truncate of the package path or `node_modules`, `agent-flow uninstall`/`hook uninstall`,
  agent CLI launches with `--no-extensions`, `-ne`, `--settings`, `--bare`, `OPENCODE_DISABLE_*`/`OPENCODE_CONFIG_CONTENT`, `PI_CODING_AGENT_DIR`, `CLAUDE_CONFIG_DIR` (verified kill switches, section 2b item 8), `pi uninstall` (alias of `pi remove`), writes to host config under `~` (`~/.pi/agent/settings.json`, `~/.claude/settings.json`, `~/.agent-flow`); match on PARSED ARGV so `echo "run pi remove x" >> NOTES.md` is not a new false block.
  Not liftable by any AGENT_FLOW_ALLOW_*. Replace the removed answer with a human-run command: `agent-flow pause [--for 30m] [--rule X] [--reason "..."]` / `resume`, audited, expiring, shown by `status` as "PAUSED until", stored outside the repo; deny text says "ask the user to run `agent-flow pause`".
  Honest limits: a role-less shell write to the pause record is best-effort-blocked; the user's own terminal is unblockable and unloggable; a running session keeps its old guard until restart. Make the hook command exit 2 when its script is missing if the cross-platform shim is feasible (design first, S-M). Effort L.
- B5 Deny UX contract (all rules): each message has (1) rule and the offending segment (redacted), (2) why, (3) the exact allowed command, or "none: ask the user", (4) the human-run form for halt classes, plus "this is the guard, not a git hook; retrying will not change it".
  Classes: reroute = push, branch delete, secret-read; halt-and-hand = force-push, history rewrite, `--no-verify`, hooksPath write, guard disable, pause. Evidence: 01a1ba9a #5390-5412 (agent probed the guard as if it were a git hook), #5403/#5408 (delete text named no lawful path), 6666fa97 #4718-4720 (halt-and-hand worked in one turn).
  Optional: count identical retries and after two say "stop and ask". Effort S-M.
- B6 `agent-flow env-check [NAME...]`: prints set/missing/length only, never a value; the guard allows exactly that command. It is the compliant alternative named by secret-read denies (do NOT allow-list `node -e`). Effort S.
- B7 Kill switch: a `RELAX` table plus `AGENT_FLOW_GUARD_LEGACY=1` (human launch; logged) restoring pre-B behaviour. Rollback: `npm deprecate` + patch release; vendored runtimes change only on `update`, `npx @latest` users change immediately.
Release B gate: Release A gate + the adversarial arena run (section 4) per preset.

### Release C / later (designed, not committed)
- warn-on-paste, warn-only (never refuse to place): verified feasible on Claude (UserPromptSubmit, exit 0 + `systemMessage`; exit 2 echoes the prompt back, so never use it for secrets), Codex and Gemini (prompt hooks block or warn, live), Pi (`input` event; cannot tell paste from typing), Cursor (`beforeSubmitPrompt` can only block, not in CLI `-p`); reuse `findSecrets`; secret-WRITE content scan for Write/Edit (Oct 21 class), warn first, block after data.
- Baseline tier for role-less sessions (H9): decide what role-less sessions should get (agent-config, outside-repo) without breaking interactive use.
- Escalation telemetry on top of the `variant` names (a force-push attempt shortly after a push block), excluding a delete of a merged branch.
- Codex: detect untrusted hook / bypass flags in status; keep `codex exec` supported (MAP-8 is NOT out of scope).
- Trust-boundary marking only if roles parse subagent text. Cost caps: already on ROADMAP (per-issue `max_cost_usd` ships); Phase 5 adds nothing.

## 4. Release gates and metrics (replaces v1 section 5)
- Always: `npm run lint` + `npm test` (pretest builds), derived-copy dogfood green, 7 version slots + docs tags, CHANGELOG, flips listed both directions.
- Arena step 1 (free, mandatory): replay the full fixture list through `bin guard` against the arena's manifest and real `.env`, with a bare local origin. The arena (hypothesis-arena) vendors 1.2.6 and its tree is dirty: clone with `--no-hardlinks` and remove the remote, per the memory recipe.
- Arena step 2 (about $2-3): 3 live `run`s vs a 1.2.7 baseline recorded first. Pass = no `.env` read, no push to main, wiring unchanged, fewer false blocks. Three runs are not statistical and cover only the Claude path; Pi, Codex, Gemini, Cursor, OpenCode are untested by this gate. Say so in the release notes.
- Adversarial run (before Release B): two models (cheap and strong), N>=10 per preset, the 01a1ba9a task with a conflicting instruction. Measure compliant-path %, halt %, bypass %, calls to finish, identical retries, guard-probing.
- Metrics (replace blocks/day, which improves when users uninstall): fixture-corpus false-block and false-allow rates per rule; counts of uninstall/pause/override lines and guard-on coverage in local audits; override rate; calls to complete the compliant path.
  `source` is spoofable (launcher env): treat `source=test` in a live-looking cwd as a flag, not an exclusion.
- Test budget: about 60 more corpus entries and about 30 more node tests; docs to touch: SECURITY, FAILURE_MODES, brief.ts, ADOPTION, HARNESS-MATRIX, CHANGELOG, README dogfood stats.

## 5. Disposition of every critique finding
| Finding | Disposition |
|---|---|
| R1-S1 quoted refspec bypass | ACCEPTED, A1 (replayed) |
| R1-S2 / R2-03 remote-write doors | ACCEPTED as B2, scoped to dangerous endpoints (blanket allow-list REJECTED: friction) |
| R1-S3 / R3-02 manifest forgery | ACCEPTED, A2 + B1 floor (replayed through the real hook) |
| R1-S4 / R2-04 / R3-04 merged-delete holes | ACCEPTED, B3 redesigned; moved out of slice 1 |
| R1-S5 self-disable gaps | ACCEPTED, A6 + B4 |
| R1-S6 / R3-07 secret-read | ACCEPTED: no exclusion honoring, time-only budget, git ls-files fallback |
| R1-S7 hooksPath semantics | ACCEPTED, A4 (git read/write rule on argv) |
| R1-S8 / R3-03 `approve` | ACCEPTED: `ask` only where verified, else stricter; no file/env approval |
| R1-S9 audit redaction/tamper | ACCEPTED, A3 |
| R1-S10 ALLOW_PROTECTED too broad | ACCEPTED, A6 |
| R1-S11 role-less baseline, secret-write | DEFERRED to Release C (designed) |
| R2-01 "how do I stop this" removed not replaced | ACCEPTED, B4 pause/resume |
| R2-02 slice order | PARTLY: holes first (A), then presets (B). Presets put the push relief in B, not slice 2-last |
| R2-05 / R2-09 strictness presets, overfitting | ACCEPTED, B1 |
| R2-06 env-check | ACCEPTED, B6 |
| R2-07 harm classes with no item | warn-on-paste and secret-write scan to C; `reset --hard` becomes a preset row; secrets-public-for-a-year -> status check is C |
| R2-08 / R3-10 metrics and arena gate | ACCEPTED, section 4 |
| R2-11 scope calls | cost caps = ROADMAP (no Phase 5 work); standing grants = pause (B4) |
| R2-12 contradictions | ACCEPTED, section 1a |
| R2-13 deny UX | ACCEPTED, B5 |
| R3-01 argv parsing loses true positives | ACCEPTED: subtractive design, raw regex kept as fallback; CRLF normalisation |
| R3-05 / R3-06 additive audit fields and variants | ACCEPTED, A3 |
| R3-08 status tiers | ACCEPTED, A7 |
| R3-09 semver | A as 1.2.8 (or 1.3.0), B as 1.3.0 |
| R3-12 kill switch, rollback, upgrade story | ACCEPTED, B7; old hook commands keep working, new fields appear after `update` |
| Item 19 (env gates) | already true by construction (inline env does not reach the hook); the real hole is Claude's settings `env` block, closed by unconditional GUARD_WIRING (A6) |
| MAP-21, MAP-22 | unchanged: no change / OUT |

## 6. Needs you (decisions)
1. Rotate the exposed keys unless already rotated (human only). I can redact the two 01a1af30 knowledge files now.
2. Self-merge under the default `standard` preset: block `gh pr merge`/MCP merge for non-orchestrator roles and role-less sessions (my recommendation: yes, the ban is theater otherwise; interactive owners choose `solo`, or `ask` where supported)?
3. Is "an agent may not remove its own guard" acceptable, now paired with a human-run `agent-flow pause`?
4. Default preset for NEW installs = `standard` (today's behaviour plus the A fixes), existing installs unchanged on `update`. OK?
5. Under `solo`, if remote branch protection cannot be verified (non-admin token), honor `allow` with a loud `status` warning (my recommendation), or stay `forbid`?
6. Release A as 1.2.8 (precedent) or 1.3.0?
7. Start with Slice 0 now (baseline, record corrections, fixtures) and then Release A, or review first?

## 7. Verification results (this pass)
| Item | Result | How |
|---|---|---|
| Claude exit codes | exit 2 blocks; exit 0/1, crash, missing script, 127, timeout all fail OPEN; JSON `permissionDecision:"deny"` on exit 0 blocks; `ask` is denied headless; hooks still fire under `--dangerously-skip-permissions`; fire for Write/Read/Edit/Glob/Agent/Bash and inside subagents | LIVE (Claude 2.1.287, 13 calls) |
| Claude `onFailure:"block"` | documented (2.1.295+) but NOT enforced on 2.1.287 | LIVE |
| Claude tamper | `--settings '{"disableAllHooks":true}'` bypasses hooks; mid-session settings rewrite works under bypass; `FOO=1 cmd` does NOT reach the hook (so env-gate item 19 holds); local `env` overrides project `env` | LIVE |
| Claude UserPromptSubmit | sees full prompt, fires in `-p`, exit 0 + `systemMessage` warns without blocking, exit 2 blocks and echoes the prompt | LIVE |
| Claude stdin | `session_id, transcript_path, cwd, prompt_id, permission_mode, tool_name, tool_input, tool_use_id` (+ `agent_id`, `agent_type` in subagents); no model field | LIVE |
| Codex | exit 2 on the PROMPT hook did not block (JSON `decision:"block"` did); timeout/exit 1/crash fail open; project hooks inert until hash-trusted; `--dangerously-bypass-hook-trust` / `hooks=false` turn off; has `model` in stdin; PreToolUse exit 2 NOT tested | LIVE (prompt hook) + DOCS; tool-call hook docs-only (usage limit) |
| Gemini | JSON deny parsed on any exit code; bare exit 2 with no output does NOT block; exit 2/3 with stderr text blocks; missing script/crash/timeout fail open; project hooks ran with no trust prompt; no model field | LIVE (prompt hook) + SOURCE; tool-call hook docs/source-only (API down) |
| Cursor | exit 2 denies, other codes fail open unless `failClosed:true`; stdin has UTF-8 BOM on Windows; `ask` not enforced on `preToolUse`; project hooks need a trusted workspace; hooks never run on Windows with Git Bash in process ancestry (known bug) | DOCS/forum only |
| Pi | `tool_call` fires for write/edit/read/bash/grep/ls, handler throw = blocked; extensions load in print/json/rpc; project-scope guard silently skipped in headless and child `pi` (user-scope or `-e` loads); `pi uninstall` = alias of `pi remove`; `-ne`, `PI_CODING_AGENT_DIR`; settings.json edit applies next start; `ctx.model` and session id available; `input` event for paste warning | LIVE (stub models, 0 real calls) |
| OpenCode v2 | blocks by throwing in `execute.before`; fires for write/edit/read/shell/glob/grep/subagent/execute; tool name is `shell` (guard already handles it); `execute` Code Mode and `subagent` NOT covered by the guard [REPLAY]; plugin load failure fail-open and silent; env/flag bypasses and hot-reload overwrite work; `ask` auto-approved under `--auto` | LIVE (stub models) + REPLAY |
| Other harnesses | Copilot, Cline, Windsurf, Kiro, Qoder, Factory, Command Code, Augment now document pre-tool hooks; Swival none | DOCS only (small-model summaries; treat as leads) |
| `NODE_TEST_CONTEXT` | `child-v8` under `node --test` on Node 20.19.5, 22.18.0, 24.21.0; undefined under plain `node` | LIVE |
| rg `-g` | `-g '.env*'` includes `.env` without `--hidden` (guard allows it); `-g '!.env'` excludes `.env` and `sub/.env` not `.env.local` | LIVE + REPLAY |
| git | positional `git config core.hooksPath` read = rc 1 when unset; `--show-scope key value` WRITES; `git push origin :heads/main` deletes remote `main` on a plain remote (only server-side protection stops it); a branch at main's tip is "merged" (`is-ancestor` true) | LIVE (git 2.51) |
| gh | `gh pr list --state merged --json headRefName,mergedAt` works (squash merges detectable); `gh api repos/o/r/branches/main --jq .protected` works without admin; this repo's own `main` is unprotected, no rulesets | LIVE read-only |
| Raw sessions | see section 1a (V4) | RAW |
OPEN (recheck before the release that needs them): live PreToolUse/BeforeTool on Codex/Gemini/Cursor; Codex PreToolUse exit 2 and missing script; Gemini `--yolo` + hooks and headless `ask`; Claude interactive `ask`, MultiEdit/NotebookEdit/WebFetch/MCP live, `--bare`;
Pi MCP calls live and interactive `/reload`; OpenCode MCP/`execute` inner calls and managed policy; GitHub default-branch deletion refusal; walk timing on macOS/Linux/cold disk; Windsurf/Kiro/Cline/Copilot exit contracts; whether the 01a1ba9a branch was squash-merged; Cursor-on-Windows-Git-Bash hook bug.
