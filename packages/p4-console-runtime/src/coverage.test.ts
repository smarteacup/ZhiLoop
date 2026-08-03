import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { HighRiskGovernanceService, MemoryHighRiskGovernanceStateStore } from "@zhiloop/active-rollout-service";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  P4AuditStoreError,
  P4ConsoleRuntime,
  P4OperationConflictError,
  SqliteP4OperationStore,
  SqliteRuntimeAuditQueryAdapter,
  closureRunSchema,
  contextEnvelopeSchema,
  feedbackCommandSchema,
  highRiskCommitRequestSchema,
  injectionAttemptSchema,
  mapP4ConsoleError,
  mcpExpansionSchema,
  type RuntimeAuditQueryPort,
} from "./index.js";

const now = "2026-08-04T01:00:00.000Z";
const secret = "another-p4-cursor-secret-at-least-32-bytes";
const hash = `sha256:${"a".repeat(64)}`;

function baseEnvelope() {
  return {
    schemaVersion: 1 as const, runId: "run-a",
    complexity: { level: "L0_NONE" as const, breadth: 0, depth: "NONE" as const, authority: "NONE" as const, evidence: "NONE" as const, reasonCodes: ["NO_CONTEXT"] },
    budget: { maxTokens: 0, estimatedTokens: 0, truncated: false, disclosedItems: 0, omittedItems: 0 },
    items: [],
  };
}

function emptyAudits(): RuntimeAuditQueryPort {
  return {
    listInjections: () => ({ items: [], hasMore: false }),
    getInjection: () => undefined,
    listMcpExpansions: () => ({ items: [], hasMore: false }),
    listClosures: () => ({ items: [], hasMore: false }),
    getClosure: () => undefined,
  };
}

function policy(activeStageEnabled: boolean, enabled = false) {
  return {
    revision: 1,
    activeStageEnabled,
    enabledOperations: { GLOBAL_PROMOTION: enabled, RULE_CHANGE: false, BINDING_CHANGE: false, PRIVACY_PURGE: false },
    previewTtlMs: 60_000,
  };
}

function highRisk(activeStageEnabled: boolean, enabled = false) {
  const store = new MemoryHighRiskGovernanceStateStore();
  const service = new HighRiskGovernanceService(
    {
      preview: () => ({ affectedAssets: 1, affectedProjects: 1, affectedRules: 0, affectedBindings: 0, affectedTraces: 0, affectedInjections: 0, irreversible: false, reasonCodes: ["SAFE_PREVIEW"] }),
      execute: (_command, identity) => ({ operationId: identity.operationId, requestFingerprint: identity.requestFingerprint, outcome: "COMMITTED", committedAt: now }),
    },
    store,
    { hasPermission: () => true },
    policy(activeStageEnabled, enabled),
  );
  return {
    get policy() { return service.policy; },
    preview: service.preview.bind(service),
    getPreview: store.getPreview.bind(store),
    commit: service.commit.bind(service),
  };
}

