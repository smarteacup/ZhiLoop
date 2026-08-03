import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type {
  ActiveRolloutService,
  CommitHighRiskRequest,
  HighRiskGovernanceCommand,
  HighRiskGovernancePolicy,
  HighRiskOperationResult,
  HighRiskPreview,
} from "@zhiloop/active-rollout-service";
import { confirmationFingerprint } from "@zhiloop/active-rollout-service";
import type { FeedbackRecordResult, KnowledgeFeedbackRuntime } from "@zhiloop/active-knowledge-runtime";
import { z } from "zod";

import {
  closureDetailRequestSchema,
  closureListRequestSchema,
  feedbackResponseSchema,
  feedbackCommandSchema,
  highRiskCommitResponseSchema,
  highRiskCommitRequestSchema,
  highRiskPreviewResponseSchema,
  highRiskPreviewRequestSchema,
  injectionDetailRequestSchema,
  injectionListRequestSchema,
  mcpExpansionListRequestSchema,
  rolloutStateSchema,
  type CursorPage,
  type InjectionAttemptView,
  type P4Capability,
  type P4FeedbackResponse,
  type P4HighRiskCommitResponse,
  type P4HighRiskPreviewResponse,
  type P4RolloutView,
} from "./contracts.js";
import {
  P4AuditStoreError,
  P4OperationConflictError,
  type AuditPosition,
  type P4OperationStore,
  type RuntimeAuditQueryPort,
} from "./store.js";

interface McpFeedbackPort extends Pick<KnowledgeFeedbackRuntime, "record"> {
  recordUsage(input: {
    readonly usageEventId: string;
    readonly expansionId: string;
    readonly traceId: string;
    readonly assetId: string;
    readonly version: number;
    readonly scopeKey: string;
    readonly occurredAt: string;
  }, signal?: AbortSignal): Promise<"RECORDED" | "EXISTING">;
}

export interface HighRiskConsolePort {
  readonly policy: HighRiskGovernancePolicy;
  preview(command: HighRiskGovernanceCommand, now: string): Promise<HighRiskPreview>;
  getPreview(previewId: string): HighRiskPreview | undefined;
  commit(request: CommitHighRiskRequest): Promise<HighRiskOperationResult>;
}

export interface P4ConsoleRuntimeDependencies {
  readonly cursorSecret: string | Uint8Array;
  readonly audits?: RuntimeAuditQueryPort;
  readonly feedback?: McpFeedbackPort;
  readonly rollout?: Pick<ActiveRolloutService, "state">;
  readonly highRisk?: HighRiskConsolePort;
  /** Authenticated Sidecar principal; never populated from the browser request body. */
  readonly principal?: { readonly actorId: string } | (() => { readonly actorId: string });
  readonly operations?: P4OperationStore;
  /** Production stays disabled unless composition explicitly supplies this independently reviewed gate. */
  readonly allowHighRiskCommands?: boolean;
  readonly now?: () => Date;
}

export type P4ConsoleErrorCode =
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "SCOPE_MISMATCH"
  | "CONFLICT"
  | "CAPABILITY_DISABLED"
  | "TIMEOUT"
  | "STORAGE_UNAVAILABLE"
  | "INTERNAL";

export class P4ConsoleError extends Error {
  override readonly name = "P4ConsoleError";
  constructor(readonly code: P4ConsoleErrorCode, message: string, readonly retryable = false, options?: ErrorOptions) {
    super(message, options);
  }
}

export interface SafeP4Error {
  readonly schemaVersion: 1;
  readonly code: P4ConsoleErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export function mapP4ConsoleError(error: unknown): SafeP4Error {
  if (error instanceof P4ConsoleError) return { schemaVersion: 1, code: error.code, message: error.message, retryable: error.retryable };
  if (error instanceof z.ZodError) return { schemaVersion: 1, code: "INVALID_REQUEST", message: "request failed strict schema validation", retryable: false };
  if (error instanceof P4OperationConflictError) return { schemaVersion: 1, code: "CONFLICT", message: "idempotency or expected revision conflict", retryable: false };
  if (error instanceof P4AuditStoreError) return { schemaVersion: 1, code: "STORAGE_UNAVAILABLE", message: error.message, retryable: true };
  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (lower.includes("stale") || lower.includes("revision") || lower.includes("semantic conflict")) {
      return { schemaVersion: 1, code: "CONFLICT", message: "expected revision or operation identity conflict", retryable: false };
    }
    if (lower.includes("disabled") || lower.includes("not enabled") || lower.includes("ineligible")) {
      return { schemaVersion: 1, code: "CAPABILITY_DISABLED", message: "capability or eligibility gate rejected the operation", retryable: false };
    }
    if (lower.includes("timeout") || lower.includes("timed out")) {
      return { schemaVersion: 1, code: "TIMEOUT", message: "operation exceeded its bounded deadline", retryable: true };
    }
  }
  return { schemaVersion: 1, code: "INTERNAL", message: "P4 console operation failed", retryable: false };
}

