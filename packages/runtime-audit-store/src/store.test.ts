import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ContextEnvelope } from "@zhiloop/domain";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeAuditConflictError, SqliteRuntimeAuditStore } from "./store.js";
import type { ClosureRunRecord, InjectionAttemptRecord, McpExpansionAuditRecord } from "./types.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));
const now = "2026-08-03T00:00:00.000Z";

function store(): SqliteRuntimeAuditStore {
  const directory = mkdtempSync(path.join(tmpdir(), "zhiloop-runtime-audit-"));
  directories.push(directory);
  return new SqliteRuntimeAuditStore(path.join(directory, "audit.sqlite"));
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

  it("rejects invalid transitions, identities, detail expansion and closure recursion", () => {
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
    expect(() => value.recordClosure({
      schemaVersion: 1, closureRunId: "closure-1", sessionId: "session-1", turnId: "turn-1",
      taskContract: { contractId: "contract-1", objective: "x", gates: [], boundaries: [] }, gates: [],
      decision: "PASS", continuationCount: 0, recursiveStopRejected: true, createdAt: now,
    })).toThrow("invalid");
  });
});
