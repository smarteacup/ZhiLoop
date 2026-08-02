import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("default Codex model adapter stays outside the knowledge compiler domain boundary", async () => {
  const compilerManifest = JSON.parse(await readFile(new URL("packages/knowledge-compiler/package.json", root), "utf8"));
  const adapterManifest = JSON.parse(await readFile(new URL("packages/model-codex-exec/package.json", root), "utf8"));
  const compilerSource = await readFile(new URL("packages/knowledge-compiler/src/mvp-compiler.ts", root), "utf8");

  assert.deepEqual(Object.keys(adapterManifest.dependencies), ["@zhiloop/knowledge-compiler"]);
  assert.equal(compilerManifest.dependencies?.["@zhiloop/model-codex-exec"], undefined);
  assert.doesNotMatch(compilerSource, /model-codex-exec|child_process|codex exec/);
});

test("Codex exec adapter enforces a non-shell read-only structured-output invocation", async () => {
  const modelSource = await readFile(new URL("packages/model-codex-exec/src/model.ts", root), "utf8");
  const processSource = await readFile(new URL("packages/model-codex-exec/src/process.ts", root), "utf8");

  assert.match(modelSource, /"--sandbox", "read-only"/);
  assert.match(modelSource, /"--ephemeral"/);
  assert.match(modelSource, /"--json"/);
  assert.match(modelSource, /"--output-schema"/);
  assert.match(modelSource, /"--output-last-message"/);
  assert.match(processSource, /shell: false/);
  assert.doesNotMatch(modelSource, /danger-full-access|workspace-write/);
});
