/**
 * Human confirmation for writes.
 *
 * v1.0.2 gated writes on a string like "CONFIRM_BOOTSTRAP" — which was printed
 * in the tool's own parameter description, so the model could (and would)
 * simply pass it. That is a speed bump, not a gate.
 *
 * Now:
 *  - Interactive (TUI / RPC): Pi shows a real confirm dialog. Only a human can
 *    click it. The token is ignored.
 *  - Headless (`pi -p`): there is no human to ask, so writes are REFUSED unless
 *    the person who launched the process opted in with
 *    AGENT_FLOW_HEADLESS_WRITES=1. The model cannot set that for its own process.
 */

export const HEADLESS_ENV = "AGENT_FLOW_HEADLESS_WRITES";

interface MaybeCtx {
  hasUI?: boolean;
  ui?: { confirm?: (title: string, message: string) => Promise<boolean> };
}

export async function requireConfirmation(ctx: MaybeCtx | undefined, title: string, message: string): Promise<"ui" | "headless-env"> {
  if (ctx?.hasUI && typeof ctx.ui?.confirm === "function") {
    const ok = await ctx.ui.confirm(title, message);
    if (!ok) throw new Error(`${title}: declined by the user.`);
    return "ui";
  }
  if (process.env[HEADLESS_ENV] === "1") return "headless-env";
  throw new Error(
    `${title}: refused — no interactive UI to ask a human. ` +
      `Run Pi interactively, or have the human launch with ${HEADLESS_ENV}=1 to allow unattended writes.`,
  );
}
