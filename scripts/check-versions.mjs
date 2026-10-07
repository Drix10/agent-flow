// One version, everywhere. A release bumps it in seven files across five host ecosystems by hand, and the failure that
// matters is every file staying stale together (they "agree", and the release ships the old number).
//   1. every file that declares the version must declare the same pinned X.Y.Z;
//   2. the CHANGELOG must have a `## [X.Y.Z]` section for it;
//   3. every `Drix10/agent-flow@vX.Y.Z` example in the docs must name it (an example pointing at the previous release
//      is a copy-paste that installs the wrong thing);
//   4. on a release-tag run (GITHUB_REF_TYPE=tag) it must equal the tag.
// Usage: node scripts/check-versions.mjs   (exit 1 on any mismatch). AGENT_FLOW_VERSION_ROOT points it at another tree (tests).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.AGENT_FLOW_VERSION_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");
const PINNED = /^\d+\.\d+\.\d+$/;
const read = (rel) => readFileSync(join(root, rel), "utf-8").replace(/^﻿/, "");
const json = (rel) => JSON.parse(read(rel));

// Every place the version lives, and how to read it there. Add a new host's manifest here so it can't drift unnoticed.
const SOURCES = [
  ["package.json", (j) => j.version],
  ["package-lock.json", (j) => j.version],
  ["package-lock.json (packages[\"\"])", (j) => j.packages?.[""]?.version, "package-lock.json"],
  [".claude-plugin/plugin.json", (j) => j.version],
  [".claude-plugin/marketplace.json", (j) => j.plugins?.find((p) => p.name === "agent-flow")?.version],
  ["plugins/agent-flow/plugin.json", (j) => j.version],
  ["gemini-extension.json", (j) => j.version],
];
const DOCS_WITH_ACTION_TAG = ["README.md", "docs/ADOPTION.md"];

let failed = false;
const fail = (msg) => {
  console.error(msg);
  failed = true;
};

const versions = SOURCES.map(([label, pick, file = label]) => {
  let v;
  try {
    v = pick(json(file));
  } catch (e) {
    fail(`${label}: ${e.message}`);
  }
  if (typeof v !== "string" || !PINNED.test(v)) fail(`${label}: version must be a pinned X.Y.Z, got ${JSON.stringify(v)}`);
  return [label, v];
});

const distinct = [...new Set(versions.map(([, v]) => v))];
if (distinct.length > 1) {
  fail("Version mismatch: every file must declare one version:");
  for (const [label, v] of versions) console.error(`  ${String(v).padEnd(10)} ${label}`);
}
const shared = distinct.length === 1 ? distinct[0] : null;

if (shared) {
  const changelog = read("CHANGELOG.md");
  if (!new RegExp(`^## \\[${shared.replace(/\./g, "\\.")}\\]`, "m").test(changelog)) fail(`CHANGELOG.md has no "## [${shared}]" section`);

  for (const doc of DOCS_WITH_ACTION_TAG) {
    for (const m of read(doc).matchAll(/Drix10\/agent-flow@v(\d+\.\d+\.\d+)/g)) {
      if (m[1] !== shared) fail(`${doc} shows Drix10/agent-flow@v${m[1]}, but the version is ${shared}`);
    }
  }

  if (process.env.GITHUB_REF_TYPE === "tag") {
    const tag = (process.env.GITHUB_REF_NAME || "").replace(/^v/, "");
    if (tag !== shared) fail(`release tag v${tag} does not match version ${shared}: bump the version files before tagging`);
  }
}

if (failed) {
  console.error("Bump every version file together (package.json, package-lock.json twice, plugin.json, .claude-plugin/*, gemini-extension.json), the docs' action tag, and add the CHANGELOG section.");
  process.exit(1);
}
console.log(`All ${SOURCES.length} version files, the CHANGELOG and the docs agree on ${shared}.`);
