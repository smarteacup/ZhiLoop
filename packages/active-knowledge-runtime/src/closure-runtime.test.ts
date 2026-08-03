import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ClosureVerificationInput, SemanticClosurePort } from "@zhiloop/closure-verifier";
import { DEFAULT_CONFIGURATION } from "@zhiloop/config";
import { SqliteConfirmationWritebackRepository } from "@zhiloop/confirmation-writeback";
import { SqliteRuntimeAuditStore } from "@zhiloop/runtime-audit-store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActiveClosureOperationConflictError, SqliteActiveClosureOperationStore } from "./closure-operation-store.js";
import { ActiveClosureRuntime } from "./closure-runtime.js";
import { emptyEnvelope, fixedNow } from "./test-fixtures.js";
import type { ActiveClosureRequest } from "./types.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function resources() {
  const directory = mkdtempSync(path.join(tmpdir(), "zhiloop-active-closure-"));
  directories.push(directory);
  return {
    audits: new SqliteRuntimeAuditStore(path.join(directory, "audit.sqlite")),
    confirmations: new SqliteConfirmationWritebackRepository(path.join(directory, "confirmations.sqlite")),
    operations: new SqliteActiveClosureOperationStore(path.join(directory, "operations.sqlite")),
  };
}

function closureInput(type: "TEST_PASSED" | "SEMANTIC" = "TEST_PASSED", passed = false): ClosureVerificationInput {
  return {
    verificationId: `verification-${type.toLowerCase()}`,
    task: {
      taskId: "turn-1",
      objective: "complete the declared implementation safely",
      gates: type === "TEST_PASSED"
        ? [{ gateId: "gate-tests", description: "direct tests pass", type, testId: "test-1" }]
        : [{ gateId: "gate-semantic", description: "implementation is coherent", type }],
      boundaries: [{ boundaryId: "boundary-secrets", type: "FORBID_PATH_PREFIX", pathPrefix: "secrets" }],
      requiredKnowledge: [],
    },
    contextEnvelope: {
      ...emptyEnvelope(),
      taskContract: {
        contractId: "contract-1",
        objective: "complete the declared implementation safely",
        gates: [type === "TEST_PASSED" ? "gate-tests" : "gate-semantic"],
        boundaries: ["boundary-secrets"],
      },
    },
    diff: { changedPaths: ["packages/runtime.ts"], summary: "compose runtime" },
    toolResults: [],
    tests: type === "TEST_PASSED" ? [{ testId: "test-1", status: passed ? "PASSED" : "FAILED", summary: "unit" }] : [],
    finalConclusion: { claimedComplete: true, summary: "implementation complete", openIssues: [] },
  };
}

function request(input: ClosureVerificationInput, stopHookActive = false): ActiveClosureRequest {
  return {
    stop: {
      hook: {
        hook_event_name: "Stop",
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: "/workspace/project-a",
        stop_hook_active: stopHookActive,
        last_assistant_message: "done",
      },
      closureInput: input,
    },
    interaction: { turnOrdinal: 1, history: [] },
  };
}

function runtime(values: ReturnType<typeof resources>, semantic?: SemanticClosurePort) {
  return new ActiveClosureRuntime({
    audits: values.audits,
    operations: values.operations,
    confirmations: values.confirmations,
    confirmationWriteback: { handle: vi.fn(async () => ({ status: "NO_PENDING" as const })) },
    closurePolicy: structuredClone(DEFAULT_CONFIGURATION.closure),
    verificationPolicy: structuredClone(DEFAULT_CONFIGURATION.verification),
    contextDelta: { load: vi.fn(async () => ({ traceId: "trace-delta", items: [] })) },
    ...(semantic === undefined ? {} : { semantic }),
    outerHookTimeoutMs: 5_000,
    now: () => new Date(fixedNow),
  });
}

