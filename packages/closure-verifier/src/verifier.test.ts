import { DEFAULT_CONFIGURATION, loadClosurePolicy } from "@zhiloop/config";
import type { ContextEnvelope } from "@zhiloop/domain";
import { parseClosureVerificationResult } from "@zhiloop/schemas";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { ClosureVerificationInput, SemanticClosurePort } from "./types.js";
import { ClosureVerifier } from "./verifier.js";

const contextEnvelope: ContextEnvelope = {
  schemaVersion: 1, runId: "run-closure", projectId: "project-a", taskId: "task-a",
  complexity: {
    level: "L2_COMPACT", breadth: 1, depth: "COMPACT", authority: "REFERENCE", evidence: "POINTER",
    reasonCodes: ["DEFAULT_COMPLEXITY_LEVEL"],
  },
  budget: { maxTokens: 800, estimatedTokens: 240, truncated: false },
  items: [{
    id: "knowledge.required", version: 1, subjectKey: "knowledge.required", kind: "IMPLEMENTATION",
    status: "IMPLEMENTED", scope: { level: "PROJECT", projectId: "project-a" }, authority: "REFERENCE",
    detailLevel: "L2_COMPACT", title: "Required knowledge", summary: "Required knowledge summary.", retrievalRank: 1,
    applicability: ["project-a"], failurePaths: [], symbols: [], evidencePointers: ["evidence-required"],
  }],
};

function input(overrides: Partial<ClosureVerificationInput> = {}): ClosureVerificationInput {
  return {
    verificationId: "verification-a",
    task: {
      taskId: "task-a", objective: "Implement the requested module without touching secrets.",
      gates: [
        { gateId: "gate-test", description: "Tests pass", type: "TEST_PASSED", testId: "test-a" },
        { gateId: "gate-artifact", description: "Artifact exists", type: "ARTIFACT_PRESENT", artifactId: "artifact-a" },
        { gateId: "gate-path", description: "Source changed", type: "PATH_CHANGED", path: "packages/a/src/a.ts" },
        { gateId: "gate-tool", description: "Review succeeds", type: "TOOL_SUCCEEDED", toolName: "review" },
        { gateId: "gate-open", description: "No open issues", type: "NO_OPEN_ISSUES" },
      ],
      boundaries: [{ boundaryId: "boundary-secrets", type: "FORBID_PATH_PREFIX", pathPrefix: "secrets" }],
      requiredKnowledge: [{ knowledgeId: "knowledge.required", minimumDetailLevel: "L2_COMPACT" }],
    },
    contextEnvelope,
    diff: { changedPaths: ["packages/a/src/a.ts"], summary: "Implemented module." },
    toolResults: [{
      toolCallId: "tool-review", toolName: "review", status: "SUCCEEDED",
      artifactIds: ["artifact-a"], summary: "No findings.",
    }],
    tests: [{ testId: "test-a", status: "PASSED", summary: "All passed." }],
    finalConclusion: { claimedComplete: true, summary: "Implementation complete.", openIssues: [] },
    ...overrides,
  };
}

