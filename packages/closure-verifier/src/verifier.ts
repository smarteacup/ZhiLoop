import type { ClosurePolicy } from "@zhiloop/config";
import type { ClosureGateResult, ClosureVerificationResult, ContextComplexityLevel } from "@zhiloop/domain";
import { parseClosureVerificationResult } from "@zhiloop/schemas";

import type { ClosureGate, ClosureVerificationInput, SemanticClosurePort, SemanticClosureResult } from "./types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/u;
const REASON = /^[A-Z][A-Z0-9_]{0,99}$/u;
const LEVEL = new Map<ContextComplexityLevel, number>([
  ["L0_NONE", 0], ["L1_POINTER", 1], ["L2_COMPACT", 2], ["L3_EVIDENCED", 3], ["L4_EPISODE", 4],
]);

class SemanticTimeoutError extends Error {}

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function buildResult(
  input: ClosureVerificationInput,
  decision: ClosureVerificationResult["decision"],
  reasonCodes: readonly string[],
  gateResults: readonly ClosureGateResult[],
  missingKnowledgeIds: readonly string[] = [],
  violatedBoundaryIds: readonly string[] = [],
): ClosureVerificationResult {
  const value: ClosureVerificationResult = {
    schemaVersion: 1, verificationId: input.verificationId, taskId: input.task.taskId,
    decision, reasonCodes: [...new Set(reasonCodes)], missingKnowledgeIds: [...new Set(missingKnowledgeIds)],
    unmetGateIds: gateResults.filter((item) => item.status === "UNSATISFIED").map((item) => item.gateId),
    violatedBoundaryIds: [...new Set(violatedBoundaryIds)],
    gateResults,
  };
  const parsed = parseClosureVerificationResult(value);
  if (!parsed.ok) throw new Error(`ClosureVerificationResult schema failed at ${parsed.error.issues[0]?.instancePath ?? "$"}`);
  return freeze(structuredClone(parsed.value));
}

function validate(input: ClosureVerificationInput): void {
  if (!SAFE_ID.test(input.verificationId) || !SAFE_ID.test(input.task.taskId)
    || input.contextEnvelope.taskId !== input.task.taskId
    || input.task.objective.trim().length === 0 || input.task.objective.length > 5_000
    || input.task.gates.length < 1 || input.task.gates.length > 100
    || input.task.boundaries.length > 100 || input.task.requiredKnowledge.length > 100) throw new Error("closure input metadata is invalid");
  const groups = [
    input.task.gates.map((item) => item.gateId), input.task.boundaries.map((item) => item.boundaryId),
    input.task.requiredKnowledge.map((item) => item.knowledgeId),
  ];
  if (groups.some((ids) => new Set(ids).size !== ids.length || !ids.every((item) => SAFE_ID.test(item)))
    || input.task.gates.some((gate) => gate.description.trim().length === 0 || gate.description.length > 2_000)
    || input.diff.changedPaths.length > 10_000 || input.toolResults.length > 10_000 || input.tests.length > 10_000) {
    throw new Error("closure input IDs or collections are invalid");
  }
  const safePath = (value: string): boolean => typeof value === "string" && value.length > 0 && value.length <= 4_096
    && !value.startsWith("/") && !value.includes("\\") && !value.split("/").some((part) => part === "" || part === "." || part === "..")
    && !/[\0\r\n]/u.test(value);
  if (!input.diff.changedPaths.every(safePath)
    || !input.task.boundaries.every((item) => safePath(item.pathPrefix))
    || !input.task.gates.every((gate) => gate.type !== "PATH_CHANGED" || safePath(gate.path))
    || new Set(input.tests.map((item) => item.testId)).size !== input.tests.length
    || new Set(input.toolResults.map((item) => item.toolCallId)).size !== input.toolResults.length) {
    throw new Error("closure evidence paths or IDs are invalid");
  }
}

function deterministicGate(gate: ClosureGate, input: ClosureVerificationInput): ClosureGateResult {
  let satisfied = false;
  let evidenceRefs: string[] = [];
  switch (gate.type) {
    case "TEST_PASSED": {
      const observed = input.tests.find((item) => item.testId === gate.testId);
      satisfied = observed?.status === "PASSED";
      evidenceRefs = observed === undefined ? [] : [`test:${observed.testId}:${observed.status}`];
      break;
    }
    case "ARTIFACT_PRESENT": {
      const observed = input.toolResults.find((item) => item.status === "SUCCEEDED" && item.artifactIds.includes(gate.artifactId));
      satisfied = observed !== undefined;
      evidenceRefs = observed === undefined ? [] : [`tool:${observed.toolCallId}:artifact:${gate.artifactId}`];
      break;
    }
    case "PATH_CHANGED":
      satisfied = input.diff.changedPaths.includes(gate.path);
      evidenceRefs = satisfied ? [`diff:${gate.path}`] : [];
      break;
    case "TOOL_SUCCEEDED": {
      const observed = input.toolResults.find((item) => item.toolName === gate.toolName && item.status === "SUCCEEDED");
      satisfied = observed !== undefined;
      evidenceRefs = observed === undefined ? [] : [`tool:${observed.toolCallId}:SUCCEEDED`];
      break;
    }
    case "NO_OPEN_ISSUES":
      satisfied = input.finalConclusion.openIssues.length === 0;
      evidenceRefs = satisfied ? ["conclusion:open-issues:none"] : [];
      break;
    case "SEMANTIC":
      return { gateId: gate.gateId, status: "UNKNOWN", reasonCodes: ["SEMANTIC_VERIFICATION_REQUIRED"], evidenceRefs: [] };
  }
  return {
    gateId: gate.gateId, status: satisfied ? "SATISFIED" : "UNSATISFIED",
    reasonCodes: [satisfied ? "DETERMINISTIC_GATE_SATISFIED" : "DETERMINISTIC_GATE_UNSATISFIED"], evidenceRefs,
  };
}