describe("strict P4 contracts", () => {
  it("accepts every bounded Scope variant and all optional exact-envelope fields", () => {
    const scopes = [
      { level: "TASK", taskId: "task-a", projectId: "project-a", repositoryRemote: "git@example/repo" },
      { level: "SYMBOL", projectId: "project-a", repositoryRemote: "git@example/repo", symbols: ["A.b"] },
      { level: "MODULE", projectId: "project-a", repositoryRemote: "git@example/repo", modulePaths: ["src/a"] },
      { level: "PROJECT", projectId: "project-a", repositoryRemote: "git@example/repo" },
      { level: "USER", userId: "user-a" },
      { level: "TEAM", teamId: "team-a" },
      { level: "GLOBAL" },
    ];
    for (const [index, scope] of scopes.entries()) {
      const parsed = contextEnvelopeSchema.parse({
        ...baseEnvelope(), projectId: "project-a", taskId: "task-a",
        complexity: { level: "L4_EPISODE", breadth: 1, depth: "EPISODE", authority: "MIXED", evidence: "EPISODE", reasonCodes: ["FULL_CONTEXT"] },
        budget: { maxTokens: 100, estimatedTokens: 99, truncated: true, disclosedItems: 1, omittedItems: 1 },
        items: [{
          id: `knowledge-${index}`, version: 1, subjectKey: `subject.${index}`, kind: "FACT", status: "ACCEPTED", scope,
          authority: "REFERENCE", detailLevel: "L4_EPISODE", title: "title", summary: "summary", retrievalRank: 0,
          applicability: ["applies"], failurePaths: ["fails"], symbols: ["A.b"], content: "body",
          evidencePointers: ["evidence-a"], evidenceSummary: [{ evidenceId: "evidence-a", verdict: "INCONCLUSIVE" }], sourceEpisodes: ["episode-a"],
        }],
        taskContract: { contractId: "contract-a", objective: "objective", gates: ["gate-a"], boundaries: ["boundary-a"] },
      });
      expect(parsed.items[0]?.scope.level).toBe(scope.level);
    }
  });

  it("checks terminal/run invariants, MCP transitions, closure optionals and command unions", () => {
    const attempt = {
      schemaVersion: 1, attemptId: "attempt-a", sessionId: "session-a", turnId: "turn-a", traceId: "trace-a", runId: "run-a",
      rolloutRevision: 1, status: "PENDING", revision: 0, envelope: baseEnvelope(), reasonCode: "PENDING", createdAt: now,
    } as const;
    expect(injectionAttemptSchema.parse(attempt).status).toBe("PENDING");
    expect(() => injectionAttemptSchema.parse({ ...attempt, runId: "run-b" })).toThrow("runId mismatch");
    expect(() => injectionAttemptSchema.parse({ ...attempt, completedAt: now })).toThrow("terminal status");
    expect(() => injectionAttemptSchema.parse({ ...attempt, status: "ERROR" })).toThrow("terminal status");
    const expansion = {
      schemaVersion: 1, expansionId: "expansion-a", attemptId: "attempt-a", traceId: "trace-a", tool: "ckl.check",
      knowledgeId: "knowledge-a", knowledgeVersion: 1, fromDetailLevel: "L2_COMPACT", toDetailLevel: "L3_EVIDENCED", latencyMs: 0, used: false, occurredAt: now,
    } as const;
    expect(mcpExpansionSchema.parse(expansion).toDetailLevel).toBe("L3_EVIDENCED");
    expect(() => mcpExpansionSchema.parse({ ...expansion, toDetailLevel: "L2_COMPACT" })).toThrow("invalid detail");
    expect(closureRunSchema.parse({
      schemaVersion: 1, closureRunId: "closure-a", sessionId: "session-a", turnId: "turn-a",
      taskContract: { contractId: "contract-a", objective: "objective", gates: [], boundaries: [] }, gates: [],
      decision: "PASS", continuationCount: 0, recursiveStopRejected: false, createdAt: now,
    }).interaction).toBeUndefined();
    expect(feedbackCommandSchema.parse({
      schemaVersion: 1, type: "p4.feedback.record", idempotencyKey: "usage-a", occurredAt: now,
      action: "MCP_USE", expansionId: "expansion-a", assetId: "knowledge-a", expectedKnowledgeVersion: 1, scopeKey: "project:a", traceId: "trace-a",
    }).action).toBe("MCP_USE");
  });

  it("refuses unprefixed fingerprints and all client-supplied principal proof", () => {
    const preview = {
      previewId: hash, policyRevision: 1, commandFingerprint: hash,
      command: { kind: "GLOBAL_PROMOTION", assetIds: ["knowledge-a"], projectIds: ["project-a"], reason: "promote reviewed item", payloadFingerprint: hash },
      blastRadius: { affectedAssets: 1, affectedProjects: 1, affectedRules: 0, affectedBindings: 0, affectedTraces: 0, affectedInjections: 0, irreversible: false, reasonCodes: ["SAFE_PREVIEW"] },
      createdAt: now, expiresAt: "2026-08-04T01:01:00.000Z",
    };
    const valid = { schemaVersion: 1, type: "p4.high-risk.commit", idempotencyKey: "commit-a", occurredAt: now, expectedPolicyRevision: 1, previewId: preview.previewId, confirmationPhrase: "CONFIRM GLOBAL_PROMOTION aaaaaaaaaaaaaaaa" };
    expect(highRiskCommitRequestSchema.parse(valid).confirmationPhrase).toContain("CONFIRM");
    expect(() => highRiskCommitRequestSchema.parse({ ...valid, previewId: "a".repeat(64) })).toThrow();
    expect(() => highRiskCommitRequestSchema.parse({ ...valid, actor: "attacker", confirmationFingerprint: hash })).toThrow();
  });
});