describe("ActiveClosureRuntime", () => {
  it("persists deterministic gates, correction delta and bounded continuation, then rejects recursive Stop", async () => {
    const values = resources();
    const service = runtime(values);
    const first = await service.handle(request(closureInput()));
    expect(first.stop).toMatchObject({ status: "CONTINUED_WITH_CORRECTION", continuationCount: 1 });
    expect(first.audit).toMatchObject({
      taskContract: { contractId: "contract-1" },
      gates: [{ gateId: "gate-tests", status: "UNSATISFIED" }],
      decision: "RETRY_WITH_CORRECTION",
      continuationCount: 1,
      recursiveStopRejected: false,
    });
    expect(first.audit.correctionDelta).toContain("declared unmet gates");

    const recursive = await service.handle(request(closureInput(), true));
    expect(recursive.stop).toMatchObject({ status: "HOOK_ALREADY_ACTIVE", continuationCount: 1 });
    expect(recursive.audit).toMatchObject({ recursiveStopRejected: true, continuationCount: 1 });
    expect(values.audits.listClosures("session-1").items).toHaveLength(2);
    values.audits.close(); values.confirmations.close(); values.operations.close();
  });

  it("persists a first recursive Stop rejection with the exact zero continuation count", async () => {
    const values = resources();
    const recursive = await runtime(values).handle(request(closureInput(), true));
    expect(recursive.stop).toMatchObject({ status: "HOOK_ALREADY_ACTIVE", continuationCount: 0 });
    expect(recursive.audit).toMatchObject({ recursiveStopRejected: true, continuationCount: 0, decision: "ASK_USER" });
    expect(values.audits.listClosures("session-1").items).toHaveLength(1);
    values.audits.close(); values.confirmations.close(); values.operations.close();
  });

  it("restores the continuation bound from durable audits after runtime restart", async () => {
    const values = resources();
    expect((await runtime(values).handle(request(closureInput()))).stop.continuationCount).toBe(1);
    const nextInput = { ...closureInput(), verificationId: "verification-next" };
    const afterRestart = await runtime(values).handle(request(nextInput));
    expect(afterRestart.stop).toMatchObject({ status: "LIMIT_REACHED", continuationCount: 1 });
    expect(afterRestart.audit.continuationCount).toBe(1);
    values.audits.close(); values.confirmations.close(); values.operations.close();
  });

  it("uses the bounded semantic verifier only for declared semantic gates", async () => {
    const values = resources();
    const semantic: SemanticClosurePort = {
      available: true,
      verify: vi.fn(async ({ gates }) => ({
        gateResults: gates.map((gate: { readonly gateId: string }) => ({
          gateId: gate.gateId,
          status: "SATISFIED" as const,
          reasonCodes: ["SEMANTIC_GATE_SATISFIED"],
          evidenceRefs: ["semantic:model-run-1"],
        })),
      })),
    };
    const result = await runtime(values, semantic).handle(request(closureInput("SEMANTIC")));
    expect(result.stop).toMatchObject({ status: "PASS", decision: "PASS", continuationCount: 0 });
    expect(result.audit).toMatchObject({ decision: "PASS", gates: [{ status: "SATISFIED" }] });
    expect(semantic.verify).toHaveBeenCalledOnce();
    const replay = await runtime(values, semantic).handle(request(closureInput("SEMANTIC")));
    expect(replay).toEqual(result);
    expect(semantic.verify).toHaveBeenCalledOnce();
    const changed = { ...closureInput("SEMANTIC"), diff: { changedPaths: ["packages/other.ts"], summary: "changed" } };
    await expect(runtime(values, semantic).handle(request(changed))).rejects.toBeInstanceOf(ActiveClosureOperationConflictError);
    expect(semantic.verify).toHaveBeenCalledOnce();
    values.audits.close(); values.confirmations.close(); values.operations.close();
  });

  it("rejects a concurrent duplicate while the same closure operation is still in progress", async () => {
    const values = resources();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const semantic: SemanticClosurePort = {
      available: true,
      verify: vi.fn(async ({ gates }) => {
        await blocked;
        return {
          gateResults: gates.map((gate: { readonly gateId: string }) => ({
            gateId: gate.gateId,
            status: "SATISFIED" as const,
            reasonCodes: ["SEMANTIC_GATE_SATISFIED"],
            evidenceRefs: ["semantic:model-run-concurrent"],
          })),
        };
      }),
    };
    const service = runtime(values, semantic);
    const pending = service.handle(request(closureInput("SEMANTIC")));
    await vi.waitFor(() => expect(semantic.verify).toHaveBeenCalledOnce());

    await expect(service.handle(request(closureInput("SEMANTIC"))))
      .rejects.toThrow("closure operation is already in progress");

    release?.();
    await expect(pending).resolves.toMatchObject({ stop: { status: "PASS" } });
    values.audits.close(); values.confirmations.close(); values.operations.close();
  });

  it("recovers a cross-store confirmation half-commit from the durable outcome without rerunning semantics", async () => {
    const values = resources();
    const semantic: SemanticClosurePort = {
      available: true,
      verify: vi.fn(async ({ gates }) => ({
        gateResults: gates.map((gate: { readonly gateId: string }) => ({
          gateId: gate.gateId,
          status: "UNKNOWN" as const,
          reasonCodes: ["SEMANTIC_GATE_UNKNOWN"],
          evidenceRefs: [],
        })),
      })),
    };
    vi.spyOn(values.confirmations, "save").mockImplementationOnce(() => { throw new Error("confirmation store unavailable"); });
    const pending = request(closureInput("SEMANTIC"));
    await expect(runtime(values, semantic).handle(pending)).rejects.toThrow("confirmation store unavailable");
    expect(values.audits.listClosures("session-1").items).toHaveLength(1);
    expect(values.confirmations.pending("session-1")).toHaveLength(0);
    const recovered = await runtime(values, semantic).handle(pending);
    expect(recovered.audit.interaction).toMatchObject({ required: true });
    expect(values.confirmations.pending("session-1")).toHaveLength(1);
    expect(values.audits.listClosures("session-1").items).toHaveLength(1);
    expect(semantic.verify).toHaveBeenCalledOnce();
    values.audits.close(); values.confirmations.close(); values.operations.close();
  });

  it("persists an ASK_USER interaction and exposes confirmation writeback", async () => {
    const values = resources();
    const service = runtime(values);
    const ask = request(closureInput("SEMANTIC"));
    const result = await service.handle({
      ...ask,
      interaction: {
        ...ask.interaction,
        targets: [{ subjectId: "verification-semantic", expectedRevision: "knowledge:revision-7" }],
      },
    });
    expect(result.stop).toMatchObject({ status: "ASK_USER", decision: "ASK_USER" });
    expect(result.audit.interaction).toMatchObject({ required: true });
    expect(result.audit.interaction?.question).toContain("任务闭环信息");
    expect(values.confirmations.pending("session-1")[0]?.targets).toEqual([
      { subjectId: "verification-semantic", expectedRevision: "knowledge:revision-7" },
    ]);
    expect(await service.writeback({
      sessionId: "session-1", turnId: "turn-2", turnOrdinal: 2,
      eventId: "event-2", statement: "stop-safe", occurredAt: "2026-08-04T00:01:00.000Z",
    })).toEqual({ status: "NO_PENDING" });
    values.audits.close(); values.confirmations.close(); values.operations.close();
  });

  it("persists a derived Task Contract and safe default for a low-impact interaction", async () => {
    const values = resources();
    const inputWithoutContract = closureInput("TEST_PASSED", true);
    const { taskContract: _taskContract, ...contextEnvelope } = inputWithoutContract.contextEnvelope;
    const input = {
      ...inputWithoutContract,
      contextEnvelope,
    };
    const base = request(input);
    const result = await runtime(values).handle({
      ...base,
      stop: { ...base.stop, risk: "HIGH" },
      interaction: {
        ...base.interaction,
        extraTriggers: [{
          triggerId: "trigger-low", sessionId: "session-1", turnId: "turn-1", turnOrdinal: 1,
          kind: "LOW_IMPACT_UNKNOWN", impact: "LOW", irreversible: false,
          subjectIds: ["knowledge-1"], summary: "low confidence observation",
        }],
      },
    });
    expect(result.stop.status).toBe("PASS");
    expect(result.audit).toMatchObject({
      taskContract: { contractId: "contract:turn-1", gates: ["gate-tests"], boundaries: ["boundary-secrets"] },
      interaction: { required: false, safeDefault: "KEEP_PROPOSED" },
    });
    values.audits.close(); values.confirmations.close(); values.operations.close();
  });
});
