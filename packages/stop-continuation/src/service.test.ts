import type { ClosureVerificationInput } from "@zhiloop/closure-verifier";
import { DEFAULT_CONFIGURATION } from "@zhiloop/config";
import type { ClosureVerificationResult } from "@zhiloop/domain";
import { describe, expect, it, vi } from "vitest";

import { InMemoryContinuationCounter } from "./counter.js";
import { serializeStopHookResult, StopContinuationService } from "./service.js";
import type { StopClosurePort, StopContextDeltaPort, StopContinuationRequest } from "./types.js";

const closureInput: ClosureVerificationInput = {
  verificationId: "verification-stop",
  task: {
    taskId: "turn-a", objective: "Finish the declared implementation.",
    gates: [{ gateId: "gate-test", description: "Run test-a successfully", type: "TEST_PASSED", testId: "test-a" }],
    boundaries: [{ boundaryId: "boundary-secrets", type: "FORBID_PATH_PREFIX", pathPrefix: "secrets" }],
    requiredKnowledge: [{ knowledgeId: "knowledge.required", minimumDetailLevel: "L3_EVIDENCED" }],
  },
  contextEnvelope: {
    schemaVersion: 1, runId: "run-stop", projectId: "project-a", taskId: "turn-a",
    complexity: { level: "L1_POINTER", breadth: 0, depth: "POINTER", authority: "NONE", evidence: "NONE", reasonCodes: ["REQUESTED_COMPLEXITY_LEVEL"] },
    budget: { maxTokens: 800, estimatedTokens: 100, truncated: false }, items: [],
  },
  diff: { changedPaths: ["packages/a.ts"], summary: "Implemented." },
  toolResults: [], tests: [{ testId: "test-a", status: "PASSED", summary: "Passed." }],
  finalConclusion: { claimedComplete: true, summary: "Done.", openIssues: [] },
};

const request: StopContinuationRequest = {
  hook: {
    hook_event_name: "Stop", session_id: "session-a", turn_id: "turn-a", cwd: "/workspace/a",
    stop_hook_active: false, last_assistant_message: "Implementation is complete.",
  },
  closureInput,
};

function verification(
  decision: ClosureVerificationResult["decision"],
  overrides: Partial<ClosureVerificationResult> = {},
): ClosureVerificationResult {
  return {
    schemaVersion: 1, verificationId: closureInput.verificationId, taskId: closureInput.task.taskId,
    decision, reasonCodes: [decision === "PASS" ? "ALL_DECLARED_GATES_SATISFIED" : "FIXTURE_DECISION"],
    missingKnowledgeIds: [], unmetGateIds: [], violatedBoundaryIds: [],
    gateResults: [{ gateId: "gate-test", status: "SATISFIED", reasonCodes: ["TEST_PASSED"], evidenceRefs: ["test:test-a:PASSED"] }],
    ...overrides,
  };
}

const closurePort = (value: ClosureVerificationResult): StopClosurePort => ({
  verify: vi.fn(async () => value),
});

const contextDelta: StopContextDeltaPort = {
  load: vi.fn(async (): ReturnType<StopContextDeltaPort["load"]> => ({
    traceId: "trace-context-delta",
    items: [{
      id: "knowledge.required", version: 1, fromDetailLevel: "L2_COMPACT", toDetailLevel: "L3_EVIDENCED",
      content: "Only the missing evidence-backed content.",
      evidenceSummary: [{ evidenceId: "evidence-required", verdict: "SUPPORTS" }],
    }],
  })),
};

function service(
  deterministic: StopClosurePort,
  options: { semantic?: StopClosurePort; counters?: InMemoryContinuationCounter; delta?: StopContextDeltaPort; outer?: number } = {},
): StopContinuationService {
  return new StopContinuationService(
    deterministic, options.semantic, options.delta ?? contextDelta,
    options.counters ?? new InMemoryContinuationCounter(), DEFAULT_CONFIGURATION.closure,
    { outerHookTimeoutMs: options.outer ?? 5_000 },
  );
}