describe("P4 bounded errors and dependency-derived capabilities", () => {
  it("maps every public error class without leaking backend details", () => {
    const zod = z.strictObject({ value: z.string() }).safeParse({ value: 1 });
    expect(zod.success).toBe(false);
    expect(mapP4ConsoleError(zod.success ? undefined : zod.error).code).toBe("INVALID_REQUEST");
    expect(mapP4ConsoleError(new P4OperationConflictError("secret")).code).toBe("CONFLICT");
    expect(mapP4ConsoleError(new P4AuditStoreError("safe storage failure"))).toMatchObject({ code: "STORAGE_UNAVAILABLE", retryable: true });
    expect(mapP4ConsoleError(new Error("stale revision secret")).code).toBe("CONFLICT");
    expect(mapP4ConsoleError(new Error("consumer disabled secret")).code).toBe("CAPABILITY_DISABLED");
    expect(mapP4ConsoleError(new Error("timed out secret")).code).toBe("TIMEOUT");
    expect(mapP4ConsoleError(17).code).toBe("INTERNAL");
  });

  it("covers actual dependency/policy combinations instead of hard-coding READY", () => {
    const base = { cursorSecret: secret, audits: emptyAudits(), feedback: { record: vi.fn(), recordUsage: vi.fn() }, rollout: { state: {
      schemaVersion: 1 as const, stateRevision: 1, effective: { policyRevision: 1, mode: "SHADOW" as const, configFingerprint: hash, versionFingerprint: hash },
      lastKnownGood: { policyRevision: 1, mode: "SHADOW" as const, configFingerprint: hash, versionFingerprint: hash }, evidence: [],
      audit: [{ eventId: hash, kind: "BOOTSTRAP" as const, stateRevision: 1, effectivePolicyRevision: 1, reasonCodes: ["BOOTSTRAP_SHADOW"], occurredAt: now }],
    } } };
    expect(new P4ConsoleRuntime({ ...base, highRisk: highRisk(false), allowHighRiskCommands: true }).capabilities().at(-1)).toMatchObject({ state: "DISABLED", reasonCode: "ACTIVE_STAGE_DISABLED" });
    expect(new P4ConsoleRuntime({ ...base, highRisk: highRisk(true), allowHighRiskCommands: true }).capabilities().at(-1)).toMatchObject({ state: "DISABLED", reasonCode: "HIGH_RISK_POLICY_GATES_DISABLED" });
    const ready = new P4ConsoleRuntime({ ...base, highRisk: highRisk(true, true), allowHighRiskCommands: true, principal: { actorId: "operator-a" } });
    expect(ready.capabilities().map((item) => item.state)).toEqual(["READY", "READY", "READY", "READY", "READY", "READY"]);
    expect(ready.rollout().activeCanary).toBeUndefined();
  });

  it("fails closed on invalid canary state, absent dependencies and principal", async () => {
    const badRollout = { state: {
      schemaVersion: 1 as const, stateRevision: 1,
      effective: { policyRevision: 1, mode: "ACTIVE" as const, configFingerprint: hash, versionFingerprint: hash, canary: { allocationSalt: "salt-a", percentageBasisPoints: 10_000 } },
      lastKnownGood: { policyRevision: 1, mode: "SHADOW" as const, configFingerprint: hash, versionFingerprint: hash }, evidence: [],
      audit: [{ eventId: hash, kind: "BOOTSTRAP" as const, stateRevision: 1, effectivePolicyRevision: 1, reasonCodes: ["BOOTSTRAP_SHADOW"], occurredAt: now }],
    } };
    expect(() => new P4ConsoleRuntime({ cursorSecret: secret, rollout: badRollout }).rollout()).toThrow("canary");
    expect(() => new P4ConsoleRuntime({ cursorSecret: "short" })).toThrow("32 bytes");
    const empty = new P4ConsoleRuntime({ cursorSecret: secret });
    expect(() => empty.listClosures({ schemaVersion: 1, type: "p4.closures.list", sessionId: "session-a", limit: 1 })).toThrow("not composed");
    await expect(empty.recordFeedback({})).rejects.toThrow();
    const service = highRisk(true, true);
    const withoutPrincipal = new P4ConsoleRuntime({ cursorSecret: secret, highRisk: service, allowHighRiskCommands: true });
    const preview = await withoutPrincipal.previewHighRisk({
      schemaVersion: 1, type: "p4.high-risk.preview", idempotencyKey: "preview-a", occurredAt: now, expectedPolicyRevision: 1,
      command: { kind: "GLOBAL_PROMOTION", assetIds: ["knowledge-a"], projectIds: ["project-a"], reason: "promote reviewed item", payloadFingerprint: hash },
    });
    await expect(withoutPrincipal.commitHighRisk({
      schemaVersion: 1, type: "p4.high-risk.commit", idempotencyKey: "commit-a", occurredAt: now, expectedPolicyRevision: 1,
      previewId: preview.preview.previewId, confirmationPhrase: preview.confirmationPhrase,
    })).rejects.toThrow("principal");
  });
});

