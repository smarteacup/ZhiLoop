import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAllowedDirections,
  findCycles,
  validateWorkspaces,
} from "./check-workspace-dependencies.mjs";

function workspace(name, kind, dependencies = [], allowedWorkspaceDependencies = []) {
  return {
    name,
    kind,
    dependencies,
    directory: `/workspace/${name}`,
    allowedWorkspaceDependencies,
    allowedExternalDependencies: [],
  };
}

test("accepts an acyclic app-to-package graph", () => {
  const workspaces = new Map([
    ["@zhiloop/app", workspace("@zhiloop/app", "apps", ["@zhiloop/domain"])],
    ["@zhiloop/domain", workspace("@zhiloop/domain", "packages")],
  ]);

  assert.deepEqual(validateWorkspaces(workspaces), []);
});

test("rejects package-to-app dependencies", () => {
  const workspaces = new Map([
    ["@zhiloop/app", workspace("@zhiloop/app", "apps")],
    ["@zhiloop/domain", workspace("@zhiloop/domain", "packages", ["@zhiloop/app"])],
  ]);

  assert.deepEqual(assertAllowedDirections(workspaces), [
    "@zhiloop/domain must not depend on application @zhiloop/app",
  ]);
});

test("reports a stable workspace cycle", () => {
  const workspaces = new Map([
    ["a", workspace("a", "packages", ["b"])],
    ["b", workspace("b", "packages", ["c"])],
    ["c", workspace("c", "packages", ["a"])],
  ]);

  assert.deepEqual(findCycles(workspaces), ["a -> b -> c -> a"]);
});

test("rejects undeclared package-layer dependencies", () => {
  const workspaces = new Map([
    ["@zhiloop/config", workspace("@zhiloop/config", "packages", ["@zhiloop/domain"])],
    ["@zhiloop/domain", workspace("@zhiloop/domain", "packages")],
  ]);

  assert.deepEqual(assertAllowedDirections(workspaces), [
    "@zhiloop/config has undeclared workspace dependency @zhiloop/domain",
  ]);
});

test("accepts declared package-layer dependencies", () => {
  const workspaces = new Map([
    [
      "@zhiloop/config",
      workspace(
        "@zhiloop/config",
        "packages",
        ["@zhiloop/domain"],
        ["@zhiloop/domain"],
      ),
    ],
    ["@zhiloop/domain", workspace("@zhiloop/domain", "packages")],
  ]);

  assert.deepEqual(assertAllowedDirections(workspaces), []);
});
