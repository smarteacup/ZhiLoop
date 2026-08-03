import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ActiveRolloutService,
  evaluateShadowQuality,
  HighRiskGovernanceService,
  MemoryHighRiskGovernanceStateStore,
  MemoryRolloutStateStore,
  type BlastRadius,
  type HighRiskExecutionIdentity,
  type HighRiskGovernanceCommand,
} from "@zhiloop/active-rollout-service";
import { KnowledgeFeedbackRuntime } from "@zhiloop/active-knowledge-runtime";
import type { ContextEnvelope } from "@zhiloop/domain";
import { SqliteFeedbackStore } from "@zhiloop/feedback-engine";
import { fingerprintRetrievalConfiguration, type GoldenDatasetReport } from "@zhiloop/retrieval-evaluation";
import { SqliteRuntimeAuditStore, type InjectionDeliveryStatus } from "@zhiloop/runtime-audit-store";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  P4ConsoleError,
  P4ConsoleRuntime,
  SqliteP4OperationStore,
  SqliteRuntimeAuditQueryAdapter,
  contextEnvelopeSchema,
  mapP4ConsoleError,
} from "./index.js";

const now = "2026-08-04T01:00:00.000Z";
const later = "2026-08-04T01:00:01.000Z";
const secret = "p4-console-cursor-secret-at-least-32-bytes";
const paths: string[] = [];

function consoleHighRisk(
  service: HighRiskGovernanceService,
  store: MemoryHighRiskGovernanceStateStore,
) {
  return {
    get policy() { return service.policy; },
    preview: service.preview.bind(service),
    getPreview: store.getPreview.bind(store),
    commit: service.commit.bind(service),
  };
}

function temporary(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `zhiloop-p4-${name}-`));
  paths.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of paths.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function envelope(runId: string, omittedItems = 0): ContextEnvelope {
  return {
    schemaVersion: 1,
    runId,
    projectId: "project-a",
    taskId: "task-a",
    complexity: {
      level: "L2_COMPACT", breadth: 1, depth: "COMPACT", authority: "VERIFIED_FACT", evidence: "SUMMARY",
      reasonCodes: omittedItems > 0 ? ["TOKEN_BUDGET_APPLIED"] : ["CONTEXT_SELECTED"],
    },
    budget: { maxTokens: 800, estimatedTokens: 120, truncated: omittedItems > 0, disclosedItems: 1, omittedItems },
    items: [{
      id: "knowledge-a", version: 3, subjectKey: "test.p4.knowledge-a", kind: "IMPLEMENTATION", status: "VERIFIED",
      scope: { level: "PROJECT", projectId: "project-a" }, authority: "VERIFIED_FACT", detailLevel: "L2_COMPACT",
      title: "Bounded console runtime", summary: "Only the exact persisted envelope is rendered.", retrievalRank: 1,
      evidenceSummary: [{ evidenceId: "evidence-a", verdict: "SUPPORTS" }],
    }],
    taskContract: { contractId: "contract-a", objective: "Keep the runtime scoped.", gates: ["gate-a"], boundaries: ["boundary-a"] },
  };
}

function seedAttempt(
  store: SqliteRuntimeAuditStore,
  suffix: string,
  status: Exclude<InjectionDeliveryStatus, "PENDING">,
  createdAt: string,
  omitted = 0,
) {
  const runId = `run-${suffix}`;
  store.beginInjection({
    schemaVersion: 1, attemptId: `attempt-${suffix}`, sessionId: "session-a", turnId: `turn-${suffix}`,
    traceId: `trace-${suffix}`, runId, rolloutRevision: 7, status: "PENDING", revision: 0,
    envelope: envelope(runId, omitted), reasonCode: "ATTEMPT_STARTED", createdAt,
  });
  return store.completeInjection(`attempt-${suffix}`, 0, status, `${status}_RESULT`, new Date(Date.parse(createdAt) + 500).toISOString());
}