describe("SQLite adapters and keyset boundaries", () => {
  it("rejects unsafe paths/bounds and handles missing scoped parents", () => {
    expect(() => new SqliteRuntimeAuditQueryAdapter(":memory:")).toThrow("path");
    expect(() => new SqliteRuntimeAuditQueryAdapter("\0bad")).toThrow("path");
    const directory = mkdtempSync(join(tmpdir(), "zhiloop-p4-empty-"));
    const db = join(directory, "audit.sqlite");
    const operations = new SqliteP4OperationStore(db);
    operations.close();
    expect(() => new SqliteRuntimeAuditQueryAdapter(db)).not.toThrow();
    const reader = new SqliteRuntimeAuditQueryAdapter(db);
    expect(() => reader.listInjections("session-a", 0)).toThrow("1..100");
    expect(() => reader.listClosures("session-a", 101)).toThrow("1..100");
    reader.close();
    reader.close();
    expect(() => new SqliteP4OperationStore("\0bad")).toThrow("path");
    rmSync(directory, { recursive: true, force: true });
  });

  it("stores exact idempotent operations and rejects semantic conflicts", () => {
    const directory = mkdtempSync(join(tmpdir(), "zhiloop-p4-ops-"));
    const db = join(directory, "operations.sqlite");
    const store = new SqliteP4OperationStore(db);
    const operation = { idempotencyKey: "operation-a", kind: "FEEDBACK", requestHash: "a".repeat(64), response: { outcome: "RECORDED", eligibleAfterWrite: true }, createdAt: now };
    expect(store.get("missing")).toBeUndefined();
    expect(store.commit(operation)).toBe("STORED");
    expect(store.commit(operation)).toBe("IDEMPOTENT");
    expect(store.get("operation-a")?.response).toEqual({ outcome: "RECORDED", eligibleAfterWrite: true });
    expect(() => store.commit({ ...operation, requestHash: "b".repeat(64) })).toThrow("semantic conflict");
    store.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("fails closed when a durable replay response or metadata is corrupted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zhiloop-p4-corrupt-"));
    const db = join(directory, "operations.sqlite");
    const store = new SqliteP4OperationStore(db);
    const runtime = new P4ConsoleRuntime({
      cursorSecret: secret,
      operations: store,
      feedback: {
        record: async () => ({ result: "RECORDED", eligibleAfterWrite: true }),
        recordUsage: async () => "RECORDED",
      },
      now: () => new Date(now),
    });
    const request = {
      schemaVersion: 1, type: "p4.feedback.record", idempotencyKey: "feedback-corrupt-a", occurredAt: now,
      action: "RELEVANT", assetId: "knowledge-a", expectedKnowledgeVersion: 1,
      scopeKey: "project:a", traceId: "trace-a", actor: "operator-a",
    } as const;
    await runtime.recordFeedback(request);
    const database = new DatabaseSync(db);
    database.prepare("UPDATE p4_console_operations SET response_json=? WHERE idempotency_key=?")
      .run(JSON.stringify({ outcome: "RECORDED", eligibleAfterWrite: true, forged: true }), request.idempotencyKey);
    await expect(runtime.recordFeedback(request)).rejects.toThrow("strict schema");
    database.prepare("UPDATE p4_console_operations SET kind=? WHERE idempotency_key=?").run("FORGED", request.idempotencyKey);
    expect(() => store.get(request.idempotencyKey)).toThrow("metadata");
    database.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
