// agent-flow guard for OpenCode. Installed by `agent-flow install --harness opencode`.
// Runs the same guard as Claude Code's PreToolUse hook before every tool call; a block throws, which denies the call.
// One flat file (OpenCode scans only top-level files of .opencode/plugins/) with no SDK import, so it loads on v1 and v2 alike.
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

// Relative to this file (.opencode/plugins/), so the plugin works in every clone, not only on the machine that installed it.
const BIN = fileURLToPath(new URL("../../bin/agent-flow.js", import.meta.url));
const NODE = process.env.AGENT_FLOW_NODE ?? (/^node(?:\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : "node");

function check(tool, input, cwd) {
  const args = input && typeof input === "object" ? { ...input } : {};
  // v1 names the path `filePath`, v2 names it `path`; the guard reads `file_path`.
  if (args.file_path === undefined) {
    const p = args.filePath ?? args.path;
    if (typeof p === "string") args.file_path = p;
  }
  const event = { tool_name: String(tool ?? ""), tool_input: args, cwd: cwd ?? process.cwd() };
  const r = spawnSync(NODE, [BIN, "guard"], { input: JSON.stringify(event), encoding: "utf-8", cwd: event.cwd, timeout: 30000 });
  if (r.status === 0) return;
  // Fail closed: a guard that could not run is not a pass.
  throw new Error((r.stderr || "").trim() || `agent-flow guard did not run (${r.error?.message ?? `exit ${r.status}`}); call blocked`);
}

// OpenCode v1 (older builds): every named function export is loaded as a plugin.
export const AgentFlowGuard = async (ctx = {}) => ({
  "tool.execute.before": async (input, output) => check(input?.tool, output?.args, ctx.directory),
});

// v2 loads the default export's `setup`; newer v1 loads its `server`. Plain object, no SDK import needed.
export default {
  id: "agent-flow-guard",
  async setup(ctx) {
    const cwd = ctx.location?.directory ?? ctx.directory ?? process.cwd();
    await ctx.tool.hook("execute.before", async (event) => check(event?.tool, event?.input, cwd));
  },
  async server(ctx = {}) {
    return {
      "tool.execute.before": async (input, output) => check(input?.tool, output?.args, ctx.directory ?? process.cwd()),
    };
  },
};
