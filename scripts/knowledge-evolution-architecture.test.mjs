import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

async function productionSources(directory) {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
  return await Promise.all(files.map(async (file) => ({ file, source: await readFile(join(directory, file), "utf8") })));
}

test("durable knowledge evolution use cases depend on ports rather than Git, CodeGraph, SQLite, timers, or Sidecar", async () => {
  const sources = await productionSources("packages/knowledge-evolution-jobs/src");
  for (const { file, source } of sources) {
    assert.doesNotMatch(source, /node:(?:sqlite|child_process)|@zhiloop\/knowledge-change-intake|@zhiloop\/codegraph-adapter|apps\/sidecar|set(?:Timeout|Interval)\(/u,
      `${file} crossed the durable evolution use-case boundary`);
    assert.doesNotMatch(source, /GitKnowledge|CodeGraph(?:Query|Node|Edge|Response|Dto)/u,
      `${file} imported an adapter-specific DTO`);
  }
});

test("typed evolution runtime owns no Git, CodeGraph, model, command, or Sidecar adapter", async () => {
  const sources = await productionSources("packages/evolution-job-runtime/src");
  for (const { file, source } of sources) {
    assert.doesNotMatch(source, /node:child_process|@zhiloop\/(?:knowledge-change-intake|codegraph-adapter|model-codex-exec)|apps\/sidecar/u,
      `${file} crossed the typed job runtime boundary`);
  }
});

test("the pre-injection freshness gate remains a bounded read/verification port and starts no external work", async () => {
  const source = await readFile("packages/knowledge-freshness/src/gate.ts", "utf8");
  assert.doesNotMatch(source, /node:(?:sqlite|child_process|fs)|@zhiloop\/(?:knowledge-change-intake|codegraph-adapter|model-codex-exec)|execFile\(|spawn\(|git\s/u);
  assert.doesNotMatch(source, /initializeCodeGraph|scanProject|scanGit/u);
  assert.match(source, /deadlineMs/);
  assert.match(source, /minimumTargetedBudgetMs/);
});