describe("P4 persisted injection, MCP and closure queries", () => {
  it("preserves delivery states, exact envelope/tokens/omissions and signed bounded pagination", () => {
    const directory = temporary("audit");
    const database = join(directory, "runtime.sqlite");
    using writer = new SqliteRuntimeAuditStore(database);
    const shadow = seedAttempt(writer, "shadow", "SHADOWED", "2026-08-04T01:00:03.000Z", 2);
    seedAttempt(writer, "injected", "INJECTED", "2026-08-04T01:00:02.000Z");
    seedAttempt(writer, "timeout", "TIMEOUT", "2026-08-04T01:00:01.000Z");
    seedAttempt(writer, "rollback", "ROLLED_BACK", "2026-08-04T01:00:00.000Z");
    seedAttempt(writer, "none", "NO_CONTEXT", "2026-08-04T00:59:59.000Z");
    seedAttempt(writer, "error", "ERROR", "2026-08-04T00:59:58.000Z");
    using reader = new SqliteRuntimeAuditQueryAdapter(database);
    const runtime = new P4ConsoleRuntime({ cursorSecret: secret, audits: reader });

    const first = runtime.listInjections({ schemaVersion: 1, type: "p4.injections.list", sessionId: "session-a", limit: 1 });
    expect(first.items[0]?.status).toBe("SHADOWED");
    expect(first.items[0]?.envelope).toEqual(shadow.envelope);
    expect(first.items[0]?.tokenBudget).toEqual(shadow.envelope.budget);
    expect(first.items[0]?.omittedReasonCodes).toEqual(["TOKEN_BUDGET_APPLIED", "TOKEN_BUDGET_TRUNCATED", "SHADOWED_RESULT"]);
    expect(first.nextCursor).toBeTypeOf("string");
    const second = runtime.listInjections({ schemaVersion: 1, type: "p4.injections.list", sessionId: "session-a", limit: 10, cursor: first.nextCursor });
    expect(second.items.map((item) => item.status)).toEqual(["INJECTED", "TIMEOUT", "ROLLED_BACK", "NO_CONTEXT", "ERROR"]);
    expect(runtime.getInjection({ schemaVersion: 1, type: "p4.injections.get", sessionId: "session-a", attemptId: "attempt-timeout" }).status).toBe("TIMEOUT");

    const forged = `${first.nextCursor!.slice(0, -1)}x`;
    expect(() => runtime.listInjections({ schemaVersion: 1, type: "p4.injections.list", sessionId: "session-a", limit: 1, cursor: forged })).toThrow("cursor signature");
    expect(() => runtime.listInjections({ schemaVersion: 1, type: "p4.injections.list", sessionId: "session-b", limit: 1, cursor: first.nextCursor })).toThrow("Scope");
    expect(() => runtime.getInjection({ schemaVersion: 1, type: "p4.injections.get", sessionId: "session-b", attemptId: "attempt-shadow" })).toThrow("unavailable");
  });

  it("shows metadata-only MCP L1 expansions and enforces their parent session", () => {
    const directory = temporary("mcp");
    const database = join(directory, "runtime.sqlite");
    using writer = new SqliteRuntimeAuditStore(database);
    seedAttempt(writer, "mcp", "INJECTED", now);
    writer.recordMcpExpansion({
      schemaVersion: 1, expansionId: "expansion-a", attemptId: "attempt-mcp", traceId: "trace-mcp",
      tool: "ckl.get", knowledgeId: "knowledge-a", knowledgeVersion: 3,
      fromDetailLevel: "L1_POINTER", toDetailLevel: "L2_COMPACT", latencyMs: 7, used: true, occurredAt: later,
    });
    writer.recordMcpExpansion({
      schemaVersion: 1, expansionId: "expansion-b", attemptId: "attempt-mcp", traceId: "trace-mcp",
      tool: "ckl.get", knowledgeId: "knowledge-a", knowledgeVersion: 3,
      fromDetailLevel: "L2_COMPACT", toDetailLevel: "L3_EVIDENCED", latencyMs: 9, used: false, occurredAt: "2026-08-04T01:00:02.000Z",
    });
    using reader = new SqliteRuntimeAuditQueryAdapter(database);
    const runtime = new P4ConsoleRuntime({ cursorSecret: secret, audits: reader });
    const page = runtime.listMcpExpansions({
      schemaVersion: 1, type: "p4.mcp-expansions.list", sessionId: "session-a", attemptId: "attempt-mcp", limit: 1,
    });
    expect(page.items).toEqual([expect.objectContaining({ knowledgeVersion: 3, latencyMs: 7, used: true })]);
    expect(page.nextCursor).toBeTypeOf("string");
    expect(runtime.listMcpExpansions({
      schemaVersion: 1, type: "p4.mcp-expansions.list", sessionId: "session-a", attemptId: "attempt-mcp", limit: 1, cursor: page.nextCursor,
    }).items[0]).toMatchObject({ expansionId: "expansion-b", toDetailLevel: "L3_EVIDENCED", used: false });
    expect(reader.listMcpExpansions("session-a", "attempt-missing", 10)).toEqual({ items: [], hasMore: false });
    expect(JSON.stringify(page)).not.toContain("Bounded console runtime");
    expect(() => runtime.listMcpExpansions({
      schemaVersion: 1, type: "p4.mcp-expansions.list", sessionId: "session-b", attemptId: "attempt-mcp", limit: 20,
    })).toThrow("unavailable");
  });

  it("replays complete closure evidence without crossing session boundaries", () => {
    const directory = temporary("closure");
    const database = join(directory, "runtime.sqlite");
    using writer = new SqliteRuntimeAuditStore(database);
    const closure = writer.recordClosure({
      schemaVersion: 1, closureRunId: "closure-a", sessionId: "session-a", turnId: "turn-a",
      taskContract: { contractId: "contract-a", objective: "Verify all gates.", gates: ["gate-a"], boundaries: ["boundary-a"] },
      gates: [{ gateId: "gate-a", status: "UNSATISFIED", reasonCodes: ["EVIDENCE_MISSING"], evidenceRefs: ["evidence-a"] }],
      decision: "RETRY_WITH_CORRECTION", correctionDelta: "Add the missing test.", continuationCount: 1,
      recursiveStopRejected: true, interaction: { required: true, question: "Use the safe fix?", safeDefault: "Do not widen scope." }, createdAt: now,
    });
    writer.recordClosure({ ...closure, closureRunId: "closure-b", createdAt: "2026-08-04T00:59:00.000Z" });
    using reader = new SqliteRuntimeAuditQueryAdapter(database);
    const runtime = new P4ConsoleRuntime({ cursorSecret: secret, audits: reader });
    const first = runtime.listClosures({ schemaVersion: 1, type: "p4.closures.list", sessionId: "session-a", limit: 1 });
    expect(first.items).toEqual([closure]);
    expect(runtime.listClosures({ schemaVersion: 1, type: "p4.closures.list", sessionId: "session-a", limit: 1, cursor: first.nextCursor }).items[0]?.closureRunId).toBe("closure-b");
    expect(runtime.getClosure({ schemaVersion: 1, type: "p4.closures.get", sessionId: "session-a", closureRunId: "closure-a" })).toEqual(closure);
    expect(() => runtime.getClosure({ schemaVersion: 1, type: "p4.closures.get", sessionId: "session-b", closureRunId: "closure-a" })).toThrow("unavailable");
  });

  it("rejects unknown fields and corrupt persisted payloads through strict schemas", () => {
    expect(() => contextEnvelopeSchema.parse({ ...envelope("run-a"), injected: true })).toThrow();
    const runtime = new P4ConsoleRuntime({ cursorSecret: secret });
    expect(() => runtime.listInjections({ schemaVersion: 1, type: "p4.injections.list", sessionId: "session-a", limit: 1, unknown: true })).toThrow();
    expect(mapP4ConsoleError(new Error("secret backend failure"))).toEqual({ schemaVersion: 1, code: "INTERNAL", message: "P4 console operation failed", retryable: false });
  });
});