interface SignedCursor {
  readonly schemaVersion: 1;
  readonly kind: "INJECTION" | "MCP" | "CLOSURE";
  readonly sessionId: string;
  readonly parentId?: string;
  readonly occurredAt: string;
  readonly id: string;
}

const cursorPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.enum(["INJECTION", "MCP", "CLOSURE"]),
  sessionId: z.string().min(1).max(500),
  parentId: z.string().min(1).max(500).optional(),
  occurredAt: z.iso.datetime({ offset: true }),
  id: z.string().min(1).max(500),
});
const responseSchemas = {
  FEEDBACK: feedbackResponseSchema,
  HIGH_RISK_PREVIEW: highRiskPreviewResponseSchema,
  HIGH_RISK_COMMIT: highRiskCommitResponseSchema,
} as const;
type OperationKind = keyof typeof responseSchemas;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("unsupported request value");
  return encoded;
}

function requestHash(kind: string, value: unknown): string {
  return createHash("sha256").update(canonical({ kind, value }), "utf8").digest("hex");
}

function unique(values: readonly string[]): readonly string[] { return [...new Set(values)].slice(0, 100); }

export class P4ConsoleRuntime {
  readonly #secret: Buffer;
  readonly #now: () => Date;
  readonly #inflight = new Map<string, { readonly hash: string; readonly promise: Promise<unknown> }>();

