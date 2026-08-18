import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CONTROL_API_SCHEMA_VERSION,
  REDACTED_CONTRACT_FIXTURES,
  capabilitySnapshotSchema,
  controlRequestSchema,
  diagnosticsSchema,
  idempotencyKeySchema,
  injectionAttemptSchema,
  parseControlRequestText,
  provenanceLinkSchema,
  sessionSummarySchema,
} from "./index.js";
import { createCursorCodec } from "./server.js";
import { assertTransition, canTransition } from "./state-machine.js";

const requestId = "request_1234567890";
const identityHash = createHash("sha256").update("transcript identity").digest("hex");

describe("control API strict contracts", () => {
  it("accepts the redacted fixtures and preserves shadow semantics", () => {
    expect(capabilitySnapshotSchema.parse(REDACTED_CONTRACT_FIXTURES.capability).status).toBe("DISABLED");
    expect(injectionAttemptSchema.parse(REDACTED_CONTRACT_FIXTURES.injection).status).toBe("SHADOWED");
    expect(provenanceLinkSchema.parse(REDACTED_CONTRACT_FIXTURES.provenance).knowledge[0]).toEqual({
      id: "knowledge_demo_01",
      version: 2,
    });
    const serialized = JSON.stringify(REDACTED_CONTRACT_FIXTURES);
    expect(serialized).not.toMatch(/password|authorization|api[_-]?key|secret|prompt/i);
  });

  it("rejects unknown versions and unknown fields", () => {
    expect(parseControlRequestText(JSON.stringify({ schemaVersion: 2, type: "overview.get", requestId }))).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_SCHEMA_VERSION",
    });
    const parsed = controlRequestSchema.safeParse({
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      type: "overview.get",
      requestId,
      unsafeFutureFlag: true,
    });
    expect(parsed.success).toBe(false);
  });

  it("returns stable diagnostics for invalid JSON and byte limits", () => {
    expect(parseControlRequestText("{")).toEqual({
      ok: false,
      code: "INVALID_JSON",
      issues: ["control request is not valid JSON"],
    });
    expect(parseControlRequestText(JSON.stringify({ schemaVersion: 1 }), 4)).toMatchObject({
      ok: false,
      code: "MESSAGE_TOO_LARGE",
    });
    expect(() => parseControlRequestText("{}", 0)).toThrow(/maximumBytes/);
  });

  it("requires expected revision, transcript identity and idempotency for writes", () => {
    expect(controlRequestSchema.parse({
      schemaVersion: 1,
      type: "capture.commit",
      requestId,
      sessionId: "session-1",
      previewRevision: 2,
      transcriptIdentityHash: identityHash,
      idempotencyKey: "capture:session-1:revision-2",
    })).toMatchObject({ previewRevision: 2 });
    expect(controlRequestSchema.safeParse({
      schemaVersion: 1,
      type: "config.activate",
      requestId,
      draftRevision: 3,
      idempotencyKey: "config:activate:revision-3",
    }).success).toBe(false);
    expect(idempotencyKeySchema.safeParse("short").success).toBe(false);
  });

  it("rejects reversed source sequence ranges", () => {
    expect(provenanceLinkSchema.safeParse({
      schemaVersion: 1,
      sessionId: "session-1",
      sourceSequenceFrom: 9,
      sourceSequenceTo: 8,
      knowledge: [],
    }).success).toBe(false);
  });

  it("keeps P0 session and diagnostics views bounded and content-free", () => {
    const session = sessionSummarySchema.parse({
      schemaVersion: 1,
      sessionId: "session-1",
      title: "Deployment planning",
      source: "CODEX_TRANSCRIPT",
      sourceStatus: "AVAILABLE",
      captureStatus: "DISCOVERED_NOT_CAPTURED",
      firstActivityAt: "2026-08-03T10:00:00.000Z",
      lastActivityAt: "2026-08-03T11:00:00.000Z",
      eventCount: 0,
      turnCount: 0,
      ignoredRecords: 0,
      redactionCount: 0,
    });
    expect(session.captureStatus).toBe("DISCOVERED_NOT_CAPTURED");
    expect(session).not.toHaveProperty("prompt");
    expect(diagnosticsSchema.safeParse({
      schemaVersion: 1,
      observedAt: "2026-08-03T11:00:00.000Z",
      ledgerSequence: 10,
      spoolDepth: 0,
      consumerLags: [],
      worker: { healthy: true, consumed: 2, produced: 2, retryableFailures: 0 },
      storage: { healthy: true, databaseBytes: 4096 },
      rawPrompt: "must be rejected",
    }).success).toBe(false);
    expect(diagnosticsSchema.safeParse({
      schemaVersion: 1, observedAt: "2026-08-03T11:00:00.000Z", ledgerSequence: 10, spoolDepth: 0,
      consumerLags: [], worker: { healthy: true, consumed: 2, produced: 2, retryableFailures: 0 },
      storage: { healthy: true, databaseBytes: 4096 },
      operationalAlerts: [{ schemaVersion: 1, alertId: "operational-alert-1", dedupKey: "job:1",
        severity: "CRITICAL", type: "PERMANENT_JOB_FAILURE", entityRef: "job-1",
        reasonCodes: ["ATTEMPTS_EXHAUSTED"], occurrenceCount: 1,
        firstObservedAt: "2026-08-03T10:00:00.000Z", lastObservedAt: "2026-08-03T11:00:00.000Z",
        revision: 1, deliveryState: "LOCAL_ONLY" }],
    }).success).toBe(true);
  });
});

describe("control API state machines", () => {
  it("permits recovery and idempotent observations but rejects terminal rewrites", () => {
    expect(canTransition("capability", "STARTING", "READY")).toBe(true);
    expect(canTransition("capability", "READY", "READY")).toBe(true);
    expect(canTransition("job", "RUNNING", "RETRY_WAIT")).toBe(true);
    expect(canTransition("injection", "RETRIEVING", "SHADOWED")).toBe(true);
    expect(canTransition("injection", "SHADOWED", "INJECTED")).toBe(false);
    expect(() => assertTransition("stage", "SUCCEEDED", "RUNNING")).toThrow(/illegal stage transition/);
  });
});

describe("signed cursor", () => {
  it("round-trips a bounded stable position and rejects tampering", () => {
    const codec = createCursorCodec("0123456789abcdef0123456789abcdef");
    const payload = {
      version: 1 as const,
      sortKey: "2026-08-03T12:00:00.000Z",
      tieBreaker: "session-1",
      filterHash: createHash("sha256").update("all sessions").digest("hex"),
    };
    const cursor = codec.encode(payload);
    expect(codec.decode(cursor)).toEqual(payload);
    const last = cursor.at(-1);
    const tampered = `${cursor.slice(0, -1)}${last === "a" ? "b" : "a"}`;
    expect(() => codec.decode(tampered)).toThrow("invalid cursor");
    expect(() => createCursorCodec("too-short")).toThrow(/at least 32 bytes/);
  });
});
