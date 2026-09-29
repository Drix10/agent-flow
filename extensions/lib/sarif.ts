/**
 * SARIF 2.1.0 output, so findings show up as GitHub code-scanning annotations (or in any SARIF viewer) instead of
 * only in a job log. Locations are file + optional line; nothing here carries a secret value.
 */

export interface SarifFinding {
  ruleId: string;
  level: "error" | "warning" | "note";
  message: string;
  path?: string;
  line?: number;
}

export interface SarifRule {
  id: string;
  description: string;
}

export function toSarif(version: string, rules: SarifRule[], findings: SarifFinding[]): object {
  const used = new Set(findings.map((f) => f.ruleId));
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "agent-flow",
            version,
            informationUri: "https://github.com/Drix10/agent-flow",
            rules: rules.filter((r) => used.has(r.id)).map((r) => ({ id: r.id, shortDescription: { text: r.description } })),
          },
        },
        results: findings.map((f) => ({
          ruleId: f.ruleId,
          level: f.level,
          message: { text: f.message },
          ...(f.path
            ? { locations: [{ physicalLocation: { artifactLocation: { uri: f.path.replace(/\\/g, "/") }, ...(f.line && f.line > 0 ? { region: { startLine: f.line } } : {}) } }] }
            : {}),
        })),
      },
    ],
  };
}

export const DOCTOR_RULES: SarifRule[] = [
  { id: "agent-flow/missing-context-file", description: "A context file listed in the manifest does not exist." },
  { id: "agent-flow/broken-reference", description: "A context file references a path that does not exist." },
  { id: "agent-flow/stale-context", description: "A context file has not been verified within its staleness threshold." },
  { id: "agent-flow/invalid-timestamp", description: "A manifest timestamp is not a valid ISO date." },
  { id: "agent-flow/unfilled-placeholder", description: "A context file still contains a template placeholder." },
  { id: "agent-flow/manifest-schema", description: "The manifest does not match its schema." },
  { id: "agent-flow/dead-command", description: "A command in a context file no longer exists." },
];

export const RISK_RULES: SarifRule[] = [
  { id: "agent-flow/new-risk-surface", description: "A risk surface (secret, dependency, network, permission…) not accepted in .risk-baseline.json." },
  { id: "agent-flow/risk-surface", description: "A risk surface found in a repo with no baseline yet." },
];
