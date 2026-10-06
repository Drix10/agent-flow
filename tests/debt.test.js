// agent-flow debt: the `lean:` shortcut comments in the code, one ledger row each, `no-trigger` on the ones that rot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { insideString, parseShortcut, scanDebt } from "../extensions/lib/debt.js";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
const cli = (cwd, ...a) => spawnSync(process.execPath, [BIN, ...a], { cwd, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1", AGENT_FLOW_OFFLINE: "1", AGENT_FLOW_ROLE: "" } });

function repo(files, { ignore = "" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "af-debt-"));
  const git = (...a) => spawnSync("git", a, { cwd: dir });
  git("init", "-q", "-b", "main");
  if (ignore) writeFileSync(join(dir, ".gitignore"), ignore);
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(dir, ...f.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  return dir;
}

test("parseShortcut: the ceiling and the trigger, in this repo's form and ponytail's", () => {
  assert.deepEqual(parseShortcut("global lock; per-account locks if throughput matters"), { ceiling: "global lock", upgrade: "per-account locks if throughput matters", no_trigger: false });
  assert.deepEqual(parseShortcut("naive heuristic, upgrade to a model when precision matters"), { ceiling: "naive heuristic", upgrade: "upgrade to a model when precision matters", no_trigger: false });
  // A condition named without a separator still counts as a trigger.
  assert.equal(parseShortcut("O(n^2) scan until the list grows past 10k").no_trigger, false);
  // Nothing says when to come back: that is the one that rots.
  assert.deepEqual(parseShortcut("global lock"), { ceiling: "global lock", upgrade: null, no_trigger: true });
  assert.equal(parseShortcut("quick and dirty").no_trigger, true);
  assert.equal(parseShortcut("fixed buffer; ").upgrade, null, "a separator with nothing after it names nothing");
  assert.equal(parseShortcut("fixed buffer; ").no_trigger, true);
  // Comment closers don't leak into the text.
  assert.equal(parseShortcut("inline style; extract when reused -->").upgrade, "extract when reused");
  assert.equal(parseShortcut("fixed buffer; grow it when inputs exceed 4k */").upgrade, "grow it when inputs exceed 4k");
});

test("scanDebt finds the marker in every comment style, and only there", () => {
  const dir = repo({
    "src/queue.py": "x = 1\n# lean: one global lock; per-account locks if throughput matters\n",
    "src/api.js": "const a = 1; // lean: naive retry\n",
    "src/buf.c": "/* lean: fixed buffer; grow it when inputs exceed 4k */\n",
    "db/q.sql": "-- lean: full scan; add an index when the table grows\n",
    "ui/page.html": "<!-- lean: inline style; extract when reused -->\n",
    "src/old.py": "# ponytail: global lock, per-account locks if throughput matters\n",
    // Not markers: docs showing the convention, prose, a string, a backticked mention, a capitalised word.
    "docs/NOTES.md": "# lean: this is an example in a doc\n",
    "src/prose.py": "print('see the lean: marker')\n# the lean: marker is described elsewhere\nname = 'x'  # Lean: a heading, not a marker\ns = \"// lean: inside a string\"\n",
    "src/ticks.py": "# use `# lean: x; y` to mark one\n",
    "dist/out.js": "// lean: build output\n",
    "node_modules/pkg/i.js": "// lean: vendored\n",
  });
  try {
    const r = scanDebt(dir);
    const rows = r.rows.map((x) => `${x.file}:${x.line}:${x.marker}`).sort();
    assert.deepEqual(rows, ["db/q.sql:1:lean", "src/api.js:1:lean", "src/buf.c:1:lean", "src/old.py:1:ponytail", "src/queue.py:2:lean", "ui/page.html:1:lean"]);
    const by = Object.fromEntries(r.rows.map((x) => [x.file, x]));
    assert.equal(by["src/queue.py"].ceiling, "one global lock");
    assert.equal(by["src/queue.py"].upgrade, "per-account locks if throughput matters");
    assert.equal(by["src/api.js"].no_trigger, true);
    assert.equal(by["src/old.py"].upgrade, "per-account locks if throughput matters", "ponytail's comma form reads too");
    assert.equal(by["ui/page.html"].upgrade, "extract when reused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a marker inside a string literal is text, not a comment (fixtures, log lines), a real one after closed strings still counts", () => {
  assert.equal(insideString('const s = "a; '), true);
  assert.equal(insideString("print('"), true);
  assert.equal(insideString('x = "a"  '), false, "closed");
  assert.equal(insideString('say = "he said \\"hi\\" '), true, "an escaped quote doesn't close it");
  assert.equal(insideString('f"{x} '), true);
  assert.equal(insideString("it's fine # not a string? "), true, "an unbalanced apostrophe before the marker reads as an open string: a miss, never a false row");
  assert.equal(insideString(""), false);
  const dir = repo({
    "fixture.js": 'const a = 1; // lean: real; revisit when slow\nconst s = "const a = 1; // lean: inside; a fixture";\nconst t = \'x\'; // lean: after a closed string; add when needed\n',
    "log.py": 'print("# lean: inside a string")\nx = "a"  # lean: real; upgrade when it grows\nprint(f"{x} # lean: inside an f-string")\n',
  });
  try {
    assert.deepEqual(scanDebt(dir).rows.map((r) => `${r.file}:${r.line}`).sort(), ["fixture.js:1", "fixture.js:3", "log.py:2"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanDebt skips gitignored files, minified bundles and binaries", () => {
  const dir = repo(
    {
      "keep.py": "# lean: kept; revisit when slow\n",
      "secret/ignored.py": "# lean: ignored; whenever\n",
      "bundle.min.js": `var a="${"x".repeat(3000)}"; // lean: minified; never\n`,
      "blob.bin": Buffer.from([0, 1, 2, 3]).toString("latin1") + "# lean: binary; never\n",
    },
    { ignore: "secret/\n" },
  );
  try {
    assert.deepEqual(scanDebt(dir).rows.map((x) => x.file), ["keep.py"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("debt (CLI): rows grouped by file, a summary, --json, and --fail-on-no-trigger", () => {
  const dir = repo({
    "a.py": "# lean: global lock; per-account locks if throughput matters\n",
    "b.js": "// lean: naive\n",
  });
  try {
    const human = cli(dir, "debt");
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /a\.py\n {2}:1 {2}global lock {2}→ per-account locks if throughput matters/);
    assert.match(human.stdout, /b\.js\n {2}:1 {2}naive {2}\[no-trigger\]/);
    assert.match(human.stdout, /2 markers, 1 with no trigger\./);
    assert.match(human.stdout, /names no condition for revisiting it is the one that rots/);

    const json = JSON.parse(cli(dir, "debt", "--json").stdout);
    assert.equal(json.markers, 2);
    assert.equal(json.no_trigger, 1);
    assert.equal(json.rows.find((x) => x.file === "b.js").no_trigger, true);

    assert.equal(cli(dir, "debt", "--fail-on-no-trigger").status, 1, "fails while one names no trigger");
    writeFileSync(join(dir, "b.js"), "// lean: naive; use a real parser when inputs get nested\n");
    assert.equal(cli(dir, "debt", "--fail-on-no-trigger").status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("debt (CLI): an empty ledger says so and exits 0", () => {
  const dir = repo({ "a.py": "print(1)\n" });
  try {
    const r = cli(dir, "debt", "--fail-on-no-trigger");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no lean: debt\. Clean ledger\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status shows deferred shortcuts only when there are some, and warns about the ones with no trigger", () => {
  const dir = repo({ "AGENTS.md": "# r\n", "a.py": "# lean: global lock; per-account locks if throughput matters\n" });
  try {
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ version: "2", context_files: [{ path: "AGENTS.md", references: [] }], protected_paths: ["secret/**"] }));
    let rows = JSON.parse(cli(dir, "status", "--json").stdout).rows;
    const one = rows.find((r) => /deferred shortcut/.test(r.text));
    assert.match(one.text, /^1 deferred shortcut \(lean: comments\)$/);
    assert.equal(one.level, "info");
    assert.equal(one.hint, "agent-flow debt");
    writeFileSync(join(dir, "b.py"), "# lean: quick hack\n");
    rows = JSON.parse(cli(dir, "status", "--json").stdout).rows;
    const two = rows.find((r) => /deferred shortcut/.test(r.text));
    assert.match(two.text, /^2 deferred shortcuts \(lean: comments\), 1 with no trigger to revisit them$/);
    assert.equal(two.level, "warn");
    rmSync(join(dir, "a.py"));
    rmSync(join(dir, "b.py"));
    rows = JSON.parse(cli(dir, "status", "--json").stdout).rows;
    assert.ok(!rows.some((r) => /deferred shortcut/.test(r.text)), "no row when there is nothing deferred");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the agent-flow-gardener skill and prompts know /debt and /audit-lean", async () => {
  const { readFileSync } = await import("node:fs");
  const root = join(fileURLToPath(new URL("..", import.meta.url)));
  const gardener = readFileSync(join(root, "skills/agent-flow-gardener/SKILL.md"), "utf-8");
  for (const phrase of ["## /debt", "## /audit-lean", "AF debt", "[no-trigger]", "net: -N lines, -M dependencies possible"]) assert.ok(gardener.includes(phrase), phrase);
  for (const p of ["debt", "audit-lean"]) assert.match(readFileSync(join(root, "prompts", `${p}.md`), "utf-8"), /^---\ndescription: .+\n---\n/);
  assert.match(readFileSync(join(root, "prompts/garden.md"), "utf-8"), /\/audit-risk → \/debt → \/doctor/);
});

test("scanDebt stops at its time budget and says the list is partial", () => {
  const dir = repo({ "a.js": "// lean: one lock; per-key locks when contended\n", "b.js": "// lean: naive scan; index it past 10k rows\n" });
  const full = scanDebt(dir);
  assert.equal(full.rows.length, 2);
  assert.equal(full.truncated, false);
  // A budget already spent: nothing is read, and the report is marked partial rather than silently empty.
  const cut = scanDebt(dir, { budgetMs: -1 });
  assert.equal(cut.truncated, true);
  assert.ok(cut.rows.length < 2);
});
