import { createHash } from "node:crypto";

import { ClosureVerifier } from "@zhiloop/closure-verifier";
import type { ClosureVerificationResult } from "@zhiloop/domain";
import { closureInteractionTrigger, evaluateInteractionPolicy } from "@zhiloop/interaction-policy";
import { StopContinuationService } from "@zhiloop/stop-continuation";
import type { ContinuationCounterStore, StopClosurePort } from "@zhiloop/stop-continuation";

import type {
  ActiveClosureRequest,
  ActiveClosureResult,
  ActiveClosureOperationOutcome,
  ActiveClosureOperationState,
  ActiveClosureRuntimeDependencies,
  ActiveClosureRuntimePort,
  ClosureVerificationInput,
} from "./types.js";

function identifier(parts: readonly unknown[]): string {
  return `closure-${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("closure request contains an unsupported value");
  return encoded;
}

function operationIdentity(request: ActiveClosureRequest): { readonly identityKey: string; readonly requestHash: string } {
  const identityDigest = createHash("sha256").update(canonical([
    request.stop.hook.session_id,
    request.stop.hook.turn_id,
    request.stop.closureInput.verificationId,
    request.stop.hook.stop_hook_active,
  ])).digest("hex").slice(0, 24);
  const requestHash = createHash("sha256").update(canonical({
    sessionId: request.stop.hook.session_id,
    turnId: request.stop.hook.turn_id,
    cwd: request.stop.hook.cwd,
    stopHookActive: request.stop.hook.stop_hook_active,
    ...(request.stop.risk === undefined ? {} : { risk: request.stop.risk }),
    closureInput: request.stop.closureInput,
    interaction: request.interaction,
  })).digest("hex");
  return { identityKey: `closure-operation-${identityDigest}`, requestHash };
}

function taskContract(input: ClosureVerificationInput) {
  return input.contextEnvelope.taskContract ?? {
    contractId: `contract:${input.task.taskId}`,
    objective: input.task.objective,
    gates: input.task.gates.map((gate) => gate.gateId),
    boundaries: input.task.boundaries.map((boundary) => boundary.boundaryId),
  };
}

function unknownGates(input: ClosureVerificationInput) {
  return input.task.gates.map((gate) => ({
    gateId: gate.gateId,
    status: "UNKNOWN" as const,
    reasonCodes: ["STOP_VERIFICATION_NOT_COMPLETED"],
    evidenceRefs: [],
  }));
}

class CapturingClosurePort implements StopClosurePort {
  result?: ClosureVerificationResult;

  constructor(private readonly verifier: ClosureVerifier) {}

  async verify(
    input: ClosureVerificationInput,
    policy: ActiveClosureRuntimeDependencies["closurePolicy"],
    signal: AbortSignal,
  ): Promise<ClosureVerificationResult> {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("closure verification aborted");
    const result = await this.verifier.verify(input, policy);
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("closure verification aborted");
    this.result = result;
    return result;
  }
}

class AuditBackedContinuationCounter implements ContinuationCounterStore {
  readonly #counts = new Map<string, number>();

  constructor(private readonly audits: ActiveClosureRuntimeDependencies["audits"]) {}

  get(key: string): number {
    const cached = this.#counts.get(key);
    if (cached !== undefined) return cached;
    let sessionId: string;
    let turnId: string;
    try {
      const parsed = JSON.parse(key) as unknown;
      if (!Array.isArray(parsed) || parsed.length !== 2 || !parsed.every((item) => typeof item === "string")) return 0;
      [sessionId, turnId] = parsed as [string, string];
    } catch {
      return 0;
    }
    const persisted = this.audits.listClosures(sessionId, 100).items
      .filter((record) => record.turnId === turnId)
      .reduce((maximum, record) => Math.max(maximum, record.continuationCount), 0);
    this.#counts.set(key, persisted);
    return persisted;
  }

  claim(key: string, maximum: number): boolean {
    const current = this.get(key);
    if (current >= maximum) return false;
    this.#counts.set(key, current + 1);
    return true;
  }
}

export class ActiveClosureRuntime implements ActiveClosureRuntimePort {
  readonly #counters: ContinuationCounterStore;
  readonly #activeOperations = new Set<string>();
  readonly #now: () => Date;

  constructor(private readonly dependencies: ActiveClosureRuntimeDependencies) {
    this.#now = dependencies.now ?? (() => new Date());
    this.#counters = new AuditBackedContinuationCounter(dependencies.audits);
  }

  #publish(
    state: ActiveClosureOperationState,
    identityKey: string,
    requestHash: string,
  ): ActiveClosureResult {
    if (state.outcome === undefined) throw new Error("closure operation has no recoverable outcome");
    const audit = this.dependencies.audits.recordClosure(state.outcome.audit);
    if (state.outcome.confirmation !== undefined) {
      this.dependencies.confirmations.save(
        state.outcome.confirmation.request,
        state.outcome.confirmation.targets,
      );
    }
    this.dependencies.operations.complete(identityKey, requestHash);
    return { stop: state.outcome.stop, audit };
  }

  async handle(request: ActiveClosureRequest): Promise<ActiveClosureResult> {
    const { identityKey, requestHash } = operationIdentity(request);
    const operation = this.dependencies.operations.begin(identityKey, requestHash);
    if (operation.outcome !== undefined) return this.#publish(operation, identityKey, requestHash);
    if (this.#activeOperations.has(identityKey)) throw new Error("closure operation is already in progress");
    this.#activeOperations.add(identityKey);
    try {
      const deterministic = new CapturingClosurePort(new ClosureVerifier());
    const semantic = this.dependencies.semantic === undefined
      ? undefined
      : new CapturingClosurePort(new ClosureVerifier(this.dependencies.semantic));
    const service = new StopContinuationService(
      deterministic,
      semantic,
      this.dependencies.contextDelta,
      this.#counters,
      this.dependencies.closurePolicy,
      { outerHookTimeoutMs: this.dependencies.outerHookTimeoutMs },
    );
    const stop = await service.handle(request.stop);
    const verification = semantic?.result ?? deterministic.result;
    const recursiveStopRejected = stop.status === "HOOK_ALREADY_ACTIVE";
    const triggers = [...(request.interaction.extraTriggers ?? [])];
    if (verification !== undefined) {
      const closureTrigger = closureInteractionTrigger({
        sessionId: request.stop.hook.session_id,
        turnId: request.stop.hook.turn_id,
        turnOrdinal: request.interaction.turnOrdinal,
      }, request.stop.closureInput.finalConclusion.summary, verification);
      if (closureTrigger !== undefined) triggers.push(closureTrigger);
    }
    const interaction = evaluateInteractionPolicy({
      sessionId: request.stop.hook.session_id,
      turnId: request.stop.hook.turn_id,
      turnOrdinal: request.interaction.turnOrdinal,
      now: this.#now().toISOString(),
      triggers,
      history: request.interaction.history,
      policy: this.dependencies.verificationPolicy.interaction,
    });
    const closureRunId = identifier([identityKey, requestHash]);
    const record = {
      schemaVersion: 1 as const,
      closureRunId,
      sessionId: request.stop.hook.session_id,
      turnId: request.stop.hook.turn_id,
      taskContract: taskContract(request.stop.closureInput),
      gates: verification?.gateResults ?? unknownGates(request.stop.closureInput),
      decision: verification?.decision ?? "ASK_USER" as const,
      ...(stop.output === undefined ? {} : { correctionDelta: stop.output.reason.slice(0, 100_000) }),
      continuationCount: stop.continuationCount,
      recursiveStopRejected,
      interaction: {
        required: interaction.action === "ASK_USER",
        ...(interaction.request === undefined ? {} : { question: interaction.request.question }),
        ...(interaction.request === undefined
          ? interaction.defaults[0] === undefined ? {} : { safeDefault: interaction.defaults[0].effect }
          : { safeDefault: interaction.request.safeDefaultOptionId }),
      },
      createdAt: this.#now().toISOString(),
    };
    const confirmation = interaction.request === undefined ? undefined : {
      request: interaction.request,
      targets: interaction.request.subjectIds.map((subjectId) => (
        (request.interaction.targets ?? []).find((target) => target.subjectId === subjectId)
        ?? { subjectId, expectedRevision: `closure:${request.stop.closureInput.verificationId}` }
      )),
    };
    const outcome: ActiveClosureOperationOutcome = {
      stop,
      audit: record,
      ...(confirmation === undefined ? {} : { confirmation }),
    };
      const checkpoint = this.dependencies.operations.saveOutcome(identityKey, requestHash, outcome);
      return this.#publish(checkpoint, identityKey, requestHash);
    } finally {
      this.#activeOperations.delete(identityKey);
    }
  }

  writeback(reply: Parameters<ActiveClosureRuntimeDependencies["confirmationWriteback"]["handle"]>[0]) {
    return this.dependencies.confirmationWriteback.handle(reply);
  }
}
