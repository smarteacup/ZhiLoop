import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateRequiredDirectTests } from "./check-console-tests.mjs";

async function fixture(requireDirectTests, withTest) {
  const root = path.join(tmpdir(), `zhiloop-console-test-check-${crypto.randomUUID()}`);
  const workspace = path.join(root, "packages", "fixture", "src");
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(root, "apps"), { recursive: true });
  await writeFile(path.join(root, "packages", "fixture", "package.json"), JSON.stringify({
    name: "@zhiloop/fixture",
    zhiloop: { requireDirectTests },
  }));
  await writeFile(path.join(workspace, "index.ts"), "export {};\n");
  if (withTest) await writeFile(path.join(workspace, "index.test.ts"), "export {};\n");
  return root;
}

test("fails a required workspace with no direct tests", async () => {
  const root = await fixture(true, false);
  try {
    assert.deepEqual(await validateRequiredDirectTests(root), ["@zhiloop/fixture requires at least one direct src/**/*.test.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts tested or non-required workspaces", async () => {
  for (const [required, withTest] of [[true, true], [false, false]]) {
    const root = await fixture(required, withTest);
    try {
      assert.deepEqual(await validateRequiredDirectTests(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
