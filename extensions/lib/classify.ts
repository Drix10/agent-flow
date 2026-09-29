/**
 * Mechanical risk classification of a change set.
 *
 * v1.0.2 described this as JavaScript inside a SKILL.md — i.e. the model was
 * asked to "run" it in its head — and the snippet itself had two bugs:
 * `protectedPaths.includes(f)` only matched exact file paths (a protected
 * directory never matched), and `f.includes("auth")` flagged `author.ts`.
 * It also ran BEFORE implementation, when there are no changed files yet.
 *
 * This runs on the real diff, matches directory prefixes and globs from the
 * manifest, and uses path-SEGMENT heuristics only when no boundaries exist.
 */

import { addedLines, changedFiles, defaultBase, diffStats, git, recordedBase } from "./git.js";
import { PolicyViolation, evaluatePolicy, policyOf } from "./policy.js";
import { ContextManifest, RiskLevel, contextFilePaths, matchAny, matchesPattern } from "./manifest.js";
import { isDependencyManifest } from "./risk.js";

export interface Classification {
  risk_level: RiskLevel;
  reviewer_tier: "high-reasoning" | "fast";
  human_approval_required: boolean;
  protected_violations: string[];
  context_files_touched: string[];
  dependency_manifests_touched: string[];
  reasons: string[];
  files: string[];
  used_heuristics: boolean;
}

const ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, critical: 2 };
const HEURISTIC_CRITICAL = /(^|\/)(auth|authn|authz|login|oauth|payments?|billing|checkout|security|crypto|secrets?|credentials?|migrations?)(\/|[._-]|$)/i;
const HEURISTIC_MEDIUM = /(^|\/)(core|kernel|infra|deploy|\.github\/workflows|docker|terraform|k8s|helm)(\/|[._-]|$)/i;

/** agent-flow's own bookkeeping — never part of "the change". */
const OWN_FILES = /^(\.agent-flow\/|\.worktrees\/|\.agent-state\.json$|AGENT_STATE\.md$)/;

export function classifyFiles(allFiles: string[], manifest: ContextManifest | null): Classification {
  const files = allFiles.filter((f) => !OWN_FILES.test(f));
  let level: RiskLevel = "low";
  const reasons: string[] = [];
  const bump = (to: RiskLevel, why: string) => {
    if (ORDER[to] > ORDER[level]) level = to;
    reasons.push(`${to}: ${why}`);
  };

  const protectedViolations: string[] = [];
  for (const f of files) {
    const hit = matchAny(manifest?.protected_paths, f);
    if (hit) {
      protectedViolations.push(f);
      bump("critical", `${f} is under protected path ${hit}`);
    }
  }

  const boundaries = (manifest?.risk_boundaries ?? []).filter((b) => b && typeof b.path === "string");
  for (const f of files) {
    for (const b of boundaries) {
      if (matchesPattern(b.path, f) && ["low", "medium", "critical"].includes(b.risk_level)) {
        bump(b.risk_level, `${f} matches risk boundary ${b.path}`);
      }
    }
  }

  const usedHeuristics = boundaries.length === 0;
  if (usedHeuristics) {
    for (const f of files) {
      if (HEURISTIC_CRITICAL.test(f)) bump("critical", `${f} looks security/money-sensitive (heuristic — set risk_boundaries in the manifest)`);
      else if (HEURISTIC_MEDIUM.test(f)) bump("medium", `${f} looks like core/infra (heuristic)`);
    }
  }

  const depFiles = files.filter(isDependencyManifest);
  if (depFiles.length) bump("medium", `dependency manifest changed (${depFiles.join(", ")}) — risk review required`);

  const ctx = contextFilePaths(manifest);
  const ctxTouched = files.filter((f) => ctx.includes(f));
  if (ctxTouched.length) reasons.push(`note: context files changed (${ctxTouched.join(", ")}) — Gardener territory`);

  if (files.length === 0) reasons.push("note: no changed files — nothing to review");
  const final = level as RiskLevel; // mutated inside bump(); TS cannot see that

  return {
    risk_level: final,
    reviewer_tier: final === "low" ? "fast" : "high-reasoning",
    human_approval_required: final === "critical",
    protected_violations: protectedViolations,
    context_files_touched: ctxTouched,
    dependency_manifests_touched: depFiles,
    reasons,
    files,
    used_heuristics: usedHeuristics,
  };
}

export function classifyDiff(cwd: string, root: string, manifest: ContextManifest | null, base?: string, head?: string): Classification & { policy_violations: PolicyViolation[]; base: string; head: string } {
  const manifestBase = typeof manifest?.default_branch === "string" && manifest.default_branch.trim() ? manifest.default_branch : null;
  const wanted = base ?? recordedBase(cwd) ?? manifestBase ?? defaultBase(root);
  // A CI checkout often has `origin/main` but no local `main`.
  const known = (rev: string) => git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], cwd).ok;
  const b = known(wanted) || base !== undefined || !known(`origin/${wanted}`) ? wanted : `origin/${wanted}`;
  const files = changedFiles(cwd, b, head);
  const c = classifyFiles(files, manifest);
  const policy = policyOf(manifest);
  const violations = policy
    ? evaluatePolicy(policy, c.files, policy.max_diff_lines ? diffStats(cwd, b, head) : null, (f) => addedLines(cwd, f, b, head))
    : [];
  return { ...c, policy_violations: violations, base: b, head: head ?? "(working tree)" };
}
