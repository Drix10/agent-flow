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
import { ContextManifest, RiskLevel, contextFilePaths, matchAny, matchesPattern, reviewPathsOf } from "./manifest.js";
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
  /** Changed files under the manifest's review_paths: a person reviews the pull request, and it is never auto-merged. */
  review_required: string[];
  /** Of those, the ones changed by more than harmless added lines (an edited or deleted line, a binary file, a CI line that reaches secrets): the Implementer is sent back. */
  review_violations: { file: string; why: string }[];
}

const ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, critical: 2 };
const HEURISTIC_CRITICAL = /(^|\/)(auth|authn|authz|login|oauth|payments?|billing|checkout|security|crypto|secrets?|credentials?|migrations?)(\/|[._-]|$)/i;
const HEURISTIC_MEDIUM = /(^|\/)(core|kernel|infra|deploy|\.github\/workflows|docker|terraform|k8s|helm)(\/|[._-]|$)/i;

const GOVERNANCE_FILES = new Set(["context_manifest.json", ".risk-baseline.json"]);

/** agent-flow's own bookkeeping — never part of "the change". */
const OWN_FILES = /^(\.agent-flow\/|\.worktrees\/|\.agent-state\.json$|AGENT_STATE\.md$)/;

/** Lines added and removed per file, as git reports them (null: binary). */
export type FileStats = Map<string, { added: number; removed: number } | null>;

/** CI definitions: code in them runs on the host as soon as a pull request opens, before anyone has read it. */
const CI_FILE = /^(\.github\/workflows\/|\.circleci\/|\.gitlab-ci\.yml$|azure-pipelines\.ya?ml$)/i;
/**
 * What an added CI line must not do. Each is a way for a line that looks like "run one more test" to reach something
 * a test doesn't need: a secret, a wider token, other people's code with secrets, a runner of yours, a download piped
 * into a shell, a third-party action, text from the event dropped into a script. A pattern list, not a sandbox.
 */
