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
    description: "Create an isolated git worktree for an issue. Returns the worktree path and branch.",
    parameters: {
      type: "object",
      properties: {
        issue: { type: "number", description: "Issue number" },
        baseBranch: { type: "string", description: "Branch to base from", default: "main" },
      },
      required: ["issue"],
    },
    handler: async ({ issue, baseBranch = "main" }: { issue: number; baseBranch?: string }) => {
      const branch = `agent/issue-${issue}`;
      const worktreePath = join(".worktrees", `issue-${issue}`);

      if (existsSync(worktreePath)) {
        return { error: "worktree_exists", path: worktreePath };
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
        issue,
        createdAt: new Date(),
      };

      worktrees.set(branch, info);

      return {
        path: worktreePath,
        branch,
        issue,
        message: `Worktree created at ${worktreePath} on branch ${branch}`,
      };
    },
  });

  pi.registerTool({
    name: "worktree_remove",
    description: "Remove a worktree after PR is opened. Cleans up the branch.",
    parameters: {
      type: "object",
      properties: {
        issue: { type: "number", description: "Issue number" },
      },
      required: ["issue"],
    },
    handler: async ({ issue }: { issue: number }) => {
      const worktreePath = join(".worktrees", `issue-${issue}`);
      const branch = `agent/issue-${issue}`;

      if (!existsSync(worktreePath)) {
        return { error: "worktree_not_found", path: worktreePath };
      }

      try {
        execSync(`git worktree remove ${worktreePath} --force`, { stdio: "pipe" });
        execSync(`git branch -d ${branch}`, { stdio: "pipe" });
      } catch (error: any) {
        throw new Error(`Failed to remove worktree: ${error.message}`);
      }

      worktrees.delete(branch);

      return { removed: worktreePath, branch, issue };
    },
  });

  pi.registerTool({
    name: "worktree_list",
    description: "List all active worktrees.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      return { worktrees: Array.from(worktrees.values()) };
    },
  });
}
