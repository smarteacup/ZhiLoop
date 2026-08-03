import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  ActiveClosureRuntime,
  ActiveKnowledgeInjectionRuntime,
  KnowledgeFeedbackRuntime,
  SqliteActiveClosureOperationStore,
  VersionedKnowledgeMcpRuntime,
  type ActiveClosureResult,
  type ActiveKnowledgeRetrievalPort,
  type ClosureInteractionInput,
  type KnowledgeEligibilityInspection,
  type KnowledgeEligibilityPort,
  type McpExpansionResult,
  type RuntimeAuditStorePort,
  type VersionedMcpRequest,
} from "@zhiloop/active-knowledge-runtime";
import type { ActiveRolloutService, RolloutRequestScope } from "@zhiloop/active-rollout-service";
import {
  InjectionRolloutController,
  type UserPromptInjectionResult,
  type UserPromptSubmitInput,
} from "@zhiloop/codex-context-injection";
import { DEFAULT_CONFIGURATION, type ClosurePolicy, type InjectionPolicy, type VerificationPolicy } from "@zhiloop/config";
import {
  ConfirmationWritebackService,
  SqliteConfirmationWritebackRepository,
  type ConfirmationEffectPort,
} from "@zhiloop/confirmation-writeback";
import type { ClosureVerificationInput, SemanticClosurePort } from "@zhiloop/closure-verifier";
import type { ContextOrchestratorPort } from "@zhiloop/context-orchestrator";
import type { KnowledgeAsset, KnowledgeScope, TaskContractBlock } from "@zhiloop/domain";
import { SqliteFeedbackStore } from "@zhiloop/feedback-engine";
import { KnowledgeMcpService, type KnowledgeMcpBackend } from "@zhiloop/knowledge-mcp";
import type { QueryContext } from "@zhiloop/query-context";
import { SqliteRuntimeAuditStore, type ClosureRunRecord } from "@zhiloop/runtime-audit-store";
import type { StopContextDeltaPort, StopHookInput, StopContinuationResult } from "@zhiloop/stop-continuation";

import type { P2ProductionComposition } from "./p2-production.js";

const ELIGIBLE = new Set(["ACCEPTED", "IMPLEMENTED", "VERIFIED"]);
const MAX_RELATED_SCAN = 1_000;

export interface P4AuthoritativeContextPort {
  scopeForHook(input: UserPromptSubmitInput): RolloutRequestScope | Promise<RolloutRequestScope>;
  authorizeMcp(requested: QueryContext, signal: AbortSignal): QueryContext | Promise<QueryContext>;
}

export interface P4ExplicitClosureEvidence {
  readonly closureInput?: ClosureVerificationInput;
  readonly present: {
    readonly taskContract: boolean;
    readonly diff: boolean;
    readonly tests: boolean;
    readonly toolResults: boolean;
  };
  readonly interaction: ClosureInteractionInput;
  readonly risk?: "LOW" | "MEDIUM" | "HIGH";
}

export interface P4ClosureEvidencePort {
  load(input: StopHookInput, signal: AbortSignal): Promise<P4ExplicitClosureEvidence>;
}

export interface P4ActiveSidecarDependencies {
  readonly stateDirectory: string;
  readonly p2: Pick<P2ProductionComposition, "registry">;
  readonly retrieval: ActiveKnowledgeRetrievalPort;
  readonly orchestrator: ContextOrchestratorPort;
  readonly rollout: ActiveRolloutService;
  readonly authority: P4AuthoritativeContextPort;
  readonly captureUserPrompt: (input: UserPromptSubmitInput) => void | Promise<void>;
  readonly closureEvidence: P4ClosureEvidencePort;
  readonly contextDelta: StopContextDeltaPort;
  readonly confirmationEffects: ConfirmationEffectPort;
  readonly injectionPolicy?: () => InjectionPolicy;
  readonly closurePolicy?: ClosurePolicy;
  readonly verificationPolicy?: VerificationPolicy;
  readonly semanticClosure?: SemanticClosurePort;
  readonly userPromptDeadlineMs?: number;
  readonly stopDeadlineMs?: number;
  readonly mcpTimeoutMs?: number;
  readonly now?: () => Date;
}

