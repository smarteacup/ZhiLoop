import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

import {
  CONTROL_API_SCHEMA_VERSION,
  MAX_CONTROL_MESSAGE_BYTES,
  capabilityPageSchema,
  captureCommitResultSchema,
  capturePreviewSchema,
  configurationMutationResultSchema,
  configurationStateSchema,
  configurationValidationResultSchema,
  controlResponseSchema,
  diagnosticsSchema,
  eventMetadataPageSchema,
  jobPageSchema,
  jobCommandResultSchema,
  overviewSchema,
  p2IndexRecoveryResultSchema,
  p2KnowledgeDetailViewSchema,
  p2KnowledgeEditImpactSchema,
  p2KnowledgeListViewSchema,
  p2SessionExtractionViewSchema,
  sessionDetailSchema,
  sessionPageSchema,
  type ControlRequest,
  type ControlResponse,
} from "@zhiloop/control-api";
import {
  p3ConsoleAskResponseSchema,
  p3ConsoleSearchResponseSchema,
  p3ConsoleSimulationResponseSchema,
  type P3ConsoleQueryBody,
} from "@zhiloop/p3-console-runtime";
import { retrievalTraceSchema } from "@zhiloop/control-api";
import {
  closureDetailRequestSchema,
  closureListRequestSchema,
  closureRunSchema,
  feedbackCommandSchema,
  highRiskCommitRequestSchema,
  highRiskPreviewRequestSchema,
  injectionDetailRequestSchema,
  injectionListRequestSchema,
  mcpExpansionListRequestSchema,
} from "@zhiloop/p4-console-runtime";
import {
  p4CapabilityArraySchema,
  p4ClosurePageSchema,
  p4FeedbackResponseSchema,
  p4FeedbackTargetsSchema,
  p4HighRiskCommitResponseSchema,
  p4HighRiskGovernanceSchema,
  p4HighRiskPreviewResponseSchema,
  p4InjectionPageSchema,
  p4RuntimeInjectionViewSchema,
  p4McpExpansionPageSchema,
  p4RolloutResponseSchema,
} from "./p4-contracts.js";

import type {
  CaptureCommitCommand,
  ConfigurationActivateCommand,
  ConfigurationDraftCommand,
  ConfigurationRollbackCommand,
  ControlCommandPort,
  ControlQueryPort,
  PageQuery,
  JobOperatorCommand,
  P4FeedbackCommand,
  P4HighRiskCommitCommand,
  P4HighRiskPreviewCommand,
  QueryOptions,
} from "./ports.js";

interface OutputSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export interface UnixSocketControlClientOptions {
  readonly socketPath: string;
  readonly timeoutMs?: number;
  readonly maximumResponseBytes?: number;
}

export class ControlClientError extends Error {
  public constructor(
    message: string,
    public readonly code: "UNAVAILABLE" | "TIMEOUT" | "PROTOCOL" | "REMOTE_ERROR",
    public readonly remoteCode?: Extract<ControlResponse, { readonly ok: false }>["error"]["code"],
  ) {
    super(message);
    this.name = "ControlClientError";
  }
}

