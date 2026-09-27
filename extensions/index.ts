import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import bootstrap from "./bootstrap.js";
import classify from "./classify.js";
import crossHarness from "./cross-harness.js";
import guard from "./guard.js";
import riskAuditor from "./risk-auditor.js";
import staleDetector from "./stale-detector.js";
import stateMachine from "./state-machine.js";
import worktree from "./worktree.js";

/**
 * Single entry point. package.json `pi.extensions` names this compiled file
 * explicitly, so Pi loads exactly what `npm test` verified (Pi resolves a bare
 * directory to its index.ts and transpiles it at load time).
 */
export default function (pi: ExtensionAPI) {
  guard(pi);
  bootstrap(pi);
  worktree(pi);
  stateMachine(pi);
  staleDetector(pi);
  riskAuditor(pi);
  classify(pi);
  crossHarness(pi);
}
