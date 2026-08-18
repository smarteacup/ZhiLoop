import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const DOMAIN_WORKSPACES = [
  "packages/domain/src",
  "packages/evidence-engine/src",
  "packages/evidence-policy/src",
  "packages/invalidation-engine/src",
];

async function sources(directory) {
  const values = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) values.push(...await sources(target));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) values.push(await readFile(target, "utf8"));
  }
  return values.join("\n");
}

test("production evidence adapters remain outside domain workspaces", async () => {
  for (const directory of DOMAIN_WORKSPACES) {
    const source = await sources(directory);
    assert.doesNotMatch(source, /node:(?:fs|sqlite|child_process)|@zhiloop\/conversation-ledger|@zhiloop\/codegraph-adapter|@zhiloop\/evidence-probes|DatabaseSync|CodeGraphCliAdapter/u, directory);
  }

  const verification = await sources("packages/knowledge-verification/src");
  const probes = await sources("packages/evidence-probes/src");
  const composition = await readFile("apps/sidecar/src/p2-production.ts", "utf8");
  assert.match(verification, /SqliteKnowledgeVerificationStore/u);
  assert.match(probes, /NodeRepositoryReadPort/u);
  assert.match(composition, /CodeGraphCliAdapter/u);
  assert.match(composition, /KnowledgeVerificationService/u);
});
