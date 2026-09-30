// agent-flow guard for OpenCode. Installed by `agent-flow install --harness opencode`.
// Runs the same guard as Claude Code's PreToolUse hook before every tool call; a block throws, which denies the call.
import { spawnSync } from "node:child_process";

const BIN = "__AGENT_FLOW_BIN__";

export const AgentFlowGuard = async (ctx = {}) => ({
  "tool.execute.before": async (input, output) => {
    const args = output?.args && typeof output.args === "object" ? { ...output.args } : {};
    if (typeof args.filePath === "string" && args.file_path === undefined) args.file_path = args.filePath;
    const event = { tool_name: String(input?.tool ?? ""), tool_input: args, cwd: ctx.directory ?? process.cwd() };
    const r = spawnSync(process.execPath, [BIN, "guard"], { input: JSON.stringify(event), encoding: "utf-8", cwd: event.cwd, timeout: 30000 });
    if (r.status === 0) return;
    // Fail closed: a guard that could not run is not a pass.
    throw new Error((r.stderr || "").trim() || `agent-flow guard did not run (${r.error?.message ?? `exit ${r.status}`}); call blocked`);
  },
});