  constructor(private readonly dependencies: P4ConsoleRuntimeDependencies) {
    this.#secret = Buffer.from(dependencies.cursorSecret);
    if (this.#secret.byteLength < 32) throw new Error("P4 cursor secret must contain at least 32 bytes");
    this.#now = dependencies.now ?? (() => new Date());
  }

  capabilities(): readonly P4Capability[] {
    const audit = this.dependencies.audits === undefined
      ? { state: "NOT_CONFIGURED" as const, reasonCode: "RUNTIME_AUDIT_QUERY_NOT_COMPOSED", evidenceRefs: [] }
      : { state: "READY" as const, reasonCode: "RUNTIME_AUDIT_QUERY_COMPOSED", evidenceRefs: ["dependency:runtime-audit-query"] };
    const feedback = this.dependencies.feedback === undefined
      ? { state: "NOT_CONFIGURED" as const, reasonCode: "ACTIVE_FEEDBACK_RUNTIME_NOT_COMPOSED", evidenceRefs: [] }
      : { state: "READY" as const, reasonCode: "ACTIVE_FEEDBACK_RUNTIME_COMPOSED", evidenceRefs: ["dependency:active-feedback-runtime"] };
    const rollout = this.dependencies.rollout === undefined
      ? { state: "NOT_CONFIGURED" as const, reasonCode: "ACTIVE_ROLLOUT_SERVICE_NOT_COMPOSED", evidenceRefs: [] }
      : { state: "READY" as const, reasonCode: "ACTIVE_ROLLOUT_SERVICE_COMPOSED", evidenceRefs: [`rollout-state:${this.dependencies.rollout.state.stateRevision}`] };
    let highRisk: Omit<P4Capability, "capability">;
    if (this.dependencies.highRisk === undefined) {
      highRisk = { state: "NOT_CONFIGURED", reasonCode: "HIGH_RISK_GOVERNANCE_NOT_COMPOSED", evidenceRefs: [] };
    } else if (this.dependencies.allowHighRiskCommands !== true) {
      highRisk = { state: "DISABLED", reasonCode: "HIGH_RISK_PRODUCTION_DEFAULT_DISABLED", evidenceRefs: [`policy:${this.dependencies.highRisk.policy.revision}`] };
    } else if (!this.dependencies.highRisk.policy.activeStageEnabled) {
      highRisk = { state: "DISABLED", reasonCode: "ACTIVE_STAGE_DISABLED", evidenceRefs: [`policy:${this.dependencies.highRisk.policy.revision}`] };
    } else if (!Object.values(this.dependencies.highRisk.policy.enabledOperations).some(Boolean)) {
      highRisk = { state: "DISABLED", reasonCode: "HIGH_RISK_POLICY_GATES_DISABLED", evidenceRefs: [`policy:${this.dependencies.highRisk.policy.revision}`] };
    } else {
      highRisk = { state: "READY", reasonCode: "HIGH_RISK_GOVERNANCE_COMPOSED_AND_ENABLED", evidenceRefs: [`policy:${this.dependencies.highRisk.policy.revision}`] };
    }
    return Object.freeze([
      { capability: "INJECTION_AUDIT", ...audit },
      { capability: "MCP_AUDIT", ...audit },
      { capability: "CLOSURE_AUDIT", ...audit },
      { capability: "FEEDBACK", ...feedback },
      { capability: "ROLLOUT", ...rollout },
      { capability: "HIGH_RISK_GOVERNANCE", ...highRisk },
    ]);
  }

  listInjections(input: unknown): CursorPage<InjectionAttemptView> {
    const request = injectionListRequestSchema.parse(input);
    const audits = this.#requireAudits();
    const after = request.cursor === undefined ? undefined : this.#decodeCursor(request.cursor, "INJECTION", request.sessionId);
    const page = audits.listInjections(request.sessionId, request.limit, after);
    const items = page.items.map((attempt) => this.#attemptView(attempt));
    return { items, ...(page.hasMore && items.length > 0 ? { nextCursor: this.#cursor("INJECTION", request.sessionId, undefined, items.at(-1)!.createdAt, items.at(-1)!.attemptId) } : {}) };
  }

  getInjection(input: unknown): InjectionAttemptView {
    const request = injectionDetailRequestSchema.parse(input);
    const attempt = this.#requireAudits().getInjection(request.sessionId, request.attemptId);
    if (attempt === undefined) throw new P4ConsoleError("NOT_FOUND", "injection attempt is unavailable in this session");
    return this.#attemptView(attempt);
  }

  listMcpExpansions(input: unknown) {
    const request = mcpExpansionListRequestSchema.parse(input);
    const audits = this.#requireAudits();
    if (audits.getInjection(request.sessionId, request.attemptId) === undefined) {
      throw new P4ConsoleError("NOT_FOUND", "injection attempt is unavailable in this session");
    }
    const after = request.cursor === undefined ? undefined : this.#decodeCursor(request.cursor, "MCP", request.sessionId, request.attemptId);
    const page = audits.listMcpExpansions(request.sessionId, request.attemptId, request.limit, after);
    const last = page.items.at(-1);
    return {
      items: page.items,
      ...(page.hasMore && last !== undefined ? { nextCursor: this.#cursor("MCP", request.sessionId, request.attemptId, last.occurredAt, last.expansionId) } : {}),
    };
  }

  listClosures(input: unknown) {
    const request = closureListRequestSchema.parse(input);
    const after = request.cursor === undefined ? undefined : this.#decodeCursor(request.cursor, "CLOSURE", request.sessionId);
    const page = this.#requireAudits().listClosures(request.sessionId, request.limit, after);
    const last = page.items.at(-1);
    return {
      items: page.items,
      ...(page.hasMore && last !== undefined ? { nextCursor: this.#cursor("CLOSURE", request.sessionId, undefined, last.createdAt, last.closureRunId) } : {}),
    };
  }

  getClosure(input: unknown) {
    const request = closureDetailRequestSchema.parse(input);
    const run = this.#requireAudits().getClosure(request.sessionId, request.closureRunId);
    if (run === undefined) throw new P4ConsoleError("NOT_FOUND", "closure run is unavailable in this session");
    return run;
  }

  rollout(): P4RolloutView {
    const service = this.dependencies.rollout;
    if (service === undefined) throw new P4ConsoleError("CAPABILITY_DISABLED", "rollout service is not composed");
    const state = rolloutStateSchema.parse(structuredClone(service.state)) as typeof service.state;
    return {
      state,
      activeCanary: state.effective.canary,
      downgradeHistory: state.audit.filter((item) => item.kind === "DOWNGRADED"),
      rollbackTarget: state.lastKnownGood,
    };
  }

  async recordFeedback(input: unknown, signal?: AbortSignal): Promise<P4FeedbackResponse> {
    const request = feedbackCommandSchema.parse(input);
    const runtime = this.dependencies.feedback;
    if (runtime === undefined) throw new P4ConsoleError("CAPABILITY_DISABLED", "active feedback runtime is not composed");
    return await this.#idempotent(request.idempotencyKey, "FEEDBACK", request, async () => {
      if (request.action === "MCP_USE") {
        const outcome = await runtime.recordUsage({
          usageEventId: request.idempotencyKey,
          expansionId: request.expansionId,
          traceId: request.traceId,
          assetId: request.assetId,
          version: request.expectedKnowledgeVersion,
          scopeKey: request.scopeKey,
          occurredAt: request.occurredAt,
        }, signal);
        return feedbackResponseSchema.parse({ outcome, eligibleAfterWrite: true });
      }
      const result: FeedbackRecordResult = await runtime.record({
        eventId: request.idempotencyKey,
        assetId: request.assetId,
        scopeKey: request.scopeKey,
        action: request.action,
        traceId: request.traceId,
        actor: request.actor,
        occurredAt: request.occurredAt,
      }, request.expectedKnowledgeVersion, signal);
      return feedbackResponseSchema.parse({ outcome: result.result, eligibleAfterWrite: result.eligibleAfterWrite });
    });
  }

  async previewHighRisk(input: unknown): Promise<P4HighRiskPreviewResponse> {
    const request = highRiskPreviewRequestSchema.parse(input);
    const service = this.#requireHighRisk();
    if (request.expectedPolicyRevision !== service.policy.revision) throw new P4ConsoleError("CONFLICT", "stale high-risk policy revision");
    return await this.#idempotent(request.idempotencyKey, "HIGH_RISK_PREVIEW", request, async () => {
      const preview = await service.preview(request.command, request.occurredAt);
      return { preview, blastRadius: preview.blastRadius, confirmationPhrase: this.#confirmationPhrase(preview) };
    });
  }

  async commitHighRisk(input: unknown): Promise<P4HighRiskCommitResponse> {
    const request = highRiskCommitRequestSchema.parse(input);
    const service = this.#requireHighRisk();
    const actor = this.#actor();
    if (request.expectedPolicyRevision !== service.policy.revision) throw new P4ConsoleError("CONFLICT", "stale high-risk policy revision");
    const preview = service.getPreview(request.previewId);
    if (preview === undefined) throw new P4ConsoleError("NOT_FOUND", "high-risk preview is unavailable");
    if (request.confirmationPhrase !== this.#confirmationPhrase(preview)) {
      throw new P4ConsoleError("INVALID_REQUEST", "typed high-risk confirmation phrase does not match preview");
    }
    return await this.#idempotent(request.idempotencyKey, "HIGH_RISK_COMMIT", request, async () => {
      const result: HighRiskOperationResult = await service.commit({
        preview,
        expectedPolicyRevision: request.expectedPolicyRevision,
        actor,
        confirmationFingerprint: confirmationFingerprint(preview, actor),
        now: request.occurredAt,
      });
      return { result };
    });
  }

  #requireAudits(): RuntimeAuditQueryPort {
    if (this.dependencies.audits === undefined) throw new P4ConsoleError("CAPABILITY_DISABLED", "runtime audit query is not composed");
    return this.dependencies.audits;
  }

  #requireHighRisk(): HighRiskConsolePort {
    if (this.dependencies.highRisk === undefined || this.dependencies.allowHighRiskCommands !== true) {
      throw new P4ConsoleError("CAPABILITY_DISABLED", "high-risk governance is disabled by production default");
    }
    if (!this.dependencies.highRisk.policy.activeStageEnabled) {
      throw new P4ConsoleError("CAPABILITY_DISABLED", "ACTIVE stage is disabled for high-risk governance");
    }
    return this.dependencies.highRisk;
  }

  #actor(): string {
    const value = typeof this.dependencies.principal === "function"
      ? this.dependencies.principal()
      : this.dependencies.principal;
    if (value === undefined || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,499}$/u.test(value.actorId)) {
      throw new P4ConsoleError("CAPABILITY_DISABLED", "authenticated Sidecar principal is not composed");
    }
    return value.actorId;
  }