const RISKY_CI: [RegExp, string][] = [
  [/\bsecrets\s*[.[:]|\btoJSON\(\s*secrets\b/i, "reaches repository secrets"],
  [/\bGITHUB_TOKEN\b|\bgithub\.token\b/i, "uses the job's token"],
  [/\bpull_request_target\b|\bworkflow_run\b/i, "runs on a trigger that carries secrets for other people's code"],
  [/\b[a-z][a-z-]*\s*:\s*write(-all)?\b|\bwrite-all\b/i, "widens the token's permissions"],
  [/\bself-hosted\b/i, "runs on a self-hosted runner (your own machine or network)"],
  [/\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n]*\|\s*(ba|z)?sh\b|\biex\b/i, "pipes a download into a shell"],
  [/^\s*-?\s*uses\s*:\s*(?!actions\/|\.\/|docker:\/\/)\S/i, "pulls in a third-party action"],
  [/\$\{\{\s*github\.(event|head_ref)\b/i, "puts text from the event (a title, a branch name) into the job, which is how scripts get injected"],
];

/** Why an added CI line is not a plain "one more check", or null. */
export function riskyCiLine(line: string): string | null {
  for (const [re, why] of RISKY_CI) if (re.test(line)) return why;
  return null;
}

/**
 * `stats` and `added` are optional: without a diff, the shape of a change to review-only paths isn't judged.
 * `added(file)` returns the lines the change adds to it.
 */
export function classifyFiles(allFiles: string[], manifest: ContextManifest | null, stats?: FileStats, added?: (file: string) => string[] | null): Classification {
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

  // The files that hold the rules themselves: protected paths, gates and auto-merge policy, and the accepted risks.
  // A change to them is a change to what every later review is checked against, so a person approves it, never auto-merge.
  for (const f of files) {
    if (GOVERNANCE_FILES.has(f.toLowerCase())) bump("critical", `${f} holds agent-flow's own rules (protected paths, gates, accepted risks); a person approves changes to it`);
  }

  // Review-only paths (CI workflows, test lists): agents may add to them, a person reads the result. Anything that edits or
  // removes a line goes back to the Implementer, because that is how a check that judges the agent gets weakened.
  const reviewRequired: string[] = [];
  const reviewViolations: { file: string; why: string }[] = [];
  const reviewPaths = reviewPathsOf(manifest);
  for (const f of files) {
    const hit = matchAny(reviewPaths, f);
    if (!hit || protectedViolations.includes(f)) continue;
    reviewRequired.push(f);
    bump("medium", `${f} is a review-only path (${hit}): agents may add lines, a person reviews the change`);
    const s = stats?.get(f);
    if (stats && (s === null || s === undefined)) reviewViolations.push({ file: f, why: "binary or unreadable change; review-only paths take added text lines only" });
    else if (stats && s && s.removed > 0) reviewViolations.push({ file: f, why: `${s.removed} existing line(s) edited or removed; review-only paths take added lines only. Add a new line instead of changing one (a file that doesn't end in a newline counts its last line as edited, and a CRLF file edited with LF endings counts every line: keep the file's line endings and insert the new line above the last one)` });
    else if (added && CI_FILE.test(f)) {
      const lines = added(f);
      // Lines that couldn't be read are not lines that weren't added: nothing may pass unchecked.
      if (lines === null) reviewViolations.push({ file: f, why: "binary or unreadable change; review-only paths take added text lines only" });
      else {
        for (const l of lines) {
          const why = riskyCiLine(l);
          if (why) {
            reviewViolations.push({ file: f, why: `an added CI line ${why} (\`${l.trim().slice(0, 80)}\`); a person adds that` });
            break;
          }
        }
      }
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

  const depFiles = files.filter((f) => isDependencyManifest(f) && !f.startsWith(".agent-flow-runtime/"));
  if (depFiles.length) bump("medium", `dependency manifest changed (${depFiles.join(", ")}) — risk review required`);

  const ctx = contextFilePaths(manifest);
  const ctxTouched = files.filter((f) => ctx.includes(f));
  if (ctxTouched.length) reasons.push(`note: context files changed (${ctxTouched.join(", ")}) — Gardener territory`);

  if (files.length === 0) reasons.push("note: no changed files — nothing to review");
  const final = level as RiskLevel; // mutated inside bump(); TS cannot see that

  return {
    risk_level: final,
    reviewer_tier: final === "low" ? "fast" : "high-reasoning",
    human_approval_required: final === "critical" || reviewRequired.length > 0,
    protected_violations: protectedViolations,
    context_files_touched: ctxTouched,
    dependency_manifests_touched: depFiles,
    reasons,
    files,
    used_heuristics: usedHeuristics,
    review_required: reviewRequired,
    review_violations: reviewViolations,
  };
}

export function classifyDiff(cwd: string, root: string, manifest: ContextManifest | null, base?: string, head?: string): Classification & { policy_violations: PolicyViolation[]; base: string; head: string } {
  const manifestBase = typeof manifest?.default_branch === "string" && manifest.default_branch.trim() ? manifest.default_branch : null;
  const wanted = base ?? recordedBase(cwd) ?? manifestBase ?? defaultBase(root);
  // A CI checkout often has `origin/main` but no local `main`.
  const known = (rev: string) => git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], cwd).ok;
  const b = known(wanted) || base !== undefined || !known(`origin/${wanted}`) ? wanted : `origin/${wanted}`;
  const files = changedFiles(cwd, b, head);
  // The diff is read only when a review-only path changed: nothing else needs it here.
  const reviewTouched = files.some((f) => matchAny(reviewPathsOf(manifest), f));
  const c = classifyFiles(files, manifest, reviewTouched ? diffStats(cwd, b, head) : undefined, (f) => addedLines(cwd, f, b, head));
  const policy = policyOf(manifest);
  const violations = policy
    ? evaluatePolicy(policy, c.files, policy.max_diff_lines ? diffStats(cwd, b, head) : null, (f) => addedLines(cwd, f, b, head) ?? [])
    : [];
  return { ...c, policy_violations: violations, base: b, head: head ?? "(working tree)" };
}