describe("StopContinuationService", () => {
  it("lets PASS end the turn with valid empty Stop JSON", async () => {
    const result = await service(closurePort(verification("PASS"))).handle(request);
    expect(result).toEqual({ status: "PASS", decision: "PASS", continuationCount: 0 });
    expect(serializeStopHookResult(result)).toBe("{}");
  });

  it("continues RETRY_WITH_CONTEXT once with only exact target deltas", async () => {
    const counters = new InMemoryContinuationCounter();
    const result = verification("RETRY_WITH_CONTEXT", {
      reasonCodes: ["REQUIRED_KNOWLEDGE_MISSING"], missingKnowledgeIds: ["knowledge.required"],
    });
    const runtime = service(closurePort(result), { counters });
    const first = await runtime.handle(request);
    expect(first).toMatchObject({
      status: "CONTINUED_WITH_CONTEXT", decision: "RETRY_WITH_CONTEXT", continuationCount: 1,
      output: { decision: "block" },
    });
    expect(first.output?.reason).toContain('"requestedKnowledgeIds":["knowledge.required"]');
    expect(first.output?.reason).toContain("Only the missing evidence-backed content.");
    expect(first.output?.reason).not.toContain(closureInput.contextEnvelope.runId);
    expect(JSON.parse(serializeStopHookResult(first))).toEqual(first.output);
    expect((await runtime.handle(request)).status).toBe("LIMIT_REACHED");
  });

  it("continues correction with only declared unmet Gate and Boundary targets", async () => {
    const result = verification("RETRY_WITH_CORRECTION", {
      reasonCodes: ["DECLARED_BOUNDARY_VIOLATED"], unmetGateIds: ["gate-test"],
      violatedBoundaryIds: ["boundary-secrets"],
      gateResults: [{ gateId: "gate-test", status: "UNSATISFIED", reasonCodes: ["TEST_FAILED"], evidenceRefs: [] }],
    });
    const continued = await service(closurePort(result)).handle(request);
    expect(continued.status).toBe("CONTINUED_WITH_CORRECTION");
    expect(continued.output?.reason).toContain('"gateId":"gate-test"');
    expect(continued.output?.reason).toContain('"boundaryId":"boundary-secrets"');
    expect(continued.output?.reason).not.toContain(closureInput.task.objective);
  });

  it("never verifies or continues when stop_hook_active or the local limit is reached", async () => {
    const port = closurePort(verification("RETRY_WITH_CORRECTION", {
      unmetGateIds: ["gate-test"],
      gateResults: [{ gateId: "gate-test", status: "UNSATISFIED", reasonCodes: ["TEST_FAILED"], evidenceRefs: [] }],
    }));
    const active = await service(port).handle({ ...request, hook: { ...request.hook, stop_hook_active: true } });
    expect(active.status).toBe("HOOK_ALREADY_ACTIVE");
    expect(port.verify).not.toHaveBeenCalled();

    const counters = new InMemoryContinuationCounter();
    const key = JSON.stringify([request.hook.session_id, request.hook.turn_id]);
    expect(counters.claim(key, 1)).toBe(true);
    const limitedPort = closurePort(verification("PASS"));
    expect((await service(limitedPort, { counters }).handle(request)).status).toBe("LIMIT_REACHED");
    expect(limitedPort.verify).not.toHaveBeenCalled();
  });

  it("allows at most two high-risk continuations and claims atomically under concurrency", async () => {
    const correction = verification("RETRY_WITH_CORRECTION", {
      unmetGateIds: ["gate-test"],
      gateResults: [{ gateId: "gate-test", status: "UNSATISFIED", reasonCodes: ["TEST_FAILED"], evidenceRefs: [] }],
    });
    const counters = new InMemoryContinuationCounter();
    const runtime = service(closurePort(correction), { counters });
    expect((await runtime.handle({ ...request, risk: "HIGH" })).status).toBe("CONTINUED_WITH_CORRECTION");
    expect((await runtime.handle({ ...request, risk: "HIGH" })).status).toBe("CONTINUED_WITH_CORRECTION");
    expect((await runtime.handle({ ...request, risk: "HIGH" })).status).toBe("LIMIT_REACHED");

    const concurrent = service(closurePort(correction), { counters: new InMemoryContinuationCounter() });
    const statuses = await Promise.all([concurrent.handle(request), concurrent.handle(request)]);
    expect(statuses.map((item) => item.status).sort()).toEqual(["CONTINUED_WITH_CORRECTION", "LIMIT_REACHED"]);
  });

  it("uses optional semantic verification only after deterministic semantic-unavailable result", async () => {
    const deterministic = closurePort(verification("ASK_USER", { reasonCodes: ["SEMANTIC_VERIFICATION_UNAVAILABLE"] }));
    const semantic = closurePort(verification("PASS"));
    const result = await service(deterministic, { semantic }).handle(request);
    expect(result.status).toBe("PASS");
    expect(semantic.verify).toHaveBeenCalledOnce();
    const directAsk = await service(closurePort(verification("ASK_USER", { reasonCodes: ["SEMANTIC_GATE_UNKNOWN"] })), { semantic }).handle(request);
    expect(directAsk.status).toBe("ASK_USER");
  });

  it("fails open as UNKNOWN on deterministic/semantic timeout and aborts the operation", async () => {
    let deterministicSignal: AbortSignal | undefined;
    const hanging: StopClosurePort = {
      verify: async (_input, _policy, signal) => {
        deterministicSignal = signal;
        return await new Promise(() => undefined);
      },
    };
    const timed = await service(hanging, { outer: 10 }).handle(request);
    expect(timed.status).toBe("UNKNOWN");
    expect(timed.output).toBeUndefined();
    expect(serializeStopHookResult(timed)).toBe("{}");
    expect(deterministicSignal?.aborted).toBe(true);

    const deterministic = closurePort(verification("ASK_USER", { reasonCodes: ["SEMANTIC_VERIFICATION_UNAVAILABLE"] }));
    const semantic = { verify: vi.fn(async () => await new Promise(() => undefined)) } as unknown as StopClosurePort;
    expect((await service(deterministic, { semantic, outer: 10 }).handle(request)).status).toBe("UNKNOWN");
  });

  it("fails open when context/correction deltas or verifier targets are not exact subsets", async () => {
    const contextResult = verification("RETRY_WITH_CONTEXT", { missingKnowledgeIds: ["knowledge.required"] });
    const incompleteDelta: StopContextDeltaPort = { load: async () => ({ traceId: "trace-delta", items: [] }) };
    expect((await service(closurePort(contextResult), { delta: incompleteDelta }).handle(request)).status).toBe("UNKNOWN");
    const duplicateDelta: StopContextDeltaPort = {
      load: async () => ({
        traceId: "trace-delta",
        items: [
          ...(await contextDelta.load(["knowledge.required"], new AbortController().signal)).items,
          ...(await contextDelta.load(["knowledge.required"], new AbortController().signal)).items,
        ],
      }),
    };
    expect((await service(closurePort(contextResult), { delta: duplicateDelta }).handle(request)).status).toBe("UNKNOWN");
    const compactOnlyDelta = {
      load: async () => ({
        traceId: "trace-delta",
        items: [{
          id: "knowledge.required", version: 1,
          fromDetailLevel: "L1_POINTER", toDetailLevel: "L2_COMPACT",
          applicability: [], failurePaths: [], symbols: [], evidencePointers: [],
        }],
      }),
    } as unknown as StopContextDeltaPort;
    expect((await service(closurePort(contextResult), { delta: compactOnlyDelta }).handle(request)).status).toBe("UNKNOWN");

    const expanded = verification("RETRY_WITH_CORRECTION", { unmetGateIds: ["new-gate"] });
    expect((await service(closurePort(expanded)).handle(request)).status).toBe("UNKNOWN");
    const noTarget = verification("RETRY_WITH_CORRECTION");
    expect((await service(closurePort(noTarget)).handle(request)).status).toBe("UNKNOWN");
    const contradictoryPass = verification("PASS", { missingKnowledgeIds: ["knowledge.required"] });
    expect((await service(closurePort(contradictoryPass)).handle(request)).status).toBe("UNKNOWN");
  });

  it("validates Stop input identity and outer timeout", async () => {
    const port = closurePort(verification("PASS"));
    expect((await service(port).handle({ ...request, hook: { ...request.hook, turn_id: "other" } })).status).toBe("INVALID_INPUT");
    expect(port.verify).not.toHaveBeenCalled();
    expect(() => service(port, { outer: 0 })).toThrow("outerHookTimeoutMs");
  });
});
