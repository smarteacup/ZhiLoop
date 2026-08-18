import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActiveRolloutService, MemoryRolloutStateStore } from "@zhiloop/active-rollout-service";
import { KnowledgeFeedbackRuntime } from "@zhiloop/active-knowledge-runtime";
import type { ContextEnvelope } from "@zhiloop/domain";
import { SqliteFeedbackStore } from "@zhiloop/feedback-engine";
import { SqliteRuntimeAuditStore } from "@zhiloop/runtime-audit-store";
import { SqliteRuntimeAuditQueryAdapter } from "@zhiloop/p4-console-runtime";
import { afterEach, describe, expect, it } from "vitest";

import { P4SidecarConsole, parseP4ConsoleRequest } from "./p4-console.js";

const now = "2026-08-04T00:00:00.000Z";
const directories: string[] = [];
afterEach(async () => await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true }))));

function envelope(): ContextEnvelope {
  return {
    schemaVersion: 1, runId: "run-p4", projectId: "project-p4", taskId: "turn-p4",
    complexity: { level: "L1_POINTER", breadth: 0, depth: "POINTER", authority: "NONE", evidence: "NONE", reasonCodes: ["SHADOW"] },
    budget: { maxTokens: 100, estimatedTokens: 20, truncated: false, disclosedItems: 1, omittedItems: 0 },
    items: [{
      id: "knowledge-p4", version: 1, subjectKey: "p4.delivery", kind: "IMPLEMENTATION", status: "VERIFIED",
      scope: { level: "PROJECT", projectId: "project-p4" }, authority: "VERIFIED_FACT", detailLevel: "L1_POINTER",
      title: "P4 delivery", summary: "Delivery is acknowledged only after Hook output is accepted.", retrievalRank: 1,
    }],
  };
}

async function resources() {
  const stateDirectory = await mkdtemp(join(tmpdir(), "zhiloop-p4-console-sidecar-"));
  directories.push(stateDirectory);
  const writer = new SqliteRuntimeAuditStore(join(stateDirectory, "p4-runtime-audit.sqlite"));
  writer.beginInjection({
    schemaVersion: 1, attemptId: "attempt-p4", sessionId: "session-p4", turnId: "turn-p4",
    traceId: "trace-p4", runId: "run-p4", rolloutRevision: 1, status: "PENDING", revision: 0,
    envelope: envelope(), reasonCode: "DELIVERY_PENDING", createdAt: now,
  });
  writer.completeInjection("attempt-p4", 0, "INJECTED", "HOOK_CONTEXT_GENERATED", now);
  writer.acknowledgeInjectionDelivery("attempt-p4", 1, "hook-client:receipt-p4", now);
  writer.recordMcpExpansion({
    schemaVersion: 1, expansionId: "expansion-p4", attemptId: "attempt-p4", traceId: "trace-p4",
    tool: "ckl.get", knowledgeId: "knowledge-p4", knowledgeVersion: 1,
    fromDetailLevel: "L1_POINTER", toDetailLevel: "L2_COMPACT", latencyMs: 2, used: true, occurredAt: now,
  });
  writer.recordClosure({
    schemaVersion: 1, closureRunId: "closure-p4", sessionId: "session-p4", turnId: "turn-p4",
    taskContract: { contractId: "contract-p4", objective: "finish", gates: [], boundaries: [] },
    gates: [], decision: "PASS", continuationCount: 0, recursiveStopRejected: false, createdAt: now,
  });
  writer.close();
  const feedbackStore = new SqliteFeedbackStore(join(stateDirectory, "feedback.sqlite"));
  const feedback = new KnowledgeFeedbackRuntime({
    store: feedbackStore,
    eligibility: { inspect: () => ({ exists: true, currentVersion: 1, current: true, scopeMatched: true, statusEligible: true, suppressed: false }) },
  });
  const rollout = new ActiveRolloutService(new MemoryRolloutStateStore(), {
    policyRevision: 1, configFingerprint: `sha256:${"a".repeat(64)}`, versionFingerprint: `sha256:${"b".repeat(64)}`, now,
  });
  let refreshCalls = 0;
  return {
    stateDirectory,
    feedbackStore,
    feedback,
    rollout,
    refreshContext: (sessionId: string) => { refreshCalls += 1; return sessionId === "session-p4" ? 2 : 0; },
    refreshCalls: () => refreshCalls,
    inspectEligibility: async () => ({
      exists: true, currentVersion: 1, current: true, scopeMatched: true, statusEligible: true, suppressed: false,
    }),
  };
}

