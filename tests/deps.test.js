// The risk check reads dependencies from the places modern projects keep them, so a new package or base image in a
// diff reaches risk review. A real user reviewed these by hand because the check did not see them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDependencyManifest, parseDependencies } from "../extensions/lib/risk.js";
import { classifyFiles } from "../extensions/lib/classify.js";

test("pyproject: PEP 735 groups, uv dev-dependencies and poetry groups count; an include-group is not a package", () => {
  const toml = [
    "[project]", 'dependencies = ["httpx>=0.27"]',
    "[dependency-groups]", 'dev = ["pytest>=8", { include-group = "lint" }]', 'lint = ["ruff"]',
    "[tool.uv]", 'dev-dependencies = ["mypy"]',
    "[tool.poetry.group.test.dependencies]", 'python = "^3.9"', 'respx = "*"',
  ].join("\n");
  assert.deepEqual(parseDependencies("pyproject.toml", toml), ["httpx", "mypy", "pytest", "respx", "ruff"]);
});

test("requirements in a folder, constraints files and a Pipfile are read", () => {
  assert.deepEqual(parseDependencies("requirements/base.txt", "flask==3.0\n# c\n-r other.txt\n"), ["flask"]);
  assert.deepEqual(parseDependencies("constraints.txt", "urllib3<3\n"), ["urllib3"]);
  assert.deepEqual(parseDependencies("Pipfile", "[packages]\nrequests = \"*\"\n[dev-packages]\npytest = \"*\"\n"), ["pytest", "requests"]);
  assert.deepEqual(parseDependencies("requirements.txt", "a\nb\n"), ["a", "b"], "the old layout still works");
});

test("a base image in a Dockerfile or a compose file is a dependency; a tag bump is the same one; stages and scratch are not", () => {
  assert.deepEqual(parseDependencies("docker-compose.yml", "services:\n  db:\n    image: postgres:16\n  app:\n    image: \"ghcr.io/o/app:1.2@sha256:abc\"\n    # image: old:1\n"), ["image:ghcr.io/o/app", "image:postgres"]);
  assert.deepEqual(parseDependencies("Dockerfile", "FROM node:20 AS build\nFROM --platform=linux/amd64 python:3.11-slim\nFROM build\nFROM scratch\n"), ["image:node", "image:python"]);
  assert.deepEqual(parseDependencies("compose.prod.yaml", "services:\n  a:\n    image: ${REGISTRY}/a:1\n"), [], "an unresolved variable names nothing");
  assert.deepEqual(parseDependencies("docker-compose.yml", "services:\n  db:\n    image: postgres:15\n"), parseDependencies("docker-compose.yml", "services:\n  db:\n    image: postgres:16\n"), "15 to 16 is the same name");
});

test("these files are dependency manifests, so a change to one is medium risk and needs review", () => {
  for (const f of ["requirements/base.txt", "constraints-dev.txt", "Pipfile", "Dockerfile", "deploy/Dockerfile.api", "docker-compose.yml", "ops/compose.prod.yaml", "pyproject.toml"]) {
    assert.equal(isDependencyManifest(f), true, f);
  }
  for (const f of ["docs/requirements.md", "src/composer.ts", "notes/Dockerfile.md", "requirements/readme.md"]) assert.equal(isDependencyManifest(f), false, f);
  const c = classifyFiles(["docker-compose.yml"], null);
  assert.deepEqual(c.dependency_manifests_touched, ["docker-compose.yml"]);
  assert.equal(c.risk_level, "medium");
});