describe("P4 feedback eligibility and idempotency", () => {
  it("calls the active eligibility gate and never lets positive feedback revive suppressed knowledge", async () => {
    const directory = temporary("feedback");
    const store = new SqliteFeedbackStore(join(directory, "feedback.sqlite"));
    let suppressed = false;
    const inspect = vi.fn(({ version }: { readonly version?: number }) => ({
      exists: true, currentVersion: 3, current: version === 3, scopeMatched: true, statusEligible: true, suppressed,
    }));
    const feedback = new KnowledgeFeedbackRuntime({ store, eligibility: { inspect } });
    using operations = new SqliteP4OperationStore(join(directory, "operations.sqlite"));
    const runtime = new P4ConsoleRuntime({ cursorSecret: secret, feedback, operations, now: () => new Date(now) });
    const relevant = {
      schemaVersion: 1, type: "p4.feedback.record", idempotencyKey: "feedback-relevant-a", occurredAt: now,
      action: "RELEVANT", assetId: "knowledge-a", expectedKnowledgeVersion: 3,
      scopeKey: "project:project-a", traceId: "trace-a", actor: "operator-a",
    } as const;
    await expect(runtime.recordFeedback(relevant)).resolves.toEqual({ outcome: "RECORDED", eligibleAfterWrite: true });
    await expect(runtime.recordFeedback(relevant)).resolves.toEqual({ outcome: "RECORDED", eligibleAfterWrite: true });
    expect(inspect).toHaveBeenCalledTimes(1);
    await expect(runtime.recordFeedback({ ...relevant, idempotencyKey: "feedback-stale-a", expectedKnowledgeVersion: 2 })).rejects.toThrow("stale");
    suppressed = true;
    await expect(runtime.recordFeedback({ ...relevant, idempotencyKey: "feedback-pin-a", action: "PIN" })).rejects.toThrow("positive feedback");
    await expect(runtime.recordFeedback({ ...relevant, idempotencyKey: "feedback-suppress-a", action: "SUPPRESS" })).resolves.toEqual({ outcome: "RECORDED", eligibleAfterWrite: false });
    await expect(runtime.recordFeedback({ ...relevant, action: "IRRELEVANT" })).rejects.toThrow("semantic conflict");
    store.close();
  });

  it("records MCP use through the same current-version and Scope gate", async () => {
    const directory = temporary("mcp-feedback");
    const store = new SqliteFeedbackStore(join(directory, "feedback.sqlite"));
    store.recordExpansion({ expansionId: "expansion-a", assetId: "knowledge-a", scopeKey: "project:project-a", traceId: "trace-a", occurredAt: now });
    const feedback = new KnowledgeFeedbackRuntime({
      store,
      eligibility: { inspect: ({ version }) => ({ exists: true, currentVersion: 3, current: version === 3, scopeMatched: true, statusEligible: true, suppressed: false }) },
    });
    const runtime = new P4ConsoleRuntime({ cursorSecret: secret, feedback });
    const request = {
      schemaVersion: 1, type: "p4.feedback.record", idempotencyKey: "usage-a", occurredAt: later,
      action: "MCP_USE", expansionId: "expansion-a", assetId: "knowledge-a", expectedKnowledgeVersion: 3,
      scopeKey: "project:project-a", traceId: "trace-a",
    } as const;
    await expect(runtime.recordFeedback(request)).resolves.toEqual({ outcome: "RECORDED", eligibleAfterWrite: true });
    await expect(runtime.recordFeedback(request)).resolves.toEqual({ outcome: "EXISTING", eligibleAfterWrite: true });
    store.close();
  });
});