function assertPositiveBoundedInteger(name: string, value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be within 1..${maximum}`);
  }
}

export class UnixSocketControlClient implements ControlQueryPort, ControlCommandPort {
  private readonly timeoutMs: number;
  private readonly maximumResponseBytes: number;

  public constructor(private readonly options: UnixSocketControlClientOptions) {
    if (!options.socketPath.startsWith("/")) throw new Error("socketPath must be absolute");
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.maximumResponseBytes = options.maximumResponseBytes ?? MAX_CONTROL_MESSAGE_BYTES;
    assertPositiveBoundedInteger("timeoutMs", this.timeoutMs, 30_000);
    assertPositiveBoundedInteger("maximumResponseBytes", this.maximumResponseBytes, MAX_CONTROL_MESSAGE_BYTES);
  }

  public getOverview(options: QueryOptions) {
    return this.execute(this.request("overview.get"), overviewSchema, options);
  }

  public listCapabilities(page: PageQuery, options: QueryOptions) {
    return this.execute(this.request("capabilities.list", { page }), capabilityPageSchema, options);
  }

  public listSessions(page: PageQuery, options: QueryOptions) {
    return this.execute(this.request("sessions.list", { page }), sessionPageSchema, options);
  }

  public getSession(sessionId: string, options: QueryOptions) {
    return this.execute(this.request("session.get", { sessionId }), sessionDetailSchema, options);
  }

  public listSessionEvents(sessionId: string, page: PageQuery, options: QueryOptions) {
    return this.execute(this.request("session.events.list", { sessionId, page }), eventMetadataPageSchema, options);
  }

  public listJobs(page: PageQuery, options: QueryOptions) {
    return this.execute(this.request("jobs.list", { page }), jobPageSchema, options);
  }

  public getDiagnostics(options: QueryOptions) {
    return this.execute(this.request("diagnostics.get"), diagnosticsSchema, options);
  }

  public getConfiguration(projectId: string | undefined, options: QueryOptions) {
    return this.execute(this.request("config.get", { ...(projectId === undefined ? {} : { projectId }) }), configurationStateSchema, options);
  }

  public previewCapture(sessionId: string, options: QueryOptions) {
    return this.execute(this.request("capture.preview", { sessionId }), capturePreviewSchema, options);
  }

  public commitCapture(command: CaptureCommitCommand, options: QueryOptions) {
    return this.execute(this.request("capture.commit", {
      sessionId: command.sessionId,
      previewRevision: command.previewRevision,
      transcriptIdentityHash: command.transcriptIdentityHash,
      idempotencyKey: command.idempotencyKey,
    }), captureCommitResultSchema, options);
  }

  public validateConfiguration(command: ConfigurationDraftCommand, options: QueryOptions) {
    return this.execute(this.request("config.validate", {
      baseRevision: command.baseRevision,
      scope: command.scope,
      ...(command.projectId === undefined ? {} : { projectId: command.projectId }),
      draft: command.draft,
    }), configurationValidationResultSchema, options);
  }

  public activateConfiguration(command: ConfigurationActivateCommand, options: QueryOptions) {
    return this.execute(this.request("config.activate", { ...command }), configurationMutationResultSchema, options);
  }

  public rollbackConfiguration(command: ConfigurationRollbackCommand, options: QueryOptions) {
    return this.execute(this.request("config.rollback", { ...command }), configurationMutationResultSchema, options);
  }

  public cancelJob(command: JobOperatorCommand, options: QueryOptions) {
    return this.execute(this.request("job.cancel", { ...command }), jobCommandResultSchema, options);
  }

  public retryJob(command: JobOperatorCommand, options: QueryOptions) {
    return this.execute(this.request("job.retry", { ...command }), jobCommandResultSchema, options);
  }

  public getSessionExtraction(sessionId: string, options: QueryOptions) {
    return this.execute(this.p2Request("p2.session.get", { sessionId }), p2SessionExtractionViewSchema, options);
  }

  public startSessionExtraction(command: { readonly sessionId: string; readonly expectedRevision: number; readonly idempotencyKey: string }, options: QueryOptions) {
    return this.execute(this.p2Request("p2.session.preview", { ...command }), p2SessionExtractionViewSchema, options);
  }

  public commitSessionExtraction(command: { readonly sessionId: string; readonly previewId: string; readonly expectedPreviewRevision: number; readonly idempotencyKey: string }, options: QueryOptions) {
    return this.execute(this.p2Request("p2.session.commit", { ...command }), p2SessionExtractionViewSchema, options);
  }

  public listKnowledge(filter: Readonly<Record<string, unknown>>, options: QueryOptions) {
    return this.execute(this.p2Request("p2.knowledge.list", { filter, limit: 50 }), p2KnowledgeListViewSchema, options);
  }

  public getKnowledge(knowledgeId: string, options: QueryOptions) {
    return this.execute(this.p2Request("p2.knowledge.get", { knowledgeId }), p2KnowledgeDetailViewSchema, options);
  }

  public previewKnowledgeEdit(command: Readonly<Record<string, unknown>>, options: QueryOptions) {
    return this.execute(this.p2Request("p2.knowledge.edit.preview", command), p2KnowledgeEditImpactSchema, options);
  }

  public commitKnowledgeEdit(command: Readonly<Record<string, unknown>>, options: QueryOptions) {
    return this.execute(this.p2Request("p2.knowledge.edit.commit", command), p2KnowledgeDetailViewSchema, options);
  }

  public suppressKnowledge(command: Readonly<Record<string, unknown>>, options: QueryOptions) {
    return this.execute(this.p2Request("p2.knowledge.suppress", command), p2KnowledgeDetailViewSchema, options);
  }

  public restoreKnowledge(command: Readonly<Record<string, unknown>>, options: QueryOptions) {
    return this.execute(this.p2Request("p2.knowledge.restore", command), p2KnowledgeDetailViewSchema, options);
  }

  public recoverKnowledgeIndex(knowledgeId: string, options: QueryOptions) {
    return this.execute(this.p2Request("p2.knowledge.index.recover", { knowledgeId }), p2IndexRecoveryResultSchema, options);
  }

  public searchKnowledge(command: P3ConsoleQueryBody, options: QueryOptions) {
    return this.execute(this.p3Request("p3.knowledge.search", command), p3ConsoleSearchResponseSchema, options);
  }

  public askKnowledge(command: P3ConsoleQueryBody, options: QueryOptions) {
    return this.execute(this.p3Request("p3.knowledge.ask", command), p3ConsoleAskResponseSchema, options);
  }

  public simulateRetrieval(command: P3ConsoleQueryBody, options: QueryOptions) {
    return this.execute(this.p3Request("p3.retrieval.simulate", command), p3ConsoleSimulationResponseSchema, options);
  }

  public getRetrievalTrace(command: { readonly requestId: string; readonly traceId: string; readonly projectId?: string; readonly taskId?: string }, options: QueryOptions) {
    return this.execute(this.p3Request("p3.retrieval.trace", command), retrievalTraceSchema, options);
  }

  public listP4Capabilities(options: QueryOptions) {
    return this.execute(this.p4Request("p4.capabilities", {}), p4CapabilityArraySchema, options);
  }

  public listP4Injections(sessionId: string, page: PageQuery, options: QueryOptions) {
    const logical = injectionListRequestSchema.parse({ schemaVersion: 1, type: "p4.injections.list", sessionId, ...page });
    return this.execute(this.p4Request(logical.type, logical), p4InjectionPageSchema, options);
  }

  public getP4Injection(sessionId: string, attemptId: string, options: QueryOptions) {
    const logical = injectionDetailRequestSchema.parse({ schemaVersion: 1, type: "p4.injections.get", sessionId, attemptId });
    return this.execute(this.p4Request(logical.type, logical), p4RuntimeInjectionViewSchema, options);
  }

  public listP4McpExpansions(sessionId: string, attemptId: string, page: PageQuery, options: QueryOptions) {
    const logical = mcpExpansionListRequestSchema.parse({ schemaVersion: 1, type: "p4.mcp-expansions.list", sessionId, attemptId, ...page });
    return this.execute(this.p4Request(logical.type, logical), p4McpExpansionPageSchema, options);
  }

  public listP4Closures(sessionId: string, page: PageQuery, options: QueryOptions) {
    const logical = closureListRequestSchema.parse({ schemaVersion: 1, type: "p4.closures.list", sessionId, ...page });
    return this.execute(this.p4Request(logical.type, logical), p4ClosurePageSchema, options);
  }

  public getP4Closure(sessionId: string, closureRunId: string, options: QueryOptions) {
    const logical = closureDetailRequestSchema.parse({ schemaVersion: 1, type: "p4.closures.get", sessionId, closureRunId });
    return this.execute(this.p4Request(logical.type, logical), closureRunSchema, options);
  }

  public getP4Rollout(options: QueryOptions) {
    return this.execute(this.p4Request("p4.rollout.get", {}), p4RolloutResponseSchema, options);
  }

  public listP4FeedbackTargets(sessionId: string, options: QueryOptions) {
    return this.execute(this.p4Request("p4.feedback-targets.list", { sessionId }), p4FeedbackTargetsSchema, options);
  }

  public getP4HighRiskGovernance(options: QueryOptions) {
    return this.execute(this.p4Request("p4.high-risk.governance", {}), p4HighRiskGovernanceSchema, options);
  }

  public recordP4Feedback(command: P4FeedbackCommand, options: QueryOptions) {
    const common = {
      schemaVersion: 1 as const,
      type: "p4.feedback.record" as const,
      idempotencyKey: command.idempotencyKey,
      occurredAt: new Date().toISOString(),
      action: command.action,
      assetId: command.assetId,
      expectedKnowledgeVersion: command.expectedKnowledgeVersion,
      scopeKey: command.scopeKey,
      traceId: command.traceId,
    };
    const logical = feedbackCommandSchema.parse(command.action === "MCP_USE"
      ? { ...common, action: "MCP_USE", expansionId: command.expansionId }
      : { ...common, actor: "local-console" });
    return this.execute(this.p4Request(logical.type, logical), p4FeedbackResponseSchema, options);
  }

  public previewP4HighRisk(command: P4HighRiskPreviewCommand, options: QueryOptions) {
    const logical = highRiskPreviewRequestSchema.parse({
      schemaVersion: 1, type: "p4.high-risk.preview", occurredAt: new Date().toISOString(), ...command,
    });
    return this.execute(this.p4Request(logical.type, logical), p4HighRiskPreviewResponseSchema, options);
  }

  public commitP4HighRisk(command: P4HighRiskCommitCommand, options: QueryOptions) {
    const logical = highRiskCommitRequestSchema.parse({
      schemaVersion: 1, type: "p4.high-risk.commit", occurredAt: new Date().toISOString(), ...command,
    });
    return this.execute(this.p4Request(logical.type, logical), p4HighRiskCommitResponseSchema, options);
  }

  private p4Request(type: string, fields: object) {
    return { schemaVersion: CONTROL_API_SCHEMA_VERSION, requestId: randomUUID(), ...fields, type };
  }

  private p3Request(type: string, fields: { readonly requestId: string }) {
    return { schemaVersion: CONTROL_API_SCHEMA_VERSION, type, ...fields };
  }

  private p2Request(type: string, fields: Readonly<Record<string, unknown>>) {
    return { schemaVersion: CONTROL_API_SCHEMA_VERSION, requestId: randomUUID(), type, ...fields };
  }

  private request<T extends ControlRequest["type"]>(type: T, fields: Record<string, unknown> = {}): ControlRequest {
    return {
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      requestId: randomUUID(),
      type,
      ...fields,
    } as ControlRequest;
  }

  private execute<T>(requestBody: ControlRequest | { readonly schemaVersion: 1; readonly requestId: string; readonly type: string }, resultSchema: OutputSchema<T>, options: QueryOptions): Promise<T> {
    const serialized = `${JSON.stringify(requestBody)}\n`;
    if (Buffer.byteLength(serialized) > MAX_CONTROL_MESSAGE_BYTES) {
      return Promise.reject(new ControlClientError("Control request exceeded the byte limit", "PROTOCOL"));
    }
    return new Promise<T>((resolve, reject) => {
      let completed = false;
      let received = 0;
      const chunks: Buffer[] = [];
      const socket = createConnection(this.options.socketPath);
      const timeout = setTimeout(() => socket.destroy(new ControlClientError("Sidecar request timed out", "TIMEOUT")), this.timeoutMs);
      timeout.unref?.();
      const finish = (operation: () => void): void => {
        if (completed) return;
        completed = true;
        clearTimeout(timeout);
        options.signal.removeEventListener("abort", abort);
        socket.destroy();
        operation();
      };
      const abort = (): void => {
        socket.destroy(new ControlClientError("Sidecar request timed out", "TIMEOUT"));
      };
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort();
      socket.on("error", (error) => {
        const safeError = error instanceof ControlClientError
          ? error
          : new ControlClientError(options.signal.aborted ? "Sidecar request timed out" : "Sidecar unavailable", options.signal.aborted ? "TIMEOUT" : "UNAVAILABLE");
        finish(() => reject(safeError));
      });
      socket.on("end", () => finish(() => reject(new ControlClientError("Invalid Sidecar response", "PROTOCOL"))));
      socket.on("data", (chunk: Buffer) => {
        received += chunk.byteLength;
        if (received > this.maximumResponseBytes) {
          finish(() => reject(new ControlClientError("Sidecar response exceeded the byte limit", "PROTOCOL")));
          return;
        }
        chunks.push(chunk);
        const newline = chunk.indexOf(0x0a);
        if (newline < 0) return;
        if (newline !== chunk.byteLength - 1) {
          finish(() => reject(new ControlClientError("Invalid Sidecar response", "PROTOCOL")));
          return;
        }
        const combined = chunks.length === 1 ? chunk : Buffer.concat(chunks, received);
        let decoded: unknown;
        try {
          decoded = JSON.parse(combined.subarray(0, combined.byteLength - 1).toString("utf8")) as unknown;
        } catch {
          finish(() => reject(new ControlClientError("Invalid Sidecar response", "PROTOCOL")));
          return;
        }
        const transportResult = typeof decoded === "object" && decoded !== null && (decoded as { ok?: unknown }).ok === true
          && "result" in decoded && !("schemaVersion" in decoded)
          ? (decoded as { result: unknown }).result
          : decoded;
        if (typeof decoded === "object" && decoded !== null && (decoded as { ok?: unknown }).ok === false && !("schemaVersion" in decoded)) {
          finish(() => reject(new ControlClientError("Sidecar rejected the request", "REMOTE_ERROR")));
          return;
        }
        const envelope = controlResponseSchema.safeParse(transportResult);
        if (!envelope.success || envelope.data.requestId !== requestBody.requestId) {
          finish(() => reject(new ControlClientError("Invalid Sidecar response", "PROTOCOL")));
          return;
        }
        if (!envelope.data.ok) {
          const remoteCode = envelope.data.error.code;
          finish(() => reject(new ControlClientError("Sidecar rejected the request", "REMOTE_ERROR", remoteCode)));
          return;
        }
        const parsed = resultSchema.safeParse(envelope.data.result);
        if (!parsed.success) {
          finish(() => reject(new ControlClientError("Invalid Sidecar response", "PROTOCOL")));
          return;
        }
        finish(() => resolve(parsed.data));
      });
      socket.once("connect", () => socket.write(serialized));
    });
  }
}