export interface P4ActiveCapabilities {
  readonly injection: { readonly status: "READY"; readonly mode: "SHADOW" | "ACTIVE"; readonly reasonCode: string };
  readonly mcp: { readonly status: "READY"; readonly reasonCode: "MCP_LOCAL_VERSIONED_READY" };
  readonly closure: { readonly status: "READY"; readonly reasonCode: "STOP_EXPLICIT_EVIDENCE_READY" };
  readonly feedback: { readonly status: "READY"; readonly reasonCode: "FEEDBACK_ELIGIBILITY_GATED" };
}

export type P4ActiveHookResult =
  | {
    readonly hookEventName: "UserPromptSubmit";
    readonly captureCompleted: boolean;
    readonly status: "DISABLED" | "SHADOWED" | "INJECTED" | "NO_CONTEXT" | "ROLLED_BACK" | "TIMEOUT" | "ERROR" | "INVALID_INPUT";
    /** Real persisted delivery-attempt identity; absent when retrieval never reached PENDING persistence. */
    readonly attemptId?: string;
    /** True only when a prior Hook transport ACK is already durably present. */
    readonly deliveryAcknowledged?: boolean;
    readonly hookOutput?: string;
    readonly diagnostic?: string;
  }
  | {
    readonly hookEventName: "Stop";
    readonly status: StopContinuationResult["status"];
    readonly decision?: "PASS" | "RETRY_WITH_CONTEXT" | "RETRY_WITH_CORRECTION" | "ASK_USER";
    readonly hookOutput?: string;
    readonly missingEvidence?: readonly ("TASK_CONTRACT" | "DIFF" | "TESTS" | "TOOL_RESULTS")[];
    readonly audit?: ClosureRunRecord;
    readonly diagnostic?: string;
  };

export interface P4ConsoleDependencies {
  readonly audits: RuntimeAuditStorePort;
  readonly feedback: SqliteFeedbackStore;
  readonly confirmations: SqliteConfirmationWritebackRepository;
  readonly rollout: ActiveRolloutService;
}

export type P4AbortSignal = Parameters<VersionedKnowledgeMcpRuntime["handle"]>[1];

function digest(prefix: string, value: unknown): string {
  return `${prefix}-${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32)}`;
}

function scopeKey(context: QueryContext): string {
  if (context.taskId !== undefined) return JSON.stringify({
    level: "TASK",
    ...(context.project === undefined ? {} : { projectId: context.project.projectId }),
    taskId: context.taskId,
  });
  return context.project === undefined
    ? JSON.stringify({ level: "GLOBAL" })
    : JSON.stringify({ level: "PROJECT", projectId: context.project.projectId });
}

function parseScopeKey(value: string): { readonly projectId?: string; readonly taskId?: string; readonly anchored: boolean } {
  try {
    const parsed = JSON.parse(value) as { readonly level?: unknown; readonly projectId?: unknown; readonly taskId?: unknown };
    const projectId = typeof parsed.projectId === "string" ? parsed.projectId : undefined;
    const taskId = typeof parsed.taskId === "string" ? parsed.taskId : undefined;
    return { ...(projectId === undefined ? {} : { projectId }), ...(taskId === undefined ? {} : { taskId }), anchored: projectId !== undefined };
  } catch {
    return { anchored: false };
  }
}

function scopeMatches(scope: KnowledgeScope, key: string): boolean {
  const context = parseScopeKey(key);
  switch (scope.level) {
    case "GLOBAL": return context.anchored;
    case "PROJECT": case "MODULE": case "SYMBOL": return context.projectId !== undefined && scope.projectId === context.projectId;
    case "TASK": return context.taskId !== undefined && scope.taskId === context.taskId
      && (scope.projectId === undefined || scope.projectId === context.projectId);
    case "USER": case "TEAM": return false;
  }
}

function evidenceEligible(asset: KnowledgeAsset): boolean {
  return asset.evidence.some((item) => item.verdict === "SUPPORTS")
    && !asset.evidence.some((item) => item.verdict === "CONTRADICTS");
}

