import { performance } from "node:perf_hooks";

import type { ClosurePolicy } from "@zhiloop/config";
import type { ClosureVerificationResult } from "@zhiloop/domain";

import type {
  ContinuationCounterStore,
  StopClosurePort,
  StopContextDeltaPort,
  StopContinuationOptions,
  StopContinuationRequest,
  StopContinuationResult,
} from "./types.js";

class StopDeadlineError extends Error {}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\0\r\n]/u.test(value);
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return value.replace(/[\0\r\n]/gu, " ").slice(0, 500);
}

async function deadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (timeoutMs < 1) throw new StopDeadlineError("Stop Hook deadline exhausted");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      const error = new StopDeadlineError("Stop Hook operation timed out");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } catch (error) {
    if (expired || controller.signal.reason instanceof StopDeadlineError) throw new StopDeadlineError("Stop Hook operation timed out");
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function correctionReason(result: ClosureVerificationResult, request: StopContinuationRequest): string {
  const gates = new Map(request.closureInput.task.gates.map((gate) => [gate.gateId, gate.description]));
  const boundaries = new Map(request.closureInput.task.boundaries.map((item) => [item.boundaryId, item.pathPrefix]));
  return [
    "Continue only to correct the declared unmet gates or boundaries. Do not expand the original task.",
    JSON.stringify({
      closureVerificationId: result.verificationId,
      unmetGates: result.unmetGateIds.map((gateId) => ({ gateId, description: gates.get(gateId) })),
      violatedBoundaries: result.violatedBoundaryIds.map((boundaryId) => ({ boundaryId, pathPrefix: boundaries.get(boundaryId) })),
      reasonCodes: result.reasonCodes,
    }),
  ].join("\n");
}

function contextReason(
  result: ClosureVerificationResult,
  delta: Awaited<ReturnType<StopContextDeltaPort["load"]>>,
): string {
  return [
    "Continue using only this requested knowledge delta. Do not repeat completed work or expand the original task.",
    JSON.stringify({
      closureVerificationId: result.verificationId,
      retrievalTraceId: delta.traceId,
      requestedKnowledgeIds: result.missingKnowledgeIds,
      knowledgeDelta: delta.items,
    }),
  ].join("\n");
}

function validInput(request: StopContinuationRequest): boolean {
  const hook = request.hook;
  return hook.hook_event_name === "Stop" && validText(hook.session_id, 500)
    && validText(hook.turn_id, 500) && validText(hook.cwd, 4_096)
    && (hook.last_assistant_message === null
      || (typeof hook.last_assistant_message === "string" && hook.last_assistant_message.length <= 100_000 && !/[\0]/u.test(hook.last_assistant_message)))
    && request.closureInput.task.taskId === hook.turn_id;
}

function validVerification(result: ClosureVerificationResult, request: StopContinuationRequest): boolean {
  const gateIds = request.closureInput.task.gates.map((item) => item.gateId);
  const boundaryIds = request.closureInput.task.boundaries.map((item) => item.boundaryId);
  const knowledgeIds = request.closureInput.task.requiredKnowledge.map((item) => item.knowledgeId);
  const resultGateIds = result.gateResults.map((item) => item.gateId);
  const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;
  const actualUnmet = result.gateResults.filter((item) => item.status === "UNSATISFIED").map((item) => item.gateId);
  const targetShapeValid = (() => {
    switch (result.decision) {
      case "PASS":
        return result.missingKnowledgeIds.length === 0 && actualUnmet.length === 0
          && result.violatedBoundaryIds.length === 0 && result.gateResults.every((item) => item.status === "SATISFIED");
      case "RETRY_WITH_CONTEXT":
        return result.missingKnowledgeIds.length > 0 && actualUnmet.length === 0 && result.violatedBoundaryIds.length === 0;
      case "RETRY_WITH_CORRECTION":
        return result.missingKnowledgeIds.length === 0
          && (result.unmetGateIds.length > 0 || result.violatedBoundaryIds.length > 0);
      case "ASK_USER":
        return true;
    }
  })();
  return result.verificationId === request.closureInput.verificationId
    && result.taskId === request.closureInput.task.taskId
    && unique(resultGateIds) && unique(result.missingKnowledgeIds) && unique(result.unmetGateIds)
    && unique(result.violatedBoundaryIds)
    && resultGateIds.length === gateIds.length && gateIds.every((id) => resultGateIds.includes(id))
    && result.missingKnowledgeIds.every((id) => knowledgeIds.includes(id))
    && result.unmetGateIds.every((id) => gateIds.includes(id))
    && result.violatedBoundaryIds.every((id) => boundaryIds.includes(id))
    && result.unmetGateIds.length === actualUnmet.length && actualUnmet.every((id) => result.unmetGateIds.includes(id))
    && targetShapeValid;
}

export class StopContinuationService {
  constructor(
    private readonly deterministic: StopClosurePort,
    private readonly semantic: StopClosurePort | undefined,
    private readonly contextDelta: StopContextDeltaPort,
    private readonly counters: ContinuationCounterStore,
    private readonly policy: ClosurePolicy,
    private readonly options: StopContinuationOptions,
  ) {
    if (!Number.isSafeInteger(options.outerHookTimeoutMs) || options.outerHookTimeoutMs < 1
      || options.outerHookTimeoutMs > 600_000) throw new Error("outerHookTimeoutMs is invalid");
  }

  async handle(request: StopContinuationRequest): Promise<StopContinuationResult> {
    const key = JSON.stringify([request.hook.session_id, request.hook.turn_id]);
    const count = this.counters.get(key);
    if (!validInput(request)) return { status: "INVALID_INPUT", continuationCount: count };
    if (request.hook.stop_hook_active) return { status: "HOOK_ALREADY_ACTIVE", continuationCount: count };
    const maximum = request.risk === "HIGH" ? this.policy.highRiskMaxContinuations : this.policy.defaultMaxContinuations;
    if (count >= maximum) return { status: "LIMIT_REACHED", continuationCount: count };
    const startedAt = performance.now();
    const remaining = (): number => Math.floor(this.options.outerHookTimeoutMs - (performance.now() - startedAt));
    try {
      let verification = await deadline(
        (signal) => this.deterministic.verify(request.closureInput, this.policy, signal),
        Math.min(this.policy.deterministicDeadlineMs, remaining()),
      );
      if (!validVerification(verification, request)) throw new Error("closure verifier returned expanded or mismatched targets");
      if (verification.decision === "ASK_USER" && verification.reasonCodes.includes("SEMANTIC_VERIFICATION_UNAVAILABLE")
        && this.semantic !== undefined) {
        verification = await deadline(
          (signal) => this.semantic?.verify(request.closureInput, this.policy, signal) as Promise<ClosureVerificationResult>,
          Math.min(this.policy.semanticVerificationDeadlineMs, remaining()),
        );
        if (!validVerification(verification, request)) throw new Error("semantic closure verifier returned expanded or mismatched targets");
      }
      if (verification.decision === "PASS") return { status: "PASS", decision: "PASS", continuationCount: count };
      if (verification.decision === "ASK_USER") return { status: "ASK_USER", decision: "ASK_USER", continuationCount: count };

      let reason: string;
      let status: StopContinuationResult["status"];
      if (verification.decision === "RETRY_WITH_CONTEXT") {
        const delta = await deadline(
          (signal) => this.contextDelta.load(verification.missingKnowledgeIds, signal), remaining(),
        );
        if (!validText(delta.traceId, 500)) throw new Error("context delta traceId is invalid");
        const returnedIds = delta.items.map((item) => item.id);
        const returned = new Set(returnedIds);
        if (verification.missingKnowledgeIds.length === 0
          || returned.size !== returnedIds.length
          || verification.missingKnowledgeIds.some((id) => !returned.has(id))
          || delta.items.some((item) => !verification.missingKnowledgeIds.includes(item.id))) {
          throw new Error("context delta does not exactly cover requested knowledge IDs");
        }
        reason = contextReason(verification, delta);
        status = "CONTINUED_WITH_CONTEXT";
      } else {
        if (verification.unmetGateIds.length === 0 && verification.violatedBoundaryIds.length === 0) {
          throw new Error("correction decision contains no declared correction target");
        }
        reason = correctionReason(verification, request);
        status = "CONTINUED_WITH_CORRECTION";
      }
      if (!this.counters.claim(key, maximum)) return { status: "LIMIT_REACHED", decision: verification.decision, continuationCount: this.counters.get(key) };
      return {
        status, decision: verification.decision, continuationCount: this.counters.get(key),
        output: { decision: "block", reason },
      };
    } catch (error) {
      return { status: "UNKNOWN", continuationCount: this.counters.get(key), diagnostic: safeError(error) };
    }
  }
}

export function serializeStopHookResult(result: StopContinuationResult): string {
  return JSON.stringify(result.output ?? {});
}
