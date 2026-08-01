import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const hookSourceDirectory = path.resolve("packages/hook-runtime/src");

async function productionSources() {
  const names = await readdir(hookSourceDirectory);
  return await Promise.all(
    names
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map(async (name) => ({ name, text: await readFile(path.join(hookSourceDirectory, name), "utf8") })),
  );
}

test("Hook runtime does not load SQLite or the Ledger aggregate entry", async () => {
  const sources = await productionSources();
  const combined = sources.map(({ text }) => text).join("\n");
  assert.doesNotMatch(combined, /node:sqlite/);
  assert.doesNotMatch(combined, /from\s+["']@zhiloop\/conversation-ledger["']/);
  assert.match(combined, /from\s+["']@zhiloop\/conversation-ledger\/redaction["']/);
});

test("Hook runtime has no model, code scan, or child-process imports", async () => {
  const sources = await productionSources();
  const combined = sources.map(({ text }) => text).join("\n");
  assert.doesNotMatch(combined, /node:(?:child_process|worker_threads)/);
  assert.doesNotMatch(combined, /@openai|openai\/|glob|fast-glob/);
});