function assertAuthoritativeScope(context: QueryContext, authority: RolloutRequestScope): void {
  if (authority.sessionId.trim().length === 0 || authority.turnId.trim().length === 0) throw new Error("authoritative Hook identity is invalid");
  const projectId = context.project?.projectId;
  if (projectId !== authority.projectId || context.taskId !== authority.taskId
    || context.retrievalBoundary.projectId !== authority.projectId
    || context.retrievalBoundary.taskId !== authority.taskId) {
    throw new Error("retrieval QueryContext does not match authoritative Hook scope");
  }
}

function asUserPromptResult(
  status: "DISABLED" | "SHADOWED" | "INJECTED" | "NO_CONTEXT" | "ROLLED_BACK" | "TIMEOUT" | "ERROR" | "INVALID_INPUT",
  traceId?: string,
  runId?: string,
): UserPromptInjectionResult {
  const mapped = status === "ERROR" ? "PROVIDER_ERROR" : status;
  return {
    status: mapped as UserPromptInjectionResult["status"], elapsedMs: 0,
    ...(traceId === undefined ? {} : { traceId }), ...(runId === undefined ? {} : { runId }),
  };
}

function hasActualAdditionalContext(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    const parsed = JSON.parse(value) as { readonly hookSpecificOutput?: { readonly additionalContext?: unknown } };
    return typeof parsed.hookSpecificOutput?.additionalContext === "string"
      && parsed.hookSpecificOutput.additionalContext.trim().length > 0;
  } catch { return false; }
}

function missingEvidence(value: P4ExplicitClosureEvidence): readonly ("TASK_CONTRACT" | "DIFF" | "TESTS" | "TOOL_RESULTS")[] {
  return [
    ...(!value.present.taskContract || value.closureInput?.contextEnvelope.taskContract === undefined ? ["TASK_CONTRACT" as const] : []),
    ...(!value.present.diff ? ["DIFF" as const] : []),
    ...(!value.present.tests ? ["TESTS" as const] : []),
    ...(!value.present.toolResults ? ["TOOL_RESULTS" as const] : []),
  ];
}

class RegistryEligibility implements KnowledgeEligibilityPort {
  constructor(
    private readonly registry: P2ProductionComposition["registry"],
    private readonly feedback: SqliteFeedbackStore,
  ) {}

  inspect(request: { readonly assetId: string; readonly version?: number; readonly scopeKey: string }): KnowledgeEligibilityInspection {
    const projected = this.registry.getAsset(request.assetId, true);
    const asset = projected?.asset;
    const current = asset !== undefined && (request.version === undefined || request.version === asset.version);
    const feedbackSuppressed = this.feedback.profile(request.scopeKey).suppressedAssetIds.includes(request.assetId);
    return {
      exists: asset !== undefined,
      ...(asset === undefined ? {} : { currentVersion: asset.version }),
      current,
      scopeMatched: asset !== undefined && scopeMatches(asset.scope, request.scopeKey),
      statusEligible: asset !== undefined && ELIGIBLE.has(asset.status) && evidenceEligible(asset),
      suppressed: projected?.tombstone === true || feedbackSuppressed,
    };
  }
}

class RegistryMcpBackend implements KnowledgeMcpBackend {
  constructor(
    private readonly registry: P2ProductionComposition["registry"],
    private readonly eligibility: RegistryEligibility,
  ) {}