  #confirmationPhrase(preview: HighRiskPreview): string {
    return `CONFIRM ${preview.command.kind} ${preview.previewId.slice("sha256:".length, "sha256:".length + 16)}`;
  }

  #attemptView(attempt: ReturnType<RuntimeAuditQueryPort["getInjection"]> extends infer T ? Exclude<T, undefined> : never): InjectionAttemptView {
    const omittedReasonCodes = attempt.envelope.budget.omittedItems === 0 ? [] : unique([
      ...attempt.envelope.complexity.reasonCodes,
      ...(attempt.envelope.budget.truncated ? ["TOKEN_BUDGET_TRUNCATED"] : []),
      attempt.reasonCode,
    ]);
    return structuredClone({ ...attempt, tokenBudget: attempt.envelope.budget, omittedReasonCodes });
  }

  #cursor(kind: SignedCursor["kind"], sessionId: string, parentId: string | undefined, occurredAt: string, id: string): string {
    const payload: SignedCursor = { schemaVersion: 1, kind, sessionId, ...(parentId === undefined ? {} : { parentId }), occurredAt, id };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.#secret).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  #decodeCursor(token: string, kind: SignedCursor["kind"], sessionId: string, parentId?: string): AuditPosition {
    const [encoded, supplied, ...extra] = token.split(".");
    if (encoded === undefined || supplied === undefined || extra.length > 0) throw new P4ConsoleError("INVALID_REQUEST", "cursor is malformed");
    const expected = createHmac("sha256", this.#secret).update(encoded).digest();
    const actual = Buffer.from(supplied, "base64url");
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) throw new P4ConsoleError("INVALID_REQUEST", "cursor signature is invalid");
    let decoded: unknown;
    try { decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { throw new P4ConsoleError("INVALID_REQUEST", "cursor payload is malformed"); }
    const parsed = cursorPayloadSchema.safeParse(decoded);
    if (!parsed.success || parsed.data.kind !== kind || parsed.data.sessionId !== sessionId || parsed.data.parentId !== parentId) {
      throw new P4ConsoleError("SCOPE_MISMATCH", "cursor does not belong to this query Scope");
    }
    return { occurredAt: parsed.data.occurredAt, id: parsed.data.id };
  }

  async #idempotent<T>(idempotencyKey: string, kind: OperationKind, request: unknown, action: () => Promise<T>): Promise<T> {
    const hash = requestHash(kind, request);
    const stored = this.dependencies.operations?.get(idempotencyKey);
    if (stored !== undefined) {
      if (stored.kind !== kind || stored.requestHash !== hash) throw new P4OperationConflictError("idempotency key semantic conflict");
      return this.#parseResponse<T>(kind, stored.response);
    }
    const running = this.#inflight.get(idempotencyKey);
    if (running !== undefined) {
      if (running.hash !== hash) throw new P4OperationConflictError("idempotency key in-flight semantic conflict");
      return await running.promise as T;
    }
    const promise = action().then((response) => {
      const validated = this.#parseResponse<T>(kind, response);
      this.dependencies.operations?.commit({ idempotencyKey, kind, requestHash: hash, response: validated, createdAt: this.#canonicalNow() });
      return validated;
    });
    this.#inflight.set(idempotencyKey, { hash, promise });
    try { return await promise; } finally { this.#inflight.delete(idempotencyKey); }
  }

  #parseResponse<T>(kind: OperationKind, response: unknown): T {
    try {
      return structuredClone(responseSchemas[kind].parse(response)) as T;
    } catch (error) {
      throw new P4AuditStoreError("stored operation response failed strict schema validation", { cause: error });
    }
  }

  #canonicalNow(): string {
    const value = this.#now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("P4 console clock returned an invalid date");
    return value.toISOString();
  }
}
