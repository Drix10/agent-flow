import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import bootstrap from "./bootstrap.js";
import worktree from "./worktree.js";
import stateMachine from "./state-machine.js";
import staleDetector from "./stale-detector.js";
import riskAuditor from "./risk-auditor.js";

export default function (pi: ExtensionAPI) {
  bootstrap(pi);
  worktree(pi);
  stateMachine(pi);
  staleDetector(pi);
  riskAuditor(pi);
}