function validateSemantic(value: SemanticClosureResult, gates: readonly ClosureGate[]): readonly ClosureGateResult[] {
  const expected = gates.filter((item) => item.type === "SEMANTIC").map((item) => item.gateId);
  const ids = value.gateResults.map((item) => item.gateId);
  if (ids.length !== expected.length || new Set(ids).size !== ids.length
    || expected.some((id) => !ids.includes(id)) || ids.some((id) => !expected.includes(id))
    || value.gateResults.some((item) => item.reasonCodes.length < 1 || item.reasonCodes.length > 10
      || !item.reasonCodes.every((code) => REASON.test(code)))) {
    throw new Error("semantic verifier expanded requirements or returned invalid results");
  }
  return structuredClone(value.gateResults);
}

async function semanticWithTimeout(
  port: SemanticClosurePort,
  request: Parameters<SemanticClosurePort["verify"]>[0],
  controller: AbortController,
  timeoutMs: number,
): Promise<SemanticClosureResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new SemanticTimeoutError("semantic closure verification timed out");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([port.verify(request), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class ClosureVerifier {
  constructor(private readonly semantic?: SemanticClosurePort) {}

  async verify(input: ClosureVerificationInput, policy: ClosurePolicy): Promise<ClosureVerificationResult> {
    validate(input);
    const gateResults = input.task.gates.map((gate) => deterministicGate(gate, input));
    const boundaryViolations = input.task.boundaries.filter((boundary) => input.diff.changedPaths.some((path) => (
      path === boundary.pathPrefix || path.startsWith(`${boundary.pathPrefix}/`)
    )));
    if (boundaryViolations.length > 0) return buildResult(
      input, "RETRY_WITH_CORRECTION", ["DECLARED_BOUNDARY_VIOLATED"], gateResults, [],
      boundaryViolations.map((item) => item.boundaryId),
    );
    const deterministicFailures = gateResults.filter((item) => item.status === "UNSATISFIED");
    if (deterministicFailures.length > 0) {
      return buildResult(input, "RETRY_WITH_CORRECTION", [
        "DETERMINISTIC_GATE_FAILED",
        ...(!input.finalConclusion.claimedComplete ? ["FINAL_CONCLUSION_INCOMPLETE"] : []),
      ], gateResults);
    }
    if (!input.finalConclusion.claimedComplete) {
      return buildResult(input, "ASK_USER", ["FINAL_CONCLUSION_INCOMPLETE"], gateResults);
    }
    const contextById = new Map(input.contextEnvelope.items.map((item) => [item.id, item]));
    const missingKnowledge = input.task.requiredKnowledge.filter((required) => {
      const item = contextById.get(required.knowledgeId);
      return item === undefined || (LEVEL.get(item.detailLevel) ?? 0) < (LEVEL.get(required.minimumDetailLevel) ?? 0);
    }).map((item) => item.knowledgeId);
    if (missingKnowledge.length > 0) return buildResult(input, "RETRY_WITH_CONTEXT", ["REQUIRED_KNOWLEDGE_MISSING"], gateResults, missingKnowledge);
    const semanticGates = input.task.gates.filter((gate) => gate.type === "SEMANTIC");
    if (semanticGates.length === 0) return buildResult(input, "PASS", ["ALL_DECLARED_GATES_SATISFIED"], gateResults);
    if (this.semantic === undefined || !this.semantic.available) return buildResult(input, "ASK_USER", ["SEMANTIC_VERIFICATION_UNAVAILABLE"], gateResults);

    const controller = new AbortController();
    try {
      const semanticResults = validateSemantic(await semanticWithTimeout(this.semantic, {
        objective: input.task.objective,
        gates: semanticGates.map((gate) => ({ gateId: gate.gateId, description: gate.description })),
        contextEnvelope: structuredClone(input.contextEnvelope), diff: structuredClone(input.diff),
        toolResults: structuredClone(input.toolResults), tests: structuredClone(input.tests),
        finalConclusion: structuredClone(input.finalConclusion), signal: controller.signal,
      }, controller, policy.semanticVerificationDeadlineMs), semanticGates);
      const semanticById = new Map(semanticResults.map((item) => [item.gateId, item]));
      const combined = gateResults.map((item) => semanticById.get(item.gateId) ?? item);
      if (combined.some((item) => item.status === "UNSATISFIED")) return buildResult(input, "RETRY_WITH_CORRECTION", ["SEMANTIC_GATE_FAILED"], combined);
      if (combined.some((item) => item.status === "UNKNOWN")) return buildResult(input, "ASK_USER", ["SEMANTIC_GATE_UNKNOWN"], combined);
      return buildResult(input, "PASS", ["ALL_DECLARED_GATES_SATISFIED"], combined);
    } catch (error) {
      const timedOut = error instanceof SemanticTimeoutError || controller.signal.reason instanceof SemanticTimeoutError;
      if (!controller.signal.aborted) controller.abort(error);
      return buildResult(input, "ASK_USER", [timedOut ? "SEMANTIC_VERIFICATION_TIMEOUT" : "SEMANTIC_VERIFICATION_FAILED"], gateResults);
    }
  }
}