describe("P4SidecarConsole", () => {
  it("parses every supported transport shape and rejects malformed or unknown input", () => {
    const fingerprint = `sha256:${"a".repeat(64)}`;
    const requests = [
      { schemaVersion: 1, requestId: "r1", type: "p4.injections.list", sessionId: "session-p4", limit: 10 },
      { schemaVersion: 1, requestId: "r2", type: "p4.injections.get", sessionId: "session-p4", attemptId: "attempt-p4" },
      { schemaVersion: 1, requestId: "r3", type: "p4.mcp-expansions.list", sessionId: "session-p4", attemptId: "attempt-p4", limit: 10 },
      { schemaVersion: 1, requestId: "r4", type: "p4.closures.list", sessionId: "session-p4", limit: 10 },
      { schemaVersion: 1, requestId: "r5", type: "p4.closures.get", sessionId: "session-p4", closureRunId: "closure-p4" },
      { schemaVersion: 1, requestId: "r6", type: "p4.rollout.get" },
      { schemaVersion: 1, requestId: "r7", type: "p4.feedback-targets.list", sessionId: "session-p4" },
      { schemaVersion: 1, requestId: "r8", type: "p4.high-risk.governance" },
      { schemaVersion: 1, requestId: "r9", type: "p4.feedback.record", idempotencyKey: "feedback-1", occurredAt: now, action: "PIN", assetId: "knowledge-p4", expectedKnowledgeVersion: 1, scopeKey: "PROJECT:project-p4", traceId: "trace-p4", actor: "local-console" },
      { schemaVersion: 1, requestId: "r10", type: "p4.high-risk.preview", idempotencyKey: "preview-1", occurredAt: now, expectedPolicyRevision: 1, command: { kind: "GLOBAL_PROMOTION", assetIds: ["knowledge-p4"], projectIds: ["project-p4"], reason: "reviewed", payloadFingerprint: fingerprint } },
      { schemaVersion: 1, requestId: "r11", type: "p4.high-risk.commit", idempotencyKey: "commit-1", occurredAt: now, expectedPolicyRevision: 1, previewId: fingerprint, confirmationPhrase: "CONFIRM GLOBAL_PROMOTION aaaaaaaaaaaaaaaa" },
      { schemaVersion: 1, requestId: "r12", type: "p4.context.refresh", sessionId: "session-p4", idempotencyKey: "refresh-1" },
    ];
    for (const request of requests) expect(parseP4ConsoleRequest(request)).toMatchObject({ requestId: request.requestId, type: request.type });
    for (const invalid of [null, [], {}, { schemaVersion: 1, requestId: "bad id", type: "p4.capabilities" }, { schemaVersion: 1, requestId: "r", type: "unknown" }, { schemaVersion: 2, requestId: "r", type: "p4.rollout.get" }, { schemaVersion: 1, requestId: "r", type: "p4.feedback-targets.list", sessionId: "bad id" }, { schemaVersion: 1, requestId: "r", type: "p4.high-risk.governance", forged: true }]) {
      expect(() => parseP4ConsoleRequest(invalid)).toThrow("invalid P4 Console request");
    }
  });

  it("strictly parses transport requests and exposes only composed capability facts", async () => {
    expect(parseP4ConsoleRequest({ schemaVersion: 1, requestId: "request-p4", type: "p4.capabilities" })).toEqual({
      schemaVersion: 1, requestId: "request-p4", type: "p4.capabilities",
    });
    expect(() => parseP4ConsoleRequest({ schemaVersion: 1, requestId: "request-p4", type: "p4.capabilities", forged: true })).toThrow();
    const values = await resources();
    const console = await P4SidecarConsole.create(values);
    const response = await console.handle(parseP4ConsoleRequest({ schemaVersion: 1, requestId: "request-capabilities", type: "p4.capabilities" }));
    expect(response).toMatchObject({ ok: true, result: expect.arrayContaining([
      expect.objectContaining({ capability: "INJECTION_AUDIT", state: "READY" }),
      expect.objectContaining({ capability: "HIGH_RISK_GOVERNANCE", state: "NOT_CONFIGURED" }),
    ]) });
    await expect(console.handle(parseP4ConsoleRequest({
      schemaVersion: 1, requestId: "request-feedback-targets", type: "p4.feedback-targets.list", sessionId: "session-p4",
    }))).resolves.toMatchObject({
      ok: true,
      result: { items: [{ knowledgeId: "knowledge-p4", eligible: true, actions: { PIN: { enabled: true, expectedRevision: 1 } } }] },
    });
    await expect(console.handle(parseP4ConsoleRequest({
      schemaVersion: 1, requestId: "request-high-risk-facts", type: "p4.high-risk.governance",
    }))).resolves.toMatchObject({
      ok: true,
      result: { activeStageEnabled: false, actions: { GLOBAL_PROMOTION: { enabled: false, capabilityStatus: "NOT_CONFIGURED" } } },
    });
    await expect(console.handle(parseP4ConsoleRequest({
      schemaVersion: 1,
      requestId: "request-feedback-record",
      type: "p4.feedback.record",
      idempotencyKey: "feedback:PIN:knowledge-p4:1",
      occurredAt: now,
      action: "PIN",
      assetId: "knowledge-p4",
      expectedKnowledgeVersion: 1,
      scopeKey: JSON.stringify({ level: "TASK", projectId: "project-p4", taskId: "turn-p4" }),
      traceId: "trace-p4",
      actor: "local-console",
    }))).resolves.toMatchObject({ ok: true, result: { outcome: "RECORDED", eligibleAfterWrite: true } });
    await expect(console.handle(parseP4ConsoleRequest({
      schemaVersion: 1, requestId: "request-context-refresh", type: "p4.context.refresh",
      sessionId: "session-p4", idempotencyKey: "refresh-1",
    }))).resolves.toMatchObject({ ok: true, result: { sessionId: "session-p4", removedEntries: 2, reasonCode: "SESSION_CONTEXT_REFRESHED" } });
    await expect(console.handle(parseP4ConsoleRequest({
      schemaVersion: 1, requestId: "request-context-refresh-replay", type: "p4.context.refresh",
      sessionId: "session-p4", idempotencyKey: "refresh-1",
    }))).resolves.toMatchObject({ ok: true, result: { removedEntries: 2 } });
    expect(values.refreshCalls()).toBe(1);
    await expect(console.handle(parseP4ConsoleRequest({
      schemaVersion: 1, requestId: "request-context-refresh-conflict", type: "p4.context.refresh",
      sessionId: "session-other", idempotencyKey: "refresh-1",
    }))).resolves.toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    console.close(); values.feedbackStore.close();
  });

  it("returns acknowledged delivery facts after restart without accepting browser high-risk claims", async () => {
    const values = await resources();
    using auditReader = new SqliteRuntimeAuditQueryAdapter(join(values.stateDirectory, "p4-runtime-audit.sqlite"));
    expect(auditReader.listInjections("session-p4", 10).items).toHaveLength(1);
    let console = await P4SidecarConsole.create(values);
    const request = parseP4ConsoleRequest({
      schemaVersion: 1, requestId: "request-injections", type: "p4.injections.list", sessionId: "session-p4", limit: 10,
    });
    await expect(console.handle(request)).resolves.toMatchObject({ ok: true, result: { items: [{
      status: "INJECTED", revision: 2, deliveryEvidenceRef: "hook-client:receipt-p4", deliveredAt: now,
    }] } });
    console.close();
    console = await P4SidecarConsole.create(values);
    await expect(console.handle(request)).resolves.toMatchObject({ ok: true, result: { items: [{ attemptId: "attempt-p4" }] } });
    const disabled = await console.handle(parseP4ConsoleRequest({
      schemaVersion: 1, requestId: "request-preview", type: "p4.high-risk.preview", idempotencyKey: "preview-p4",
      occurredAt: now, expectedPolicyRevision: 1,
      command: { kind: "GLOBAL_PROMOTION", assetIds: ["knowledge-p4"], projectIds: ["project-p4"], reason: "Reviewed promotion", payloadFingerprint: `sha256:${"c".repeat(64)}` },
    }));
    expect(disabled).toMatchObject({ ok: false, error: { code: "CAPABILITY_UNAVAILABLE" } });
    await expect(console.handle(parseP4ConsoleRequest({
      schemaVersion: 1, requestId: "request-commit", type: "p4.high-risk.commit", idempotencyKey: "commit-p4",
      occurredAt: now, expectedPolicyRevision: 1, previewId: `sha256:${"a".repeat(64)}`,
      confirmationPhrase: "CONFIRM GLOBAL_PROMOTION aaaaaaaaaaaaaaaa",
    }))).resolves.toMatchObject({ ok: false, error: { code: "CAPABILITY_UNAVAILABLE" } });
    console.close(); values.feedbackStore.close();
  });

  it("serves every persisted audit view and maps not-found and closed-state failures safely", async () => {
    const values = await resources();
    const console = await P4SidecarConsole.create(values);
    const cases = [
      [{ schemaVersion: 1, requestId: "audit-injection", type: "p4.injections.get", sessionId: "session-p4", attemptId: "attempt-p4" }, { attemptId: "attempt-p4" }],
      [{ schemaVersion: 1, requestId: "audit-mcp", type: "p4.mcp-expansions.list", sessionId: "session-p4", attemptId: "attempt-p4", limit: 10 }, { items: [{ expansionId: "expansion-p4", used: true }] }],
      [{ schemaVersion: 1, requestId: "audit-closures", type: "p4.closures.list", sessionId: "session-p4", limit: 10 }, { items: [{ closureRunId: "closure-p4" }] }],
      [{ schemaVersion: 1, requestId: "audit-closure", type: "p4.closures.get", sessionId: "session-p4", closureRunId: "closure-p4" }, { closureRunId: "closure-p4", decision: "PASS" }],
      [{ schemaVersion: 1, requestId: "audit-rollout", type: "p4.rollout.get" }, { state: { effective: { mode: "SHADOW" } } }],
    ] as const;
    for (const [request, expected] of cases) await expect(console.handle(parseP4ConsoleRequest(request))).resolves.toMatchObject({ ok: true, result: expected });
    await expect(console.handle(parseP4ConsoleRequest({ schemaVersion: 1, requestId: "missing", type: "p4.injections.get", sessionId: "session-p4", attemptId: "missing" }))).resolves.toMatchObject({ ok: false, error: { code: "NOT_FOUND", retryable: false } });
    console.close();
    console.close();
    await expect(console.handle(parseP4ConsoleRequest({ schemaVersion: 1, requestId: "closed", type: "p4.capabilities" }))).resolves.toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    values.feedbackStore.close();
  });

  it("reports stale, out-of-scope and suppressed feedback targets without enabling unsafe actions", async () => {
    const values = await resources();
    const console = await P4SidecarConsole.create({
      ...values,
      inspectEligibility: async () => ({ exists: false, currentVersion: 2, current: false, scopeMatched: false, statusEligible: false, suppressed: true }),
    });
    await expect(console.handle(parseP4ConsoleRequest({ schemaVersion: 1, requestId: "stale-target", type: "p4.feedback-targets.list", sessionId: "session-p4" }))).resolves.toMatchObject({
      ok: true,
      result: { items: [{ eligible: false, mcpUsed: true, eligibilityReasonCodes: ["KNOWLEDGE_NOT_FOUND", "KNOWLEDGE_VERSION_STALE", "KNOWLEDGE_SCOPE_MISMATCH", "KNOWLEDGE_STATUS_INELIGIBLE", "KNOWLEDGE_SUPPRESSED"], actions: { PIN: { enabled: false, capabilityStatus: "DISABLED" }, SUPPRESS: { enabled: false } } }] },
    });
    const aborted = new AbortController(); aborted.abort(new Error("cancelled"));
    await expect(console.handle(parseP4ConsoleRequest({ schemaVersion: 1, requestId: "aborted-target", type: "p4.feedback-targets.list", sessionId: "session-p4" }), aborted.signal)).resolves.toMatchObject({ ok: false });
    console.close(); values.feedbackStore.close();
  });

  it("rejects an unsafe persisted cursor secret before opening the Console", async () => {
    const values = await resources();
    await writeFile(join(values.stateDirectory, "p4-console-cursor.secret"), "short", { mode: 0o600 });
    await expect(P4SidecarConsole.create(values)).rejects.toThrow("cursor secret file is unsafe");
    values.feedbackStore.close();
  });
});
