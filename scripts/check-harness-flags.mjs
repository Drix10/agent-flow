// Does each installed harness CLI still accept the flags launch.md uses? Reads `--help`; no login, no network, no model call.
// Usage: node scripts/check-harness-flags.mjs   (exit 1 when an installed CLI lacks a flag; missing CLIs are reported, not failed)
import { spawnSync } from "node:child_process";

const WANT = {
  claude: { help: ["--help"], flags: ["-p", "--model", "--output-format", "--permission-mode", "--disallowedTools", "--resume", "--add-dir", "--setting-sources"] },
  codex: { help: ["exec", "--help"], flags: ["--sandbox", "-C", "--add-dir", "-m"] },
  gemini: { help: ["--help"], flags: ["--approval-mode", "-m"] },
  pi: { help: ["--help"], flags: ["-p", "--tools", "--model"] },
};
let failed = 0;
for (const [bin, { help, flags }] of Object.entries(WANT)) {
  const r = spawnSync(bin, help, { encoding: "utf-8", shell: process.platform === "win32", timeout: 60_000 });
  if (r.error || r.status === null) {
    console.log(`- ${bin}: not installed or did not run (${r.error?.code ?? "no exit"})`);
    continue;
  }
  const text = `${r.stdout}\n${r.stderr}`;
  const missing = flags.filter((f) => !new RegExp(`(^|[\\s,|<\\[])${f.replace(/[-\\^$*+?.()|[\]{}]/g, "\\$&")}(?![\\w-])`, "m").test(text));
  if (missing.length) {
    failed++;
    console.log(`x ${bin}: --help no longer lists ${missing.join(", ")}`);
    console.log(`::error::${bin} --help no longer lists ${missing.join(", ")}; update skills/invoking-agents/references/launch.md`);
  } else console.log(`ok ${bin}: ${flags.join(" ")}`);
}
process.exit(failed ? 1 : 0);