function goldenReport(configFingerprint: string): GoldenDatasetReport {
  return {
    schemaVersion: 1, datasetId: "shadow-dataset", datasetVersion: 1, configFingerprint, k: 5,
    totals: { cases: 1, errors: 0, relevant: 1, returned: 1, hits: 1, forbiddenHits: 0 },
    metrics: { recallAtK: 1, precisionAtK: 1, traceabilityRate: 1, scopeLeakCount: 0 },
    thresholds: { recallAtK: 0.9, precisionAtK: 0.8 },
    complexity: {
      levelCounts: { L0_NONE: 0, L1_POINTER: 1, L2_COMPACT: 0, L3_EVIDENCED: 0, L4_EPISODE: 0 },
      averageTokens: 10, p95Tokens: 10, maximumTokens: 10, truncatedCount: 0, overBudgetCount: 0,
      automaticL4Count: 0, missingReasonAxisCount: 0,
    },
    qualityThresholdsMet: true, defaultInjectionAllowed: true, gatePassed: true,
    cases: [{ caseId: "case-a", status: "PASS", traceId: "trace-a", retrievedAssetIds: ["knowledge-a"], relevantHits: ["knowledge-a"], missingRelevantAssetIds: [], forbiddenHits: [] }],
  };
}

function activeRollout(): ActiveRolloutService {
  const configuration = { maxTokens: 800 };
  const configFingerprint = fingerprintRetrievalConfiguration(configuration);
  const evidence = evaluateShadowQuality({
    report: goldenReport(configFingerprint),
    traces: [{ traceId: "trace-a", runId: "run-a", observedAt: now, source: "PERSISTED_SHADOW_TRACE", delivery: "SHADOWED", projectId: "project-a", eligibleKnowledgeVersions: ["knowledge-a@3"] }],
    retrievalConfiguration: configuration,
    componentVersions: { injection: "1.0.0" },
    now,
  });
  const service = new ActiveRolloutService(new MemoryRolloutStateStore(), {
    policyRevision: 1, configFingerprint: evidence.configFingerprint, versionFingerprint: evidence.versionFingerprint, now,
  });
  service.recordEvidence(evidence);
  service.activateCanary({
    expectedStateRevision: service.state.stateRevision, targetPolicyRevision: 2,
    configFingerprint: evidence.configFingerprint, versionFingerprint: evidence.versionFingerprint,
    eligibilityEvidenceId: evidence.evidenceId, canary: { projectIds: ["project-a"], allocationSalt: "canary-a" }, now: later,
  });
  service.downgrade("QUALITY_GATE_FAILED", "2026-08-04T01:00:02.000Z");
  return service;
}

