import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ActiveRolloutService } from "@zhiloop/active-rollout-service";
import type { KnowledgeEligibilityInspection, KnowledgeFeedbackRuntime } from "@zhiloop/active-knowledge-runtime";
import { CONTROL_API_SCHEMA_VERSION, type ControlResponse } from "@zhiloop/control-api";
import {
  closureDetailRequestSchema,
  closureListRequestSchema,
  contextRefreshRequestSchema,
  feedbackCommandSchema,
  highRiskCommitRequestSchema,
  highRiskPreviewRequestSchema,
  injectionDetailRequestSchema,
  injectionListRequestSchema,
  mapP4ConsoleError,
  mcpExpansionListRequestSchema,
  P4ConsoleRuntime,
  P4ConsoleError,
  SqliteP4OperationStore,
  SqliteRuntimeAuditQueryAdapter,
} from "@zhiloop/p4-console-runtime";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,499}$/u;
const CURSOR_SECRET_BYTES = 32;

type ParsedRuntimeRequest =
  | ReturnType<typeof injectionListRequestSchema.parse>
  | ReturnType<typeof injectionDetailRequestSchema.parse>
  | ReturnType<typeof mcpExpansionListRequestSchema.parse>
  | ReturnType<typeof closureListRequestSchema.parse>
  | ReturnType<typeof closureDetailRequestSchema.parse>
  | ReturnType<typeof contextRefreshRequestSchema.parse>
  | ReturnType<typeof feedbackCommandSchema.parse>
  | ReturnType<typeof highRiskPreviewRequestSchema.parse>
  | ReturnType<typeof highRiskCommitRequestSchema.parse>
  | { readonly schemaVersion: 1; readonly type: "p4.capabilities" }
  | { readonly schemaVersion: 1; readonly type: "p4.rollout.get" }
  | { readonly schemaVersion: 1; readonly type: "p4.feedback-targets.list"; readonly sessionId: string }
  | { readonly schemaVersion: 1; readonly type: "p4.high-risk.governance" };

export type P4ConsoleTransportRequest = ParsedRuntimeRequest & { readonly requestId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseP4ConsoleRequest(value: unknown): P4ConsoleTransportRequest {
  if (!isRecord(value) || !SAFE_ID.test(String(value["requestId"]))) throw requestError("INVALID_REQUEST");
  const { requestId, ...runtimeRequest } = value;
  let parsed: ParsedRuntimeRequest;
  try {
    switch (runtimeRequest["type"]) {
      case "p4.injections.list": parsed = injectionListRequestSchema.parse(runtimeRequest); break;
      case "p4.injections.get": parsed = injectionDetailRequestSchema.parse(runtimeRequest); break;
      case "p4.mcp-expansions.list": parsed = mcpExpansionListRequestSchema.parse(runtimeRequest); break;
      case "p4.closures.list": parsed = closureListRequestSchema.parse(runtimeRequest); break;
      case "p4.closures.get": parsed = closureDetailRequestSchema.parse(runtimeRequest); break;
      case "p4.context.refresh": parsed = contextRefreshRequestSchema.parse(runtimeRequest); break;
      case "p4.feedback.record": parsed = feedbackCommandSchema.parse(runtimeRequest); break;
      case "p4.high-risk.preview": parsed = highRiskPreviewRequestSchema.parse(runtimeRequest); break;
      case "p4.high-risk.commit": parsed = highRiskCommitRequestSchema.parse(runtimeRequest); break;
      case "p4.capabilities":
      case "p4.rollout.get": {
        if (runtimeRequest["schemaVersion"] !== 1 || Object.keys(runtimeRequest).length !== 2) throw requestError("INVALID_REQUEST");
        parsed = runtimeRequest as ParsedRuntimeRequest;
        break;
      }
      case "p4.feedback-targets.list": {
        if (runtimeRequest["schemaVersion"] !== 1 || Object.keys(runtimeRequest).length !== 3
          || typeof runtimeRequest["sessionId"] !== "string" || !SAFE_ID.test(runtimeRequest["sessionId"])) {
          throw requestError("INVALID_REQUEST");
        }
        parsed = runtimeRequest as ParsedRuntimeRequest;
        break;
      }
      case "p4.high-risk.governance": {
        if (runtimeRequest["schemaVersion"] !== 1 || Object.keys(runtimeRequest).length !== 2) throw requestError("INVALID_REQUEST");
        parsed = runtimeRequest as ParsedRuntimeRequest;
        break;
      }
      default: throw requestError("INVALID_REQUEST");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "INVALID_REQUEST") throw error;
    throw requestError("INVALID_REQUEST");
  }
  return Object.freeze({ ...parsed, requestId: requestId as string });
}

function requestError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error("invalid P4 Console request"), { code });
}

async function cursorSecret(path: string): Promise<Uint8Array> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, randomBytes(CURSOR_SECRET_BYTES), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== CURSOR_SECRET_BYTES
    || (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600)) {
    throw new Error("P4 cursor secret file is unsafe");
  }
  if (process.platform !== "win32") await chmod(path, 0o600);
  return await readFile(path);
}