  #eligible(context: QueryContext, assets: readonly KnowledgeAsset[]): readonly KnowledgeAsset[] {
    const key = scopeKey(context);
    return assets.filter((asset) => {
      const check = this.eligibility.inspect({ assetId: asset.id, version: asset.version, scopeKey: key });
      return check.exists && check.current && check.scopeMatched && check.statusEligible && !check.suppressed;
    });
  }

  async search(request: Parameters<KnowledgeMcpBackend["search"]>[0]) {
    const assets = this.registry.search(request.query, { limit: request.limit }).map((item) => item.asset);
    return { traceId: digest("trace-mcp-search", [request.query, scopeKey(request.context)]), assets: this.#eligible(request.context, assets) };
  }

  async current(request: Parameters<KnowledgeMcpBackend["current"]>[0]) {
    const assets = request.assetIds.flatMap((id) => {
      const current = this.registry.getAsset(id);
      return current === undefined ? [] : [current.asset];
    });
    return { traceId: digest("trace-mcp-current", [request.assetIds, scopeKey(request.context)]), assets: this.#eligible(request.context, assets) };
  }

  async related(request: Parameters<KnowledgeMcpBackend["related"]>[0]) {
    const ids = new Set<string>();
    for (const seedId of request.seedAssetIds) {
      const seed = this.registry.getAsset(seedId);
      if (seed !== undefined) for (const relation of this.registry.getRelations(seedId, seed.asset.version).relations) ids.add(relation.targetId);
    }
    for (const candidate of this.registry.listAssets({ limit: MAX_RELATED_SCAN })) {
      const relations = this.registry.getRelations(candidate.asset.id, candidate.asset.version).relations;
      if (relations.some((relation) => request.seedAssetIds.includes(relation.targetId))) ids.add(candidate.asset.id);
    }
    request.seedAssetIds.forEach((id) => ids.delete(id));
    const assets = [...ids].slice(0, request.limit).flatMap((id) => {
      const current = this.registry.getAsset(id);
      return current === undefined ? [] : [current.asset];
    });
    return { traceId: digest("trace-mcp-related", [request.seedAssetIds, scopeKey(request.context)]), assets: this.#eligible(request.context, assets) };
  }
}

export class P4ActiveSidecarRuntime {
  readonly #dependencies: P4ActiveSidecarDependencies;
  readonly #now: () => Date;
  readonly #audits: SqliteRuntimeAuditStore;
  readonly #feedback: SqliteFeedbackStore;
  readonly #operations: SqliteActiveClosureOperationStore;
  readonly #confirmations: SqliteConfirmationWritebackRepository;
  readonly #eligibility: RegistryEligibility;
  readonly #mcp: VersionedKnowledgeMcpRuntime;
  readonly #closure: ActiveClosureRuntime;
  #closed = false;

  private constructor(dependencies: P4ActiveSidecarDependencies) {
    this.#dependencies = dependencies;
    this.#now = dependencies.now ?? (() => new Date());
    this.#audits = new SqliteRuntimeAuditStore(join(dependencies.stateDirectory, "p4-runtime-audit.sqlite"));
    this.#feedback = new SqliteFeedbackStore(join(dependencies.stateDirectory, "p4-feedback.sqlite"));
    this.#operations = new SqliteActiveClosureOperationStore(join(dependencies.stateDirectory, "p4-closure-operations.sqlite"));
    this.#confirmations = new SqliteConfirmationWritebackRepository(join(dependencies.stateDirectory, "p4-confirmations.sqlite"));
    this.#eligibility = new RegistryEligibility(dependencies.p2.registry, this.#feedback);
    const mcpService = new KnowledgeMcpService(new RegistryMcpBackend(dependencies.p2.registry, this.#eligibility));
    this.#mcp = new VersionedKnowledgeMcpRuntime({
      service: mcpService,
      contextAuthority: { authorize: async (requested, signal) => await dependencies.authority.authorizeMcp(requested, signal) },
      audits: this.#audits,
      feedback: this.#feedback,
      eligibility: this.#eligibility,
      now: this.#now,
      ...(dependencies.mcpTimeoutMs === undefined ? {} : { timeoutMs: dependencies.mcpTimeoutMs }),
    });
    const writeback = new ConfirmationWritebackService(this.#confirmations, dependencies.confirmationEffects, { effectDeadlineMs: 5_000 });
    this.#closure = new ActiveClosureRuntime({
      audits: this.#audits,
      operations: this.#operations,
      confirmations: this.#confirmations,
      confirmationWriteback: writeback,
      closurePolicy: dependencies.closurePolicy ?? structuredClone(DEFAULT_CONFIGURATION.closure),
      verificationPolicy: dependencies.verificationPolicy ?? structuredClone(DEFAULT_CONFIGURATION.verification),
      contextDelta: dependencies.contextDelta,
      ...(dependencies.semanticClosure === undefined ? {} : { semantic: dependencies.semanticClosure }),
      outerHookTimeoutMs: dependencies.stopDeadlineMs ?? 5_000,
      now: this.#now,
    });
  }

  static async create(dependencies: P4ActiveSidecarDependencies): Promise<P4ActiveSidecarRuntime> {
    const deadline = dependencies.userPromptDeadlineMs ?? 500;
    if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 500) throw new Error("UserPrompt deadline must be within 1..500ms");
    await mkdir(dependencies.stateDirectory, { recursive: true, mode: 0o700 });
    return new P4ActiveSidecarRuntime(dependencies);
  }

  capabilities(): P4ActiveCapabilities {
    this.#assertOpen();
    const decision = this.#dependencies.rollout.state.effective.mode;
    return Object.freeze({
      injection: { status: "READY" as const, mode: decision, reasonCode: decision === "ACTIVE" ? "SCOPED_ACTIVE_READY" : "SHADOW_READY" },
      mcp: { status: "READY" as const, reasonCode: "MCP_LOCAL_VERSIONED_READY" as const },
      closure: { status: "READY" as const, reasonCode: "STOP_EXPLICIT_EVIDENCE_READY" as const },
      feedback: { status: "READY" as const, reasonCode: "FEEDBACK_ELIGIBILITY_GATED" as const },
    });
  }

  consoleDependencies(): P4ConsoleDependencies {
    this.#assertOpen();
    return Object.freeze({ audits: this.#audits, feedback: this.#feedback, confirmations: this.#confirmations, rollout: this.#dependencies.rollout });
  }

  feedbackRuntime(): KnowledgeFeedbackRuntime {
    this.#assertOpen();
    return new KnowledgeFeedbackRuntime({ store: this.#feedback, eligibility: this.#eligibility });
  }

  async inspectKnowledgeEligibility(request: {
    readonly assetId: string;
    readonly version: number;
    readonly scopeKey: string;
    readonly signal?: AbortSignal;
  }): Promise<KnowledgeEligibilityInspection> {
    this.#assertOpen();
    const signal = request.signal ?? new AbortController().signal;
    if (signal.aborted) throw signal.reason;
    const result = this.#eligibility.inspect({
      assetId: request.assetId,
      version: request.version,
      scopeKey: request.scopeKey,
    });
    if (signal.aborted) throw signal.reason;
    return result;
  }

  async handleHook(input: UserPromptSubmitInput | StopHookInput): Promise<P4ActiveHookResult> {
    this.#assertOpen();
    return input.hook_event_name === "UserPromptSubmit" ? await this.#handleUserPrompt(input) : await this.#handleStop(input);
  }

  async handleMcp(request: VersionedMcpRequest, signal?: P4AbortSignal): Promise<McpExpansionResult> {
    this.#assertOpen();
    return await this.#mcp.handle(request, signal ?? new AbortController().signal);
  }

  acknowledgeDelivery(request: {
    readonly attemptId: string;
    readonly expectedRevision: number;
    readonly deliveryEvidenceRef: string;
    readonly deliveredAt: string;
  }) {
    this.#assertOpen();
    return this.#audits.acknowledgeInjectionDelivery(
      request.attemptId,
      request.expectedRevision,
      request.deliveryEvidenceRef,
      request.deliveredAt,
    );
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#operations.close();
    this.#confirmations.close();
    this.#feedback.close();
    this.#audits.close();
  }

  async #handleUserPrompt(input: UserPromptSubmitInput): Promise<P4ActiveHookResult> {
    const deadlineMs = this.#dependencies.userPromptDeadlineMs ?? 500;
    const startedAt = performance.now();
    try {
      await withinRemainingDeadline(
        async () => await this.#dependencies.captureUserPrompt(input),
        deadlineMs - (performance.now() - startedAt),
        "capture",
      );
    } catch (error) {
      const timedOut = error instanceof P4UserPromptDeadlineError;
      return {
        hookEventName: "UserPromptSubmit",
        captureCompleted: false,
        status: timedOut ? "TIMEOUT" : "ERROR",
        diagnostic: `${timedOut ? "CAPTURE_TIMEOUT" : "CAPTURE_FAILED"}:${safeError(error)}`,
      };
    }
    let authority: RolloutRequestScope;
    try {
      authority = await withinRemainingDeadline(
        async () => await this.#dependencies.authority.scopeForHook(input),
        deadlineMs - (performance.now() - startedAt),
        "scope authority",
      );
      if (authority.sessionId !== input.session_id || authority.turnId !== input.turn_id) throw new Error("authoritative Hook identity mismatch");
    } catch (error) {
      const timedOut = error instanceof P4UserPromptDeadlineError;
      return {
        hookEventName: "UserPromptSubmit",
        captureCompleted: true,
        status: timedOut ? "TIMEOUT" : "ERROR",
        diagnostic: `${timedOut ? "SCOPE_AUTHORITY_TIMEOUT" : "SCOPE_AUTHORITY_FAILED"}:${safeError(error)}`,
      };
    }
    let decision;
    try { decision = this.#dependencies.rollout.decision(authority); }
    catch (error) { return { hookEventName: "UserPromptSubmit", captureCompleted: true, status: "ERROR", diagnostic: `ROLLOUT_DECISION_FAILED:${safeError(error)}` }; }
    const controller = decision.mode === "ACTIVE"
      ? this.#dependencies.rollout.injectionRollout
      : shadowController(decision.stateRevision);
    const retrieval: ActiveKnowledgeRetrievalPort = {
      retrieve: async (request, signal) => {
        const result = await this.#dependencies.retrieval.retrieve(request, signal);
        assertAuthoritativeScope(result.queryContext, authority);
        const currentKeys = new Set(result.candidates.flatMap((candidate) => {
          const current = this.#dependencies.p2.registry.getAsset(candidate.asset.id);
          return current !== undefined && current.asset.version === candidate.asset.version
            && current.asset.contentHash === candidate.asset.contentHash
            ? [`${candidate.asset.id}@${candidate.asset.version}:${candidate.asset.contentHash}`] : [];
        }));
        const current = (candidate: { readonly asset: KnowledgeAsset }): boolean => currentKeys.has(
          `${candidate.asset.id}@${candidate.asset.version}:${candidate.asset.contentHash}`,
        );
        return {
          ...result,
          retrieval: { ...result.retrieval, items: result.retrieval.items.filter(current) },
          rerank: { ...result.rerank, items: result.rerank.items.filter(current) },
          candidates: result.candidates.filter(current),
        };
      },
    };
    const runtime = new ActiveKnowledgeInjectionRuntime({
      retrieval,
      orchestrator: this.#dependencies.orchestrator,
      injectionPolicy: this.#dependencies.injectionPolicy ?? (() => structuredClone(DEFAULT_CONFIGURATION.injection)),
      rollout: controller,
      audits: this.#audits,
      eligibility: this.#eligibility,
      feedback: this.#feedback,
      now: this.#now,
      deadlineMs: Math.max(1, Math.min(deadlineMs, Math.floor(deadlineMs - (performance.now() - startedAt)))),
    });
    const result = await runtime.handle(input);
    const terminalStatus = result.status === "PENDING" ? "ERROR" : result.status;
    try {
      this.#dependencies.rollout.observeInjectionResult(
        decision,
        asUserPromptResult(terminalStatus, result.attempt?.traceId, result.attempt?.runId),
        this.#now().toISOString(),
      );
    } catch {
      // Delivery is fail-open; rollout service already forces runtime SHADOW on an unsafe persistence failure.
    }
    if (terminalStatus === "INJECTED" && !hasActualAdditionalContext(result.hookOutput)) {
      return { hookEventName: "UserPromptSubmit", captureCompleted: true, status: "ERROR", diagnostic: "INVALID_INJECTION_RESULT_FAIL_OPEN" };
    }
    return {
      hookEventName: "UserPromptSubmit",
      captureCompleted: true,
      status: terminalStatus,
      ...(result.attempt === undefined ? {} : { attemptId: result.attempt.attemptId }),
      ...(result.attempt?.deliveryEvidenceRef === undefined ? {} : { deliveryAcknowledged: true }),
      ...(terminalStatus === "INJECTED" ? { hookOutput: result.hookOutput } : {}),
      ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
    };
  }

  async #handleStop(input: StopHookInput): Promise<P4ActiveHookResult> {
    if (input.stop_hook_active) {
      return { hookEventName: "Stop", status: "HOOK_ALREADY_ACTIVE", decision: "ASK_USER", diagnostic: "RECURSIVE_STOP_REJECTED" };
    }
    let evidence: P4ExplicitClosureEvidence;
    try { evidence = await boundedLoad(this.#dependencies.closureEvidence, input, this.#dependencies.stopDeadlineMs ?? 5_000); }
    catch (error) { return { hookEventName: "Stop", status: "UNKNOWN", decision: "ASK_USER", diagnostic: `EVIDENCE_UNAVAILABLE:${safeError(error)}` }; }
    const missing = missingEvidence(evidence);
    if (evidence.closureInput === undefined || missing.length > 0) {
      const audit = evidence.closureInput === undefined || evidence.closureInput.contextEnvelope.taskContract === undefined
        ? undefined : this.#recordUnknownClosure(input, evidence.closureInput, missing);
      return { hookEventName: "Stop", status: "UNKNOWN", decision: "ASK_USER", missingEvidence: missing, ...(audit === undefined ? {} : { audit }) };
    }
    try {
      const result: ActiveClosureResult = await this.#closure.handle({
        stop: {
          hook: input,
          closureInput: evidence.closureInput,
          ...(evidence.risk === undefined ? {} : { risk: evidence.risk }),
        },
        interaction: evidence.interaction,
      });
      return {
        hookEventName: "Stop", status: result.stop.status,
        ...(result.stop.decision === undefined ? {} : { decision: result.stop.decision }),
        ...(result.stop.output === undefined ? {} : { hookOutput: JSON.stringify(result.stop.output) }),
        audit: result.audit,
        ...(result.stop.diagnostic === undefined ? {} : { diagnostic: result.stop.diagnostic }),
      };
    } catch (error) {
      return { hookEventName: "Stop", status: "UNKNOWN", decision: "ASK_USER", diagnostic: `CLOSURE_FAILED:${safeError(error)}` };
    }
  }

  #recordUnknownClosure(input: StopHookInput, closure: ClosureVerificationInput, missing: readonly string[]): ClosureRunRecord {
    const taskContract = closure.contextEnvelope.taskContract as TaskContractBlock;
    const closureRunId = digest("closure-missing-evidence", [input.session_id, input.turn_id, closure.verificationId, missing]);
    const existing = this.#audits.getClosure(closureRunId);
    if (existing !== undefined) return existing;
    return this.#audits.recordClosure({
      schemaVersion: 1, closureRunId, sessionId: input.session_id, turnId: input.turn_id,
      taskContract,
      gates: closure.task.gates.map((gate) => ({ gateId: gate.gateId, status: "UNKNOWN", reasonCodes: ["EXPLICIT_EVIDENCE_MISSING"], evidenceRefs: [] })),
      decision: "ASK_USER", continuationCount: 0, recursiveStopRejected: false,
      interaction: { required: true, question: "闭环证据不完整，是否按安全默认结束？", safeDefault: "STOP_WITHOUT_EXPANSION" },
      createdAt: this.#now().toISOString(),
    });
  }

  #assertOpen(): void { if (this.#closed) throw new Error("P4 active Sidecar runtime is closed"); }
}

function shadowController(revision: number): InjectionRolloutController {
  const controller = new InjectionRolloutController();
  controller.activate(Math.max(1, revision), "SHADOW");
  return controller;
}

class P4UserPromptDeadlineError extends Error {
  override readonly name = "P4UserPromptDeadlineError";
}

async function withinRemainingDeadline<T>(operation: () => T | Promise<T>, remainingMs: number, label: string): Promise<T> {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new P4UserPromptDeadlineError(`${label} started after the UserPrompt deadline`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new P4UserPromptDeadlineError(`${label} exceeded the UserPrompt deadline`)), remainingMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function boundedLoad(port: P4ClosureEvidencePort, input: StopHookInput, timeoutMs: number): Promise<P4ExplicitClosureEvidence> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      port.load(input, controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { const error = new Error("closure EvidencePort timed out"); controller.abort(error); reject(error); }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? `${error.name}:${error.message}` : "UnknownError").replace(/[\0\r\n]/gu, " ").slice(0, 300);
}
