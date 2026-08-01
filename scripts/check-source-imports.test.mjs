import assert from "node:assert/strict";
import test from "node:test";

import {
  collectModuleSpecifiers,
  validateSourceImports,
} from "./check-source-imports.mjs";

const workspaceNames = new Set(["@zhiloop/domain", "@zhiloop/schemas"]);
const domain = {
  allowedWorkspaceDependencies: [],
  allowedExternalDependencies: [],
};

test("collects static, re-export and dynamic imports", () => {
  assert.deepEqual(
    collectModuleSpecifiers(`
      import type { A } from "./a.js";
      export * from "@zhiloop/domain";
      const lazy = import("node:fs");
    `),
    ["./a.js", "@zhiloop/domain", "node:fs"],
  );
});

test("allows relative imports in Domain", () => {
  assert.deepEqual(
    validateSourceImports('export * from "./scope.js";', "domain.ts", domain, workspaceNames),
    [],
  );
});

test("rejects Node and hoisted workspace imports in Domain", () => {
  assert.deepEqual(
    validateSourceImports(
      'import fs from "node:fs"; import { parse } from "@zhiloop/schemas";',
      "domain.ts",
      domain,
      workspaceNames,
    ),
    [
      "domain.ts: undeclared external import node:fs",
      "domain.ts: undeclared workspace import @zhiloop/schemas",
    ],
  );
});

test("allows explicitly declared package imports", () => {
  const schemas = {
    allowedWorkspaceDependencies: ["@zhiloop/domain"],
    allowedExternalDependencies: ["ajv", "node:*"],
  };
  assert.deepEqual(
    validateSourceImports(
      'import type { EventEnvelope } from "@zhiloop/domain"; import Ajv from "ajv"; import fs from "node:fs";',
      "schemas.ts",
      schemas,
      workspaceNames,
    ),
    [],
  );
});

