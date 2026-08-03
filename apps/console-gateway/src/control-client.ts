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
  sessionDetailSchema,
  sessionPageSchema,
  type ControlRequest,
  type ControlResponse,
} from "@zhiloop/control-api";

import type {
  CaptureCommitCommand,
  ConfigurationActivateCommand,
  ConfigurationDraftCommand,
  ConfigurationRollbackCommand,
  ControlCommandPort,
  ControlQueryPort,
  PageQuery,
  JobOperatorCommand,
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

  private request<T extends ControlRequest["type"]>(type: T, fields: Record<string, unknown> = {}): ControlRequest {
    return {
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      requestId: randomUUID(),
      type,
      ...fields,
    } as ControlRequest;
  }

  private execute<T>(requestBody: ControlRequest, resultSchema: OutputSchema<T>, options: QueryOptions): Promise<T> {
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