export interface P4SidecarConsoleDependencies {
  readonly stateDirectory: string;
  readonly feedback: KnowledgeFeedbackRuntime;
  readonly rollout: ActiveRolloutService;
  readonly inspectEligibility: (request: {
    readonly assetId: string;
    readonly version: number;
    readonly scopeKey: string;
    readonly signal?: AbortSignal;
  }) => Promise<KnowledgeEligibilityInspection>;
  readonly refreshContext?: (sessionId: string) => number;
  readonly now?: () => Date;
}

export class P4SidecarConsole {
  readonly #audits: SqliteRuntimeAuditQueryAdapter;
  readonly #operations: SqliteP4OperationStore;
  readonly #runtime: P4ConsoleRuntime;
  readonly #dependencies: P4SidecarConsoleDependencies;
  readonly #contextRefreshReceipts = new Map<string, { readonly sessionId: string; readonly result: Readonly<Record<string, unknown>> }>();
  #closed = false;

  private constructor(dependencies: P4SidecarConsoleDependencies, secret: Uint8Array) {
    this.#dependencies = dependencies;
    this.#audits = new SqliteRuntimeAuditQueryAdapter(join(dependencies.stateDirectory, "p4-runtime-audit.sqlite"));
    this.#operations = new SqliteP4OperationStore(join(dependencies.stateDirectory, "p4-console-operations.sqlite"));
    this.#runtime = new P4ConsoleRuntime({
      cursorSecret: secret,
      audits: this.#audits,
      feedback: dependencies.feedback,
      rollout: dependencies.rollout,
      operations: this.#operations,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
  }

  static async create(dependencies: P4SidecarConsoleDependencies): Promise<P4SidecarConsole> {
    const secret = await cursorSecret(join(dependencies.stateDirectory, "p4-console-cursor.secret"));
    return new P4SidecarConsole(dependencies, secret);
  }