describe("ClosureVerifier", () => {
  it("passes only after every deterministic declared gate and required context is satisfied", async () => {
    const result = await new ClosureVerifier().verify(input(), DEFAULT_CONFIGURATION.closure);
    expect(result).toMatchObject({
      decision: "PASS", reasonCodes: ["ALL_DECLARED_GATES_SATISFIED"],
      missingKnowledgeIds: [], unmetGateIds: [], violatedBoundaryIds: [],
    });
    expect(result.gateResults).toHaveLength(5);
    expect(result.gateResults.every((gate) => gate.status === "SATISFIED")).toBe(true);
    expect(parseClosureVerificationResult(result).ok).toBe(true);
    expect(Object.isFrozen(result.gateResults[0]?.evidenceRefs)).toBe(true);
    const policy = loadClosurePolicy(readFileSync(new URL("../../../config/closure-policy.yaml", import.meta.url), "utf8"));
    expect(policy).toEqual({ ok: true, value: DEFAULT_CONFIGURATION.closure });
  });

  it("prioritizes a deterministic boundary violation and identifies only original boundary IDs", async () => {
    const semantic = { available: true, verify: vi.fn() } as unknown as SemanticClosurePort;
    const value = input({
      task: {
        ...input().task,
        gates: [...input().task.gates, { gateId: "gate-semantic", description: "Matches intent", type: "SEMANTIC" }],
        requiredKnowledge: [{ knowledgeId: "knowledge.missing", minimumDetailLevel: "L3_EVIDENCED" }],
      },
      diff: { changedPaths: ["packages/a/src/a.ts", "secrets/token.txt"], summary: "Touched secret." },
    });
    const result = await new ClosureVerifier(semantic).verify(value, DEFAULT_CONFIGURATION.closure);
    expect(result).toMatchObject({
      decision: "RETRY_WITH_CORRECTION", reasonCodes: ["DECLARED_BOUNDARY_VIOLATED"],
      unmetGateIds: [], violatedBoundaryIds: ["boundary-secrets"],
    });
    expect(semantic.verify).not.toHaveBeenCalled();
    expect(result.violatedBoundaryIds.every((id) => value.task.boundaries.some((boundary) => boundary.boundaryId === id))).toBe(true);
  });

  it("returns correction with exact unmet gates for failed deterministic evidence", async () => {
    const result = await new ClosureVerifier().verify(input({
      tests: [{ testId: "test-a", status: "FAILED", summary: "Failure." }],
      finalConclusion: { claimedComplete: false, summary: "Incomplete.", openIssues: ["test failed"] },
    }), DEFAULT_CONFIGURATION.closure);
    expect(result.decision).toBe("RETRY_WITH_CORRECTION");
    expect(result.reasonCodes).toEqual(["DETERMINISTIC_GATE_FAILED", "FINAL_CONCLUSION_INCOMPLETE"]);
    expect(result.unmetGateIds).toEqual(["gate-test", "gate-open"]);
  });

  it("asks instead of creating a targetless correction when completion is uncertain", async () => {
    const result = await new ClosureVerifier().verify(input({
      finalConclusion: { claimedComplete: false, summary: "Uncertain completion.", openIssues: [] },
    }), DEFAULT_CONFIGURATION.closure);
    expect(result).toMatchObject({
      decision: "ASK_USER", reasonCodes: ["FINAL_CONCLUSION_INCOMPLETE"],
      missingKnowledgeIds: [], unmetGateIds: [], violatedBoundaryIds: [],
    });
  });

  it("requests exact missing knowledge IDs when detail is absent or too shallow", async () => {
    const value = input({
      task: {
        ...input().task,
        requiredKnowledge: [
          { knowledgeId: "knowledge.required", minimumDetailLevel: "L3_EVIDENCED" },
          { knowledgeId: "knowledge.missing", minimumDetailLevel: "L1_POINTER" },
        ],
      },
    });
    const result = await new ClosureVerifier().verify(value, DEFAULT_CONFIGURATION.closure);
    expect(result).toMatchObject({
      decision: "RETRY_WITH_CONTEXT", reasonCodes: ["REQUIRED_KNOWLEDGE_MISSING"],
      missingKnowledgeIds: ["knowledge.required", "knowledge.missing"],
    });
    expect(result.missingKnowledgeIds.every((id) => value.task.requiredKnowledge.some((item) => item.knowledgeId === id))).toBe(true);
  });

  it("calls semantic verification only for declared semantic gate IDs and accepts a supported result", async () => {
    const semantic: SemanticClosurePort = {
      available: true,
      verify: vi.fn(async (request) => {
        expect(Object.keys(request).sort()).toEqual([
          "contextEnvelope", "diff", "finalConclusion", "gates", "objective", "signal", "tests", "toolResults",
        ]);
        expect(request.gates).toEqual([{ gateId: "gate-semantic", description: "Implementation matches objective" }]);
        return { gateResults: [{ gateId: "gate-semantic", status: "SATISFIED" as const, reasonCodes: ["INTENT_MATCHED"], evidenceRefs: ["diff:packages/a/src/a.ts"] }] };
      }),
    };
    const value = input({
      task: { ...input().task, gates: [...input().task.gates, { gateId: "gate-semantic", description: "Implementation matches objective", type: "SEMANTIC" }] },
    });
    const result = await new ClosureVerifier(semantic).verify(value, DEFAULT_CONFIGURATION.closure);
    expect(result.decision).toBe("PASS");
    expect(result.gateResults.at(-1)).toMatchObject({ gateId: "gate-semantic", status: "SATISFIED" });
  });

  it("turns semantic failure or uncertainty into correction or ASK_USER", async () => {
    const value = input({
      task: { ...input().task, gates: [...input().task.gates, { gateId: "gate-semantic", description: "Matches intent", type: "SEMANTIC" }] },
    });
    const failed: SemanticClosurePort = {
      available: true,
      verify: async () => ({ gateResults: [{ gateId: "gate-semantic", status: "UNSATISFIED", reasonCodes: ["INTENT_MISMATCH"], evidenceRefs: [] }] }),
    };
    expect((await new ClosureVerifier(failed).verify(value, DEFAULT_CONFIGURATION.closure)).decision).toBe("RETRY_WITH_CORRECTION");
    const unknown: SemanticClosurePort = {
      available: true,
      verify: async () => ({ gateResults: [{ gateId: "gate-semantic", status: "UNKNOWN", reasonCodes: ["EVIDENCE_AMBIGUOUS"], evidenceRefs: [] }] }),
    };
    expect((await new ClosureVerifier(unknown).verify(value, DEFAULT_CONFIGURATION.closure)).decision).toBe("ASK_USER");
    expect((await new ClosureVerifier().verify(value, DEFAULT_CONFIGURATION.closure)).reasonCodes).toEqual(["SEMANTIC_VERIFICATION_UNAVAILABLE"]);
  });

  it("rejects semantic requirement expansion and fails safely on timeout", async () => {
    const value = input({
      task: { ...input().task, gates: [...input().task.gates, { gateId: "gate-semantic", description: "Matches intent", type: "SEMANTIC" }] },
    });
    const expanding: SemanticClosurePort = {
      available: true,
      verify: async () => ({ gateResults: [{ gateId: "new-requirement", status: "SATISFIED", reasonCodes: ["MODEL_ADDED_GATE"], evidenceRefs: [] }] }),
    };
    const expanded = await new ClosureVerifier(expanding).verify(value, DEFAULT_CONFIGURATION.closure);
    expect(expanded).toMatchObject({ decision: "ASK_USER", reasonCodes: ["SEMANTIC_VERIFICATION_FAILED"] });
    expect(expanded.gateResults.map((gate) => gate.gateId)).not.toContain("new-requirement");

    let signal: AbortSignal | undefined;
    const hanging: SemanticClosurePort = {
      available: true,
      verify: async (request) => {
        signal = request.signal;
        return await new Promise(() => undefined);
      },
    };
    const timed = await new ClosureVerifier(hanging).verify(value, {
      ...DEFAULT_CONFIGURATION.closure, semanticVerificationDeadlineMs: 10,
    });
    expect(timed).toMatchObject({ decision: "ASK_USER", reasonCodes: ["SEMANTIC_VERIFICATION_TIMEOUT"] });
    expect(signal?.aborted).toBe(true);
  });

  it("validates versioned result schema and rejects invalid or duplicated task IDs", async () => {
    expect(parseClosureVerificationResult({ schemaVersion: 2 })).toMatchObject({
      ok: false, error: { code: "UNSUPPORTED_SCHEMA_VERSION", schema: "closure-verification-result" },
    });
    await expect(new ClosureVerifier().verify(input({ verificationId: "bad id" }), DEFAULT_CONFIGURATION.closure)).rejects.toThrow("metadata");
    const base = input();
    await expect(new ClosureVerifier().verify(input({
      task: { ...base.task, gates: [base.task.gates[0]!, base.task.gates[0]!] },
    }), DEFAULT_CONFIGURATION.closure)).rejects.toThrow("IDs");
    await expect(new ClosureVerifier().verify(input({
      contextEnvelope: { ...contextEnvelope, taskId: "task-other" },
    }), DEFAULT_CONFIGURATION.closure)).rejects.toThrow("metadata");
    await expect(new ClosureVerifier().verify(input({
      diff: { changedPaths: ["secrets/../allowed.txt"], summary: "non-canonical" },
    }), DEFAULT_CONFIGURATION.closure)).rejects.toThrow("paths");
  });
});
