import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  REDACTED_CONTRACT_FIXTURES,
  capabilitySnapshotSchema,
  controlRequestSchema,
  injectionAttemptSchema,
  provenanceLinkSchema,
} from "../packages/control-api/dist/index.js";
import { createCursorCodec } from "../packages/control-api/dist/server.js";

test("Console P0 contract Gate: shared DTOs remain strict, traceable, shadow-safe and tamper-resistant", () => {
  const capability = capabilitySnapshotSchema.parse(REDACTED_CONTRACT_FIXTURES.capability);
  const injection = injectionAttemptSchema.parse(REDACTED_CONTRACT_FIXTURES.injection);
  const provenance = provenanceLinkSchema.parse(REDACTED_CONTRACT_FIXTURES.provenance);

  assert.equal(capability.status, "DISABLED");
  assert.equal(capability.reasonCode, "KNOWLEDGE_WORKER_NOT_COMPOSED");
  assert.equal(injection.status, "SHADOWED");
  assert.notEqual(injection.status, "INJECTED");
  assert.equal(provenance.sessionId, injection.sessionId);
  assert.equal(provenance.turnId, injection.turnId);
  assert.deepEqual(provenance.knowledge, injection.knowledge);

  assert.equal(controlRequestSchema.safeParse({
    schemaVersion: 1,
    requestId: "gate-request-123456",
    type: "overview.get",
    unknown: true,
  }).success, false);

  const codec = createCursorCodec("console-gate-secret-32-bytes-long!!");
  const cursor = codec.encode({
    version: 1,
    sortKey: "2026-08-03T12:00:00.000Z",
    tieBreaker: "session-demo",
    filterHash: "0".repeat(64),
  });
  assert.equal(codec.decode(cursor).tieBreaker, "session-demo");
  assert.throws(() => codec.decode(`${cursor}x`), /invalid cursor/);
  assert.doesNotMatch(JSON.stringify(REDACTED_CONTRACT_FIXTURES), /password|authorization|api[_-]?key|secret|prompt/i);
});

test("Console P0 contract Gate: package policy requires direct tests and server crypto is isolated", async () => {
  const manifest = JSON.parse(await readFile(new URL("../packages/control-api/package.json", import.meta.url), "utf8"));
  assert.equal(manifest.zhiloop.requireDirectTests, true);
  assert.equal(manifest.exports["./server"].default, "./dist/server.js");
  const browserEntry = await readFile(new URL("../packages/control-api/src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(browserEntry, /cursor|node:crypto/);
});