  async handle(request: P4ConsoleTransportRequest, signal?: AbortSignal): Promise<ControlResponse> {
    const observedAt = new Date().toISOString();
    try {
      this.#assertOpen();
      const runtimeRequest = Object.fromEntries(Object.entries(request).filter(([key]) => key !== "requestId"));
      let result: unknown;
      switch (request.type) {
        case "p4.capabilities": result = this.#runtime.capabilities(); break;
        case "p4.rollout.get": result = this.#runtime.rollout(); break;
        case "p4.feedback-targets.list": result = await this.#feedbackTargets(request.sessionId, signal); break;
        case "p4.high-risk.governance": result = this.#highRiskGovernance(); break;
        case "p4.injections.list": result = this.#runtime.listInjections(runtimeRequest); break;
        case "p4.injections.get": result = this.#runtime.getInjection(runtimeRequest); break;
        case "p4.mcp-expansions.list": result = this.#runtime.listMcpExpansions(runtimeRequest); break;
        case "p4.closures.list": result = this.#runtime.listClosures(runtimeRequest); break;
        case "p4.closures.get": result = this.#runtime.getClosure(runtimeRequest); break;
        case "p4.context.refresh": {
          if (this.#dependencies.refreshContext === undefined) throw new P4ConsoleError("CAPABILITY_DISABLED", "context refresh is disabled");
          const prior = this.#contextRefreshReceipts.get(request.idempotencyKey);
          if (prior !== undefined && prior.sessionId !== request.sessionId) {
            throw new P4ConsoleError("CONFLICT", "context refresh idempotency conflict");
          }
          if (prior !== undefined) result = prior.result;
          else {
            result = Object.freeze({
              sessionId: request.sessionId,
              removedEntries: this.#dependencies.refreshContext(request.sessionId),
              refreshedAt: (this.#dependencies.now ?? (() => new Date()))().toISOString(),
              reasonCode: "SESSION_CONTEXT_REFRESHED",
            });
            this.#contextRefreshReceipts.set(request.idempotencyKey, { sessionId: request.sessionId, result: result as Readonly<Record<string, unknown>> });
            if (this.#contextRefreshReceipts.size > 5_000) {
              const oldest = this.#contextRefreshReceipts.keys().next().value as string | undefined;
              if (oldest !== undefined) this.#contextRefreshReceipts.delete(oldest);
            }
          }
          break;
        }
        case "p4.feedback.record": result = await this.#runtime.recordFeedback(runtimeRequest, signal); break;
        case "p4.high-risk.preview": result = await this.#runtime.previewHighRisk(runtimeRequest); break;
        case "p4.high-risk.commit": result = await this.#runtime.commitHighRisk(runtimeRequest); break;
      }
      return { schemaVersion: CONTROL_API_SCHEMA_VERSION, requestId: request.requestId, observedAt, ok: true, result };
    } catch (error) {
      const safe = mapP4ConsoleError(error);
      return {
        schemaVersion: CONTROL_API_SCHEMA_VERSION,
        requestId: request.requestId,
        observedAt,
        ok: false,
        error: {
          code: safe.code === "NOT_FOUND" ? "NOT_FOUND"
            : safe.code === "CONFLICT" ? "CONFLICT"
              : safe.code === "INVALID_REQUEST" || safe.code === "SCOPE_MISMATCH" ? "INVALID_REQUEST"
                : safe.code === "CAPABILITY_DISABLED" ? "CAPABILITY_UNAVAILABLE"
                  : safe.code === "TIMEOUT" || safe.code === "STORAGE_UNAVAILABLE" ? "SIDECAR_UNAVAILABLE"
                    : "INTERNAL_ERROR",
          message: "P4 Console request failed",
          retryable: safe.retryable,
        },
      };
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#operations.close();
    this.#audits.close();
    this.#closed = true;
  }

  #assertOpen(): void { if (this.#closed) throw new Error("P4 Sidecar Console is closed"); }

  async #feedbackTargets(sessionId: string, signal?: AbortSignal): Promise<unknown> {
    const items = new Map<string, Record<string, unknown>>();
    for (const attempt of this.#audits.listInjections(sessionId, 100).items) {
      const scopeKey = attempt.envelope.taskId === undefined
        ? JSON.stringify(attempt.envelope.projectId === undefined
          ? { level: "GLOBAL" }
          : { level: "PROJECT", projectId: attempt.envelope.projectId })
        : JSON.stringify({
            level: "TASK",
            ...(attempt.envelope.projectId === undefined ? {} : { projectId: attempt.envelope.projectId }),
            taskId: attempt.envelope.taskId,
          });
      const expansions = this.#audits.listMcpExpansions(sessionId, attempt.attemptId, 100).items;
      for (const knowledge of attempt.envelope.items) {
        if (signal?.aborted === true) throw signal.reason;
        const eligibility = await this.#dependencies.inspectEligibility({
          assetId: knowledge.id,
          version: knowledge.version,
          scopeKey,
          ...(signal === undefined ? {} : { signal }),
        });
        const expansion = expansions.find((candidate) => candidate.knowledgeId === knowledge.id
          && candidate.knowledgeVersion === knowledge.version);
        const targetCurrent = eligibility.exists && eligibility.current && eligibility.scopeMatched;
        const retrievable = targetCurrent && eligibility.statusEligible && !eligibility.suppressed;
        const gate = (
          action: "RELEVANT" | "IRRELEVANT" | "PIN" | "SUPPRESS" | "MCP_USED",
          enabled: boolean,
        ): Record<string, unknown> => enabled
          ? {
              enabled: true,
              capabilityStatus: "READY",
              reasonCode: "FEEDBACK_TARGET_ELIGIBLE",
              expectedRevision: knowledge.version,
              idempotencyKey: `feedback:${action}:${knowledge.id}:${knowledge.version}`,
            }
          : {
              enabled: false,
              capabilityStatus: targetCurrent ? "NOT_VERIFIED" : "DISABLED",
              reasonCode: targetCurrent ? "KNOWLEDGE_NOT_RETRIEVABLE" : "KNOWLEDGE_TARGET_STALE_OR_OUT_OF_SCOPE",
            };
        items.set(`${knowledge.id}@${knowledge.version}`, {
          knowledgeId: knowledge.id,
          version: knowledge.version,
          title: knowledge.title,
          eligible: retrievable,
          eligibilityReasonCodes: retrievable ? ["CURRENT_SCOPE_ELIGIBLE"] : [
            ...(eligibility.exists ? [] : ["KNOWLEDGE_NOT_FOUND"]),
            ...(eligibility.current ? [] : ["KNOWLEDGE_VERSION_STALE"]),
            ...(eligibility.scopeMatched ? [] : ["KNOWLEDGE_SCOPE_MISMATCH"]),
            ...(eligibility.statusEligible ? [] : ["KNOWLEDGE_STATUS_INELIGIBLE"]),
            ...(eligibility.suppressed ? ["KNOWLEDGE_SUPPRESSED"] : []),
          ],
          mcpUsed: expansion?.used === true,
          scopeKey,
          traceId: expansion?.traceId ?? attempt.traceId,
          ...(expansion === undefined ? {} : { expansionId: expansion.expansionId }),
          actions: {
            RELEVANT: gate("RELEVANT", retrievable),
            IRRELEVANT: gate("IRRELEVANT", targetCurrent),
            PIN: gate("PIN", retrievable),
            SUPPRESS: gate("SUPPRESS", targetCurrent),
            MCP_USED: gate("MCP_USED", retrievable && expansion !== undefined),
          },
        });
      }
    }
    return { items: [...items.values()].slice(0, 500) };
  }

  #highRiskGovernance(): unknown {
    const disabled = {
      enabled: false,
      capabilityStatus: "NOT_CONFIGURED",
      reasonCode: "HIGH_RISK_GOVERNANCE_NOT_CONFIGURED",
    } as const;
    return {
      policyRevision: this.#dependencies.rollout.state.effective.policyRevision,
      activeStageEnabled: false,
      actor: "local-console-unconfigured",
      actions: {
        GLOBAL_PROMOTION: disabled,
        RULE_CHANGE: disabled,
        BINDING_CHANGE: disabled,
        PRIVACY_PURGE: disabled,
      },
    };
  }
}
