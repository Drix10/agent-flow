# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `extensions/risk-auditor.ts` — scans for new dependencies, auth code, and data mutation paths
- `TRUST_LOOP.md` — detailed explanation of the self-healing architecture

## [1.0.0] - 2026-09-26

### Added
- Initial release
- `extensions/bootstrap.ts` — repo scanning, context generation
- `extensions/worktree.ts` — git worktree management
- `extensions/state-machine.ts` — Needs Me / Working / Completed
- `extensions/stale-detector.ts` — CI integration, staleness flags
- `skills/bootstrap/` — interactive setup with confidence markers
- `skills/implementer/` — fast model, worktree sandbox
- `skills/reviewer/` — high-reasoning model, read-only
- `skills/qa/` — verbatim failures, no code modifications
- `skills/gardener/` — doc sync, risk audit, context repair
- `skills/invoking-agents/` — orchestration, ≤2 rounds, escalation
- `templates/` — Root_AGENT, Per-app_AGENT, DOCS_INDEX, CONTEXT_MANIFEST
- `FAILURE_MODES.md` — 12 failure modes documented
