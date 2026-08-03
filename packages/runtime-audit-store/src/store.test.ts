import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ContextEnvelope } from "@zhiloop/domain";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeAuditConflictError, SqliteRuntimeAuditStore } from "./store.js";
import type { ClosureRunRecord, InjectionAttemptRecord, McpExpansionAuditRecord } from "./types.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));
const now = "2026-08-03T00:00:00.000Z";

function databasePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "zhiloop-runtime-audit-"));
  directories.push(directory);
  return path.join(directory, "audit.sqlite");
}

function store(): SqliteRuntimeAuditStore {
  return new SqliteRuntimeAuditStore(databasePath());
}

function envelope(): ContextEnvelope {
  return {
    schemaVersion: 1, runId: "run-1", projectId: "project-1",
    complexity: { level: "L1_POINTER", breadth: 0, depth: "POINTER", authority: "NONE", evidence: "NONE", reasonCodes: ["SHADOW"] },
    budget: { maxTokens: 100, estimatedTokens: 1, truncated: false, disclosedItems: 0, omittedItems: 0 },
    items: [],
  };
}

function attempt(overrides: Partial<InjectionAttemptRecord> = {}): InjectionAttemptRecord {
  return {
    schemaVersion: 1, attemptId: "attempt-1", sessionId: "session-1", turnId: "turn-1",
    traceId: "trace-1", runId: "run-1", rolloutRevision: 7, status: "PENDING", revision: 0,
    envelope: envelope(), reasonCode: "DELIVERY_PENDING", createdAt: now, ...overrides,
  };
}

