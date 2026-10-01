// doctor's advisory: protected paths should have a CODEOWNERS entry, and it never fails doctor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { codeownersPattern, githubSlug, hostCodeOwnerReview, uncoveredProtected } from "../extensions/lib/codeowners.js";

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

test("a missing or partial CODEOWNERS is a quiet note with the fix, never a warning, and doctor stays healthy", () => {
  for (const [owners, re] of [[null, /note: no CODEOWNERS file/], ["/infra/ @a\n", /note: CODEOWNERS misses \.github\/workflows/]]) {
    repo(owners, (dir) => {
      const r = spawnSync(process.execPath, [BIN, "doctor"], { cwd: dir, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" } });
      assert.match(r.stdout, re);
      assert.match(r.stdout, /agent-flow codeowners --yes/);
      assert.doesNotMatch(r.stdout, /^! .*CODEOWNERS/m, "not a warning line");
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

test("`codeowners` previews the lines with the owner from origin, --yes writes them, and doctor's own check accepts them", () => {
  const dir = mkdtempSync(join(tmpdir(), "af-co-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["remote", "add", "origin", "https://github.com/acme/widget.git"], { cwd: dir });
    writeFileSync(join(dir, "AGENTS.md"), "# a\n");
    const prot = ["STAGE", "kernel/exec/**", "**/*.pem"];
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ version: "2", context_files: [{ path: "AGENTS.md", references: [] }], protected_paths: prot }));
    const af = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: dir, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1", AGENT_FLOW_OFFLINE: "1" } });
    const preview = af("codeowners");
    for (const g of prot) assert.ok(preview.stdout.includes(`${codeownersPattern(g)}  @acme`), preview.stdout);
    assert.match(preview.stdout, /nothing written/);
    assert.equal(af("codeowners", "--yes").status, 0);
    assert.match(af("doctor").stdout, /protected paths have CODEOWNERS entries/);
    // A second run has nothing to add, and an existing file is appended to, never replaced.
    assert.match(af("codeowners", "--yes").stdout, /already covers every protected path/);
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), JSON.stringify({ version: "2", context_files: [{ path: "AGENTS.md", references: [] }], protected_paths: [...prot, "infra/**"] }));
    assert.equal(af("codeowners", "--yes", "--owner", "ops-team").status, 0);
    const file = readFileSync(join(dir, ".github", "CODEOWNERS"), "utf-8");
    assert.match(file, /\/STAGE {2}@acme[\s\S]*\/infra\/ {2}@ops-team/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GitHub's real setting: ruleset, classic protection, unreadable protection, unprotected, and no gh at all", () => {
  const fake = (routes) => (path) => (path in routes ? routes[path] : { ok: false, status: 404 });
  const base = "repos/acme/w";
  const ok = (json) => ({ ok: true, json });
  assert.deepEqual(hostCodeOwnerReview("acme/w", "main", { api: fake({ [`${base}/rules/branches/main`]: ok([{ type: "pull_request", parameters: { require_code_owner_review: true } }]) }) }), { state: "enforced", via: "ruleset" });
  const classic = (prot) => ({ [`${base}/rules/branches/main`]: ok([]), [`${base}/branches/main`]: ok({ protected: true }), ...(prot ? { [`${base}/branches/main/protection`]: prot } : {}) });
  assert.deepEqual(hostCodeOwnerReview("acme/w", "main", { api: fake(classic(ok({ required_pull_request_reviews: { require_code_owner_reviews: true } }))) }), { state: "enforced", via: "branch protection" });
  assert.deepEqual(hostCodeOwnerReview("acme/w", "main", { api: fake(classic(null)) }), { state: "unknown", protected: true }, "no admin rights to read it");
  assert.deepEqual(hostCodeOwnerReview("acme/w", "main", { api: fake({ [`${base}/rules/branches/main`]: ok([]), [`${base}/branches/main`]: ok({ protected: false }) }) }), { state: "not_enforced", protected: false });
  assert.equal(hostCodeOwnerReview("acme/w", "main", { api: () => ({ ok: false, status: null }) }), null, "no gh / not logged in / offline: silence");
  assert.equal(hostCodeOwnerReview("acme/w", "main", { gh: "definitely-not-a-gh-binary" }), null);
  assert.deepEqual([githubSlug("https://github.com/acme/w.git"), githubSlug("git@github.com:acme/w"), githubSlug("https://gitlab.com/acme/w")], ["acme/w", "acme/w", null]);
});

test("doctor --allow-stale exits 0 when staleness is the only problem, and still fails a broken path", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const BIN = fileURLToPath(new URL("../bin/agent-flow.js", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "af-stale-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "AGENTS.md"), "# a\nSee `AGENTS.md`.\n");
    const old = "2020-01-01T00:00:00.000Z";
    const man = (refs) => JSON.stringify({ version: "2", staleness_threshold_days: 30, context_files: [{ path: "AGENTS.md", references: refs }], protected_paths: [] });
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), man([{ path: "AGENTS.md", type: "file", last_verified: old, exists: true }]));
    const doc = (...a) => spawnSync(process.execPath, [BIN, "doctor", ...a], { cwd: dir, encoding: "utf-8" }).status;
    assert.equal(doc(), 1, "stale is unhealthy by default");
    assert.equal(doc("--allow-stale"), 0);
    writeFileSync(join(dir, "CONTEXT_MANIFEST.json"), man([{ path: "AGENTS.md", type: "file", last_verified: old, exists: true }, { path: "gone.md", type: "file", last_verified: old, exists: true }]));
    assert.equal(doc("--allow-stale"), 1, "a missing path still fails");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bare wildcard matches at any depth in CODEOWNERS, and a rooted path stays rooted", () => {
  assert.equal(codeownersPattern("*.pem"), "*.pem");
  assert.equal(codeownersPattern("**/*.pem"), "*.pem");
  assert.equal(codeownersPattern("STAGE"), "/STAGE");
  assert.equal(codeownersPattern("kernel/exec/**"), "/kernel/exec/");
  assert.equal(codeownersPattern("src/*.ts"), "/src/*.ts");
});

test("doctor --allow-stale tracks the report's own notion of broken, not a copied list", () => {
  // stale.ts exports only_stale from the same conditions as `healthy`; a healthy repo is never "only stale".
  return import("../extensions/lib/stale.js").then(({ detectStale }) => {
    const dir = mkdtempSync(join(tmpdir(), "af-os-"));
    try {
      writeFileSync(join(dir, "AGENTS.md"), "# a\n");
      const r = detectStale(dir, { discover: true });
      assert.equal(r.ok, true);
      assert.equal(r.healthy, true);
      assert.equal(r.only_stale, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
