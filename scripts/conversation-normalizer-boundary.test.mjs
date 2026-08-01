import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const normalizerSource = "packages/conversation-normalizer/src/normalizer.ts";

test("Conversation normalizer uses the Ledger only as a compile-time port", async () => {
  const source = await readFile(normalizerSource, "utf8");
  assert.match(source, /import\s+type\s+\{\s*LedgerEventRecord\s*\}\s+from\s+["']@zhiloop\/conversation-ledger["']/);
  assert.doesNotMatch(source, /import\s+\{[^}]*\}\s+from\s+["']@zhiloop\/conversation-ledger["']/);
  assert.doesNotMatch(source, /node:sqlite/);
});