describe("SqliteRuntimeAuditStore", () => {
  it("persists an exact envelope before delivery and finalizes it with CAS", () => {
    using value = store();
    expect(value.beginInjection(attempt())).toEqual(attempt());
    expect(value.beginInjection(attempt())).toEqual(attempt());
    const completed = value.completeInjection("attempt-1", 0, "SHADOWED", "ROLLOUT_SHADOW", now);
    expect(completed).toMatchObject({ status: "SHADOWED", revision: 1, envelope: { runId: "run-1" } });
    expect(value.completeInjection("attempt-1", 0, "SHADOWED", "ROLLOUT_SHADOW", now)).toEqual(completed);
    expect(() => value.completeInjection("attempt-1", 0, "INJECTED", "ROLLOUT_ACTIVE", now))
      .toThrow(RuntimeAuditConflictError);
    expect(value.listInjections("session-1").items).toEqual([completed]);
  });

  it("records versioned MCP expansion and actual-use facts without payload copies", () => {
    using value = store();
    value.beginInjection(attempt());
    const expansion: McpExpansionAuditRecord = {
      schemaVersion: 1, expansionId: "expansion-1", attemptId: "attempt-1", traceId: "trace-1",
      tool: "ckl.get", knowledgeId: "knowledge-1", knowledgeVersion: 3,
      fromDetailLevel: "L1_POINTER", toDetailLevel: "L3_EVIDENCED", latencyMs: 4, used: true, occurredAt: now,
    };
    expect(value.recordMcpExpansion(expansion)).toEqual(expansion);
    expect(value.recordMcpExpansion(expansion)).toEqual(expansion);
    expect(value.listMcpExpansions("attempt-1")).toEqual({ items: [expansion], truncated: false });
    expect(JSON.stringify(value.getMcpExpansion("expansion-1"))).not.toContain("content");
    expect(() => value.recordMcpExpansion({ ...expansion, expansionId: "expansion-missing", attemptId: "missing" }))
      .toThrow("requires a persisted");
  });

  it("acknowledges only terminal INJECTED with evidence CAS and exact idempotency", () => {
    using value = store();
    value.beginInjection(attempt());
    const completed = value.completeInjection("attempt-1", 0, "INJECTED", "HOOK_CONTEXT_GENERATED", now);
    expect(completed).not.toHaveProperty("deliveryEvidenceRef");
    const acknowledged = value.acknowledgeInjectionDelivery("attempt-1", 1, "hook-client:receipt-1", now);
    expect(acknowledged).toMatchObject({
      status: "INJECTED", revision: 2, deliveryEvidenceRef: "hook-client:receipt-1", deliveredAt: now,
    });
    expect(value.acknowledgeInjectionDelivery("attempt-1", 1, "hook-client:receipt-1", now)).toEqual(acknowledged);
    expect(value.completeInjection("attempt-1", 0, "INJECTED", "HOOK_CONTEXT_GENERATED", now)).toEqual(acknowledged);
    expect(() => value.acknowledgeInjectionDelivery("attempt-1", 1, "hook-client:receipt-2", now))
      .toThrow(RuntimeAuditConflictError);
    expect(() => value.acknowledgeInjectionDelivery("attempt-1", 2, "hook-client:receipt-1", now))
      .toThrow(RuntimeAuditConflictError);
  });

  it("survives restart and resolves same-evidence concurrent ACK while rejecting different evidence", () => {
    const filename = databasePath();
    const first = new SqliteRuntimeAuditStore(filename);
    first.beginInjection(attempt());
    first.completeInjection("attempt-1", 0, "INJECTED", "HOOK_CONTEXT_GENERATED", now);
    first.close();

    const left = new SqliteRuntimeAuditStore(filename);
    const right = new SqliteRuntimeAuditStore(filename);
    const acknowledged = left.acknowledgeInjectionDelivery("attempt-1", 1, "transport:receipt-1", now);
    expect(right.acknowledgeInjectionDelivery("attempt-1", 1, "transport:receipt-1", now)).toEqual(acknowledged);
    expect(() => right.acknowledgeInjectionDelivery("attempt-1", 1, "transport:receipt-other", now))
      .toThrow(RuntimeAuditConflictError);
    left.close(); right.close();

    using restarted = new SqliteRuntimeAuditStore(filename);
    expect(restarted.getInjection("attempt-1")).toEqual(acknowledged);
  });

  it("rejects SHADOW ACK, invalid time/evidence and corrupt persisted acknowledgement", () => {
    const filename = databasePath();
    const value = new SqliteRuntimeAuditStore(filename);
    value.beginInjection(attempt());
    value.completeInjection("attempt-1", 0, "SHADOWED", "ROLLOUT_SHADOW", now);
    expect(() => value.acknowledgeInjectionDelivery("attempt-1", 1, "transport:receipt-1", now))
      .toThrow("only an unacknowledged INJECTED");
    expect(() => value.acknowledgeInjectionDelivery("attempt-1", 1, "bad\nevidence", now)).toThrow("invalid");
    expect(() => value.acknowledgeInjectionDelivery("attempt-1", 1, "transport:receipt-1", "not-a-time")).toThrow("invalid");
    expect(() => value.acknowledgeInjectionDelivery("missing", 1, "transport:receipt-1", now)).toThrow("not found");
    value.close();

    const database = new DatabaseSync(filename);
    const row = database.prepare("SELECT payload_json FROM injection_attempts WHERE attempt_id=?").get("attempt-1") as { payload_json: string };
    const corrupt = { ...(JSON.parse(row.payload_json) as InjectionAttemptRecord), deliveryEvidenceRef: "transport:forged" };
    database.prepare("UPDATE injection_attempts SET payload_json=? WHERE attempt_id=?").run(JSON.stringify(corrupt), "attempt-1");
    database.close();
    const reopened = new SqliteRuntimeAuditStore(filename);
    expect(() => reopened.getInjection("attempt-1")).toThrow("corrupt");
    expect(() => reopened.listInjections("session-1")).toThrow("corrupt");
    reopened.close();

    const columns = new DatabaseSync(filename);
    columns.prepare("UPDATE injection_attempts SET payload_json=?,revision=? WHERE attempt_id=?")
      .run(row.payload_json, 99, "attempt-1");
    columns.close();
    using mismatched = new SqliteRuntimeAuditStore(filename);
    expect(() => mismatched.getInjection("attempt-1")).toThrow("columns do not match");
  });

  it("rejects ACK timestamps before completion", () => {
    using value = store();
    const completedAt = "2026-08-03T00:00:01.000Z";
    value.beginInjection(attempt());
    value.completeInjection("attempt-1", 0, "INJECTED", "HOOK_CONTEXT_GENERATED", completedAt);
    expect(() => value.acknowledgeInjectionDelivery("attempt-1", 1, "transport:receipt-1", now))
      .toThrow("cannot precede");
  });

  it("persists detached MCP get expansions without inventing an injection attempt", () => {
    const filename = databasePath();
    const value = new SqliteRuntimeAuditStore(filename);
    const detached: McpExpansionAuditRecord = {
      schemaVersion: 1, expansionId: "expansion-standalone", traceId: "trace-search-get",
      tool: "ckl.get", knowledgeId: "knowledge-1", knowledgeVersion: 3,
      fromDetailLevel: "L1_POINTER", toDetailLevel: "L2_COMPACT", latencyMs: 2, used: false, occurredAt: now,
    };
    expect(value.recordMcpExpansion(detached)).toEqual(detached);
    expect(value.getMcpExpansion("expansion-standalone")).toEqual(detached);
    expect(value.listMcpExpansions("attempt-1").items).toEqual([]);
    value.close();
    using restarted = new SqliteRuntimeAuditStore(filename);
    expect(restarted.getMcpExpansion("expansion-standalone")).toEqual(detached);
  });

  it("persists closure contract, gates, decision, delta, continuation and interaction", () => {
    using value = store();
    const closure: ClosureRunRecord = {
      schemaVersion: 1, closureRunId: "closure-1", sessionId: "session-1", turnId: "turn-1",
      taskContract: { contractId: "contract-1", objective: "finish safely", gates: ["tests"], boundaries: ["no secret"] },
      gates: [{ gateId: "gate-1", status: "SATISFIED", reasonCodes: ["TEST_PASSED"], evidenceRefs: ["test-1"] }],
      decision: "RETRY_WITH_CORRECTION", correctionDelta: "run the missing test", continuationCount: 1,
      recursiveStopRejected: false, interaction: { required: false }, createdAt: now,
    };
    expect(value.recordClosure(closure)).toEqual(closure);
    expect(value.recordClosure(closure)).toEqual(closure);
    expect(value.getClosure("closure-1")).toEqual(closure);
    expect(value.listClosures("session-1")).toEqual({ items: [closure], truncated: false });
  });

  it("rejects invalid transitions, identities and detail expansion while recording first recursive stop rejection", () => {
    using value = store();
    expect(() => value.beginInjection(attempt({ status: "INJECTED", completedAt: now }))).toThrow("pending");
    expect(() => value.completeInjection("missing", 0, "INJECTED", "ROLLOUT_ACTIVE", now)).toThrow("not found");
    expect(() => value.listInjections("bad\n", 1)).toThrow("invalid");
    expect(() => value.listInjections("session-1", 101)).toThrow("limit");
    value.beginInjection(attempt());
    expect(() => value.recordMcpExpansion({
      schemaVersion: 1, expansionId: "expansion-1", attemptId: "attempt-1", traceId: "trace-1",
      tool: "ckl.get", knowledgeId: "knowledge-1", knowledgeVersion: 1,
      fromDetailLevel: "L2_COMPACT", toDetailLevel: "L2_COMPACT", latencyMs: 1, used: false, occurredAt: now,
    })).toThrow("invalid");
    expect(value.recordClosure({
      schemaVersion: 1, closureRunId: "closure-1", sessionId: "session-1", turnId: "turn-1",
      taskContract: { contractId: "contract-1", objective: "x", gates: [], boundaries: [] }, gates: [],
      decision: "PASS", continuationCount: 0, recursiveStopRejected: true, createdAt: now,
    }).recursiveStopRejected).toBe(true);
  });
});