describe("P4 rollout and high-risk governance", () => {
  it("shows canary evidence, downgrade and last-known-good rollback revision", () => {
    const rollout = activeRollout();
    const runtime = new P4ConsoleRuntime({ cursorSecret: secret, rollout });
    const view = runtime.rollout();
    expect(view.state.stateRevision).toBe(4);
    expect(view.downgradeHistory).toEqual([expect.objectContaining({ kind: "DOWNGRADED", stateRevision: 4 })]);
    expect(view.rollbackTarget.mode).toBe("SHADOW");
    expect(view.state.evidence).toHaveLength(1);
  });

  it("keeps high-risk production commands disabled by default", async () => {
    const port = { preview: vi.fn(), execute: vi.fn() };
    const highRiskStore = new MemoryHighRiskGovernanceStateStore();
    const highRiskService = new HighRiskGovernanceService(port, highRiskStore, { hasPermission: () => true }, {
      revision: 1, activeStageEnabled: true,
      enabledOperations: { GLOBAL_PROMOTION: true, RULE_CHANGE: false, BINDING_CHANGE: false, PRIVACY_PURGE: false }, previewTtlMs: 60_000,
    });
    const runtime = new P4ConsoleRuntime({ cursorSecret: secret, highRisk: consoleHighRisk(highRiskService, highRiskStore), principal: { actorId: "operator-a" } });
    expect(runtime.capabilities().find((item) => item.capability === "HIGH_RISK_GOVERNANCE")).toMatchObject({ state: "DISABLED", reasonCode: "HIGH_RISK_PRODUCTION_DEFAULT_DISABLED" });
    await expect(runtime.previewHighRisk({
      schemaVersion: 1, type: "p4.high-risk.preview", idempotencyKey: "preview-a", occurredAt: now, expectedPolicyRevision: 1,
      command: { kind: "GLOBAL_PROMOTION", assetIds: ["knowledge-a"], projectIds: ["project-a"], reason: "Promote reviewed knowledge", payloadFingerprint: `sha256:${"a".repeat(64)}` },
    })).rejects.toThrow("disabled by production default");
    expect(port.preview).not.toHaveBeenCalled();
  });

  it("requires strict, expected-revision, actor-bound preview/commit and replays idempotently", async () => {
    const directory = temporary("high-risk");
    const blast: BlastRadius = {
      affectedAssets: 1, affectedProjects: 1, affectedRules: 0, affectedBindings: 0,
      affectedTraces: 3, affectedInjections: 2, irreversible: false, reasonCodes: ["PROJECT_TO_GLOBAL"],
    };
    const execute = vi.fn(async (_command: HighRiskGovernanceCommand, identity: HighRiskExecutionIdentity) => ({
      operationId: identity.operationId, requestFingerprint: identity.requestFingerprint, outcome: "COMMITTED" as const, committedAt: later,
    }));
    const highRiskStore = new MemoryHighRiskGovernanceStateStore();
    const highRiskService = new HighRiskGovernanceService({ preview: () => blast, execute }, highRiskStore, { hasPermission: () => true }, {
      revision: 7, activeStageEnabled: true,
      enabledOperations: { GLOBAL_PROMOTION: true, RULE_CHANGE: false, BINDING_CHANGE: false, PRIVACY_PURGE: false }, previewTtlMs: 60_000,
    });
    using operations = new SqliteP4OperationStore(join(directory, "operations.sqlite"));
    const runtime = new P4ConsoleRuntime({
      cursorSecret: secret, highRisk: consoleHighRisk(highRiskService, highRiskStore), allowHighRiskCommands: true, operations,
      principal: () => ({ actorId: "operator-a" }), now: () => new Date(now),
    });
    const previewRequest = {
      schemaVersion: 1, type: "p4.high-risk.preview", idempotencyKey: "preview-global-a", occurredAt: now, expectedPolicyRevision: 7,
      command: { kind: "GLOBAL_PROMOTION", assetIds: ["knowledge-a"], projectIds: ["project-a"], reason: "Promote reviewed knowledge", payloadFingerprint: `sha256:${"a".repeat(64)}` },
    } as const;
    const first = await runtime.previewHighRisk(previewRequest);
    expect((await runtime.previewHighRisk(previewRequest)).preview.previewId).toBe(first.preview.previewId);
    expect(first.confirmationPhrase).toMatch(/^CONFIRM GLOBAL_PROMOTION [a-f0-9]{16}$/u);
    expect(first).not.toHaveProperty("confirmationFingerprint");
    await expect(runtime.previewHighRisk({ ...previewRequest, idempotencyKey: "preview-stale", expectedPolicyRevision: 6 })).rejects.toThrow("stale");
    await expect(runtime.commitHighRisk({
      schemaVersion: 1, type: "p4.high-risk.commit", idempotencyKey: "commit-forged", occurredAt: later, expectedPolicyRevision: 7,
      previewId: first.preview.previewId,
      preview: { ...first.preview, blastRadius: { ...first.preview.blastRadius, affectedAssets: 2 } },
      confirmationPhrase: first.confirmationPhrase,
    })).rejects.toThrow();
    await expect(runtime.commitHighRisk({
      schemaVersion: 1, type: "p4.high-risk.commit", idempotencyKey: "commit-unknown", occurredAt: later, expectedPolicyRevision: 7,
      previewId: `sha256:${"f".repeat(64)}`, confirmationPhrase: first.confirmationPhrase,
    })).rejects.toThrow("unavailable");
    const commitRequest = {
      schemaVersion: 1, type: "p4.high-risk.commit", idempotencyKey: "commit-global-a", occurredAt: later, expectedPolicyRevision: 7,
      previewId: first.preview.previewId, confirmationPhrase: first.confirmationPhrase,
    } as const;
    await expect(runtime.commitHighRisk({ ...commitRequest, idempotencyKey: "commit-wrong-phrase", confirmationPhrase: "CONFIRM GLOBAL_PROMOTION deadbeefdeadbeef" })).rejects.toThrow("phrase");
    await expect(runtime.commitHighRisk({
      ...commitRequest,
      idempotencyKey: "commit-client-bypass",
      actor: "attacker",
      confirmationFingerprint: `sha256:${"f".repeat(64)}`,
    })).rejects.toThrow();
    const committed = await runtime.commitHighRisk(commitRequest);
    expect((await runtime.commitHighRisk(commitRequest)).result.operationId).toBe(committed.result.operationId);
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(runtime.commitHighRisk({ ...commitRequest, confirmationPhrase: "CONFIRM GLOBAL_PROMOTION deadbeefdeadbeef" })).rejects.toThrow("phrase");
  });

  it("derives every capability from the composed runtime and actual policy", () => {
    const empty = new P4ConsoleRuntime({ cursorSecret: secret });
    expect(empty.capabilities().every((item) => item.state !== "READY")).toBe(true);
    expect(() => empty.rollout()).toThrow(P4ConsoleError);
    expect(mapP4ConsoleError(new P4ConsoleError("TIMEOUT", "deadline", true))).toEqual({ schemaVersion: 1, code: "TIMEOUT", message: "deadline", retryable: true });
  });
});
