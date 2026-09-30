// agent-flow guard for OpenCode. Installed by `agent-flow install --harness opencode`.
// Runs the same guard as Claude Code's PreToolUse hook before every tool call; a block throws, which denies the call.
import { spawnSync } from "node:child_process";
import { basename } from "node:path";

const BIN = "__AGENT_FLOW_BIN__";
const NODE = process.env.AGENT_FLOW_NODE ?? (/^node(?:\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : "node");

function check(tool, input, cwd) {
  const args = input && typeof input === "object" ? { ...input } : {};
  if (typeof args.filePath === "string" && args.file_path === undefined) args.file_path = args.filePath;
  const event = { tool_name: String(tool ?? ""), tool_input: args, cwd: cwd ?? process.cwd() };
  const r = spawnSync(NODE, [BIN, "guard"], { input: JSON.stringify(event), encoding: "utf-8", cwd: event.cwd, timeout: 30000 });
  if (r.status === 0) return;
  // Fail closed: a guard that could not run is not a pass.
  throw new Error((r.stderr || "").trim() || `agent-flow guard did not run (${r.error?.message ?? `exit ${r.status}`}); call blocked`);
}

// OpenCode v1 loads named plugin functions; v2 loads a default plugin object.
export const AgentFlowGuard = async (ctx = {}) => ({
  "tool.execute.before": async (input, output) => check(input?.tool, output?.args, ctx.directory),
});

let definePlugin = (plugin) => plugin;
try {
  definePlugin = (await import("@opencode/plugin")).Plugin.define;
} catch {
  // OpenCode v1 does not ship the v2 SDK; its named AgentFlowGuard export is used instead.
}

const plugin = definePlugin({
  id: "agent-flow.guard",
  async setup(ctx) {
    const cwd = ctx.location?.directory ?? ctx.directory ?? process.cwd();
    await ctx.tool.hook("execute.before", async (event) => check(event?.tool, event?.input, cwd));
  },
});

export default {
  ...plugin,
  async server(ctx = {}) {
    return {
      "tool.execute.before": async (input, output) => check(input?.tool, output?.args, ctx.directory ?? process.cwd()),
    };
  },
};
