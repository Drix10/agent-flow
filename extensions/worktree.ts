/**
 * Worktree Extension — one isolated git worktree per issue.
 *
 * Isolation here means "separate checkout + branch", not a sandbox. File-level
 * confinement comes from the guard (AGENT_FLOW_ROLE=implementer +
 * AGENT_FLOW_WORKTREE), which blocks write/edit outside the worktree.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendAudit } from "./lib/state.js";
import { createWorktree, listWorktrees, removeWorktree } from "./lib/worktree.js";
import { repoRoot, text } from "./result.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "worktree_create",
    label: "Worktree create",
    description:
      "Create .worktrees/issue-N on branch agent/issue-N from the base branch (default: the repo's default branch, auto-detected). " +
      "Reuses the branch if a previous run left it behind.",
    parameters: Type.Object({
      issue: Type.Integer({ minimum: 1, description: "Issue number" }),
      baseBranch: Type.Optional(Type.String({ maxLength: 200, description: "Base branch (validated with git check-ref-format)" })),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const root = repoRoot(ctx);
      const r = createWorktree(root, params.issue, params.baseBranch);
      appendAudit(root, { event: "worktree_create", issue: params.issue, ...("error" in r ? { error: r.error } : { base: r.base }) });
      return text(r);
    },
  });

  pi.registerTool({
    name: "worktree_remove",
    label: "Worktree remove",
    description:
      "Remove .worktrees/issue-N. Refuses if it has uncommitted changes unless force=true. Keeps the branch (a PR is open on it) " +
      "unless deleteBranch=true, which uses the safe `git branch -d`.",
    parameters: Type.Object({
      issue: Type.Integer({ minimum: 1 }),
      force: Type.Optional(Type.Boolean()),
      deleteBranch: Type.Optional(Type.Boolean()),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const root = repoRoot(ctx);
      const r = removeWorktree(root, params.issue, { force: params.force, deleteBranch: params.deleteBranch });
      appendAudit(root, { event: "worktree_remove", issue: params.issue, ...("error" in r ? { error: r.error } : {}) });
      return text(r);
    },
  });

  pi.registerTool({
    name: "worktree_list",
    label: "Worktree list",
    description: "List agent worktrees (agent/issue-N) as git reports them.",
    parameters: Type.Object({}),
    execute: async (_id, _params, _signal, _onUpdate, ctx) => text({ worktrees: listWorktrees(repoRoot(ctx)) }),
  });
}
