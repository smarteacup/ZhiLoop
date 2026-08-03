import type { CapabilitySnapshot, InjectionAttempt, ProvenanceLink } from "./schemas.js";

const observedAt = "2026-08-03T12:00:00.000Z";

export const REDACTED_CONTRACT_FIXTURES = Object.freeze({
  capability: Object.freeze({
    schemaVersion: 1,
    capabilityId: "knowledge.compile",
    status: "DISABLED",
    reasonCode: "KNOWLEDGE_WORKER_NOT_COMPOSED",
    observedAt,
    lastTransitionAt: observedAt,
    retryable: false,
    evidenceRefs: ["deployment:sidecar:0.1.4"],
    nextAction: "Enable the production knowledge worker",
  } satisfies CapabilitySnapshot),
  injection: Object.freeze({
    schemaVersion: 1,
    attemptId: "attempt_demo_01",
    sessionId: "session_demo_01",
    turnId: "turn_demo_01",
    status: "SHADOWED",
    runId: "run_demo_01",
    traceId: "trace_demo_01",
    knowledge: [{ id: "knowledge_demo_01", version: 2 }],
    estimatedTokens: 96,
    maxTokens: 800,
    reasonCode: "SHADOW_CONTEXT_ONLY",
    observedAt,
    lastTransitionAt: observedAt,
    retryable: false,
    evidenceRefs: ["trace:trace_demo_01"],
  } satisfies InjectionAttempt),
  provenance: Object.freeze({
    schemaVersion: 1,
    sessionId: "session_demo_01",
    turnId: "turn_demo_01",
    sourceSequenceFrom: 10,
    sourceSequenceTo: 18,
    snapshotId: "snapshot_demo_01",
    runId: "run_demo_01",
    traceId: "trace_demo_01",
    knowledge: [{ id: "knowledge_demo_01", version: 2 }],
  } satisfies ProvenanceLink),
});
