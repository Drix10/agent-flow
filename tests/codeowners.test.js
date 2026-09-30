// doctor's advisory: protected paths should have a CODEOWNERS entry, and it never fails doctor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { uncoveredProtected } from "../extensions/lib/codeowners.js";

const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));

function repo(owners, fn) {
  const dir = mkdtempSync(join(tmpdir(), "af-co-"));
  try {
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ version: "1", protected_paths: ["infra/**", ".github/workflows/*.yml"] }));
    if (owners !== null) {
      mkdirSync(join(dir, ".github"));
      writeFileSync(join(dir, ".github/CODEOWNERS"), owners);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("coverage: wildcard, directory prefix, exact glob, and gaps", () => {
  repo("# owners\n* @a\n", (d) => assert.deepEqual(uncoveredProtected(d, ["infra/**"]), []));
  repo("/infra/ @a\n/.github/ @a\n", (d) => assert.deepEqual(uncoveredProtected(d, ["infra/**", ".github/workflows/*.yml"]), []));
  repo("/docs/ @a\n", (d) => assert.deepEqual(uncoveredProtected(d, ["infra/**"]), ["infra/**"]));
  repo(null, (d) => assert.equal(uncoveredProtected(d, ["infra/**"]), null));
});

test("doctor warns about a missing or partial CODEOWNERS but stays healthy", () => {
  for (const [owners, re] of [[null, /CODEOWNERS file/], ["/infra/ @a\n", /doesn't cover.*\.github\/workflows/]]) {
    repo(owners, (dir) => {
      const r = spawnSync(process.execPath, [BIN, "doctor"], { cwd: dir, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" } });
      assert.match(r.stdout, re);
    });
  }
});

test("coverage is by path segment and honours owner-less lines", () => {
  const cov = (owners, g) => repo(owners, (d) => uncoveredProtected(d, [g]).length === 0);
  assert.equal(cov("/src/billing/invoices/ @a\n", "src/billing/**"), false);
  assert.equal(cov("/docs @a\n", "docs-internal/**"), false);
  assert.equal(cov("/src/bill @a\n", "src/billing/**"), false);
  assert.equal(cov("* @a\n/keep/\n", "keep/**"), false);
  assert.equal(cov("/docs/* @a\n", "docs/**"), false);
  assert.equal(cov("*.pem @a\n", "**/*.pem"), true);
  assert.equal(cov("migrations/ @a\n", "**/migrations/**"), true);
  assert.equal(cov("/package.json @a\n", "**/package.json"), true);
  assert.equal(cov("/src/ @a\n", "src/billing/**"), true);
});
