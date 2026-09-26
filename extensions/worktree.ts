/**
 * Worktree Extension
 *
 * Manages git worktrees for parallel agent execution.
 *
 * SECURITY: This extension creates isolated worktrees. Each worktree
 * has write access only to its own branch. Protected paths are
 * read-only in the Implementer's sandbox.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { text } from "./result.js";

interface WorktreeInfo {
  path: string;
  branch: string;
  issue: number;
  createdAt: Date;
}

export default function (pi: ExtensionAPI) {
  const worktrees: Map<string, WorktreeInfo> = new Map();

  pi.registerTool({
    name: "worktree_create",
    label: "Worktree create",
    description: "Create an isolated git worktree for an issue. Returns the worktree path and branch.",
    parameters: Type.Object({
      issue: Type.Number({ description: "Issue number" }),
      baseBranch: Type.Optional(Type.String({ description: "Branch to base from", default: "main" })),
    }),
    execute: async (_toolCallId, params) => {
      const baseBranch = params.baseBranch ?? "main";
      const branch = `agent/issue-${params.issue}`;
      const worktreePath = join(".worktrees", `issue-${params.issue}`);

      if (existsSync(worktreePath)) {
        return text({ error: "worktree_exists", path: worktreePath });
      }

      try {
        execSync(`git worktree add ${worktreePath} -b ${branch} ${baseBranch}`, {
          stdio: "pipe",
        });
      } catch (error: any) {
        throw new Error(`Failed to create worktree: ${error.message}`);
      }

      const info: WorktreeInfo = {
        path: worktreePath,
        branch,
        issue: params.issue,
        createdAt: new Date(),
      };

      worktrees.set(branch, info);

      return text({
        path: worktreePath,
        branch,
        issue: params.issue,
        message: `Worktree created at ${worktreePath} on branch ${branch}`,
      });
    },
  });

  pi.registerTool({
    name: "worktree_remove",
    label: "Worktree remove",
    description: "Remove a worktree after PR is opened. Cleans up the branch.",
    parameters: Type.Object({
      issue: Type.Number({ description: "Issue number" }),
    }),
    execute: async (_toolCallId, params) => {
      const worktreePath = join(".worktrees", `issue-${params.issue}`);
      const branch = `agent/issue-${params.issue}`;

      if (!existsSync(worktreePath)) {
        return text({ error: "worktree_not_found", path: worktreePath });
      }

      try {
        execSync(`git worktree remove ${worktreePath} --force`, { stdio: "pipe" });
        execSync(`git branch -d ${branch}`, { stdio: "pipe" });
      } catch (error: any) {
        throw new Error(`Failed to remove worktree: ${error.message}`);
      }

      worktrees.delete(branch);

      return text({ removed: worktreePath, branch, issue: params.issue });
    },
  });

  pi.registerTool({
    name: "worktree_list",
    label: "Worktree list",
    description: "List all active worktrees.",
    parameters: Type.Object({}),
    execute: async () => {
      return text({ worktrees: Array.from(worktrees.values()) });
    },
  });
}
