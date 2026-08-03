import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

import {
  CONFIGURATION_HTTP_PATHS,
  CONSOLE_HTTP_API_PREFIX,
  CONTROL_API_SCHEMA_VERSION,
  capabilityPageSchema,
  captureCommitResultSchema,
  capturePreviewSchema,
  configurationMutationResultSchema,
  configurationStateSchema,
  configurationValidationResultSchema,
  controlRequestSchema,
  diagnosticsSchema,
  eventMetadataPageSchema,
  jobCommandResultSchema,
  jobIdSchema,
  jobPageSchema,
  overviewSchema,
  p2IndexRecoveryResultSchema,
  p2KnowledgeDetailViewSchema,
  p2KnowledgeEditCommandBodySchema,
  p2KnowledgeEditImpactSchema,
  p2KnowledgeFilterSchema,
  p2KnowledgeLifecycleCommandBodySchema,
  p2KnowledgeListViewSchema,
  p2SessionCommitCommandSchema,
  p2SessionExtractionViewSchema,
  p2SessionPreviewCommandSchema,
  pageRequestSchema,
  sessionDetailSchema,
  sessionIdSchema,
  sessionPageSchema,
  type ControlResponse,
  type ConfigurationMutationResult,
} from "@zhiloop/control-api";

import { BrowserSessionManager, createBootstrapToken } from "./auth.js";
import { ControlClientError } from "./control-client.js";
import {
  BoundedInvalidationLog,
  MAX_POLL_INVALIDATIONS,
  createResyncInvalidation,
  encodeInvalidationFrame,
  parseRevision,
  type InvalidationPollResult,
} from "./invalidation.js";
import type { ControlCommandPort, ControlQueryPort, PageQuery, QueryOptions } from "./ports.js";
import {
  FixedWindowRateLimiter,
  applySafeHeaders,
  assertLoopbackBind,
  hasTrustedRequestBoundary,
} from "./security.js";
import { StaticAssetStore } from "./static-assets.js";

const MAX_BOOTSTRAP_BODY_BYTES = 8_192;
const MAX_COMMAND_BODY_BYTES = 16_384;
const MAX_JSON_RESPONSE_BYTES = 1_048_576;
const MAX_SSE_CONNECTIONS = 64;
const MAX_SSE_PENDING_BYTES = 2 * 1_048_576;

interface OutputSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

const SAFE_KNOWLEDGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,499}$/u;

export interface ConsoleGatewayOptions {
  readonly queryPort: ControlQueryPort;
  readonly commandPort?: ControlCommandPort | undefined;
  readonly staticRoot: string;
  readonly host?: string;
  readonly port?: number;
  readonly bootstrapToken?: string;
  readonly bootstrapTtlMs?: number;
  readonly sessionTtlMs?: number;
  readonly queryTimeoutMs?: number;
  readonly maximumJsonResponseBytes?: number;
  readonly maximumRequestsPerWindow?: number;
  readonly rateWindowMs?: number;
  readonly invalidationLog?: BoundedInvalidationLog;
  readonly maximumSseConnections?: number;
  readonly maximumSsePendingBytes?: number;
  readonly sseHeartbeatMs?: number;
  readonly pollingFallbackMs?: number;
}

export interface ConsoleGatewayAddress {
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  readonly bootstrapUrl: string;
}

export interface ConsoleGateway {
  listen(): Promise<ConsoleGatewayAddress>;
  close(): Promise<void>;
}

type ControlErrorCode = Extract<ControlResponse, { readonly ok: false }>["error"]["code"];

function safeError(response: ServerResponse, status: number, code: ControlErrorCode, message: string): void {
  sendJson(response, status, {
    schemaVersion: CONTROL_API_SCHEMA_VERSION,
    requestId: randomUUID(),
    observedAt: new Date().toISOString(),
    ok: false,
    error: { code, message, retryable: code === "SIDECAR_UNAVAILABLE" || code === "RATE_LIMITED" },
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown, maximumBytes = MAX_JSON_RESPONSE_BYTES): void {
  const body = Buffer.from(JSON.stringify(value));
  if (body.byteLength > maximumBytes) {
    const fallback = Buffer.from(JSON.stringify({
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      requestId: randomUUID(),
      observedAt: new Date().toISOString(),
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "Response exceeded the configured byte limit", retryable: false },
    }));
    response.statusCode = 502;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("content-length", fallback.byteLength);
    response.end(fallback);
    return;
  }
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", body.byteLength);
  response.end(body);
}

function readBoundedBody(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let rejected = false;
    request.on("data", (chunk: Buffer) => {
      if (rejected) return;
      received += chunk.byteLength;
      if (received > maximumBytes) {
        rejected = true;
        reject(new Error("BODY_TOO_LARGE"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    request.on("error", (error) => {
      if (!rejected) reject(error);
    });
  });
}

function hasExactBodyFields(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && keys.every((key) => allowed.has(key));
}

function decodePathSegment(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try { return decodeURIComponent(value); } catch { return undefined; }
}

function parsePage(searchParams: URLSearchParams): PageQuery | undefined {
  for (const key of searchParams.keys()) if (key !== "limit" && key !== "cursor" && key !== "sessionId") return undefined;
  const rawLimit = searchParams.get("limit");
  const rawCursor = searchParams.get("cursor");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  const parsed = pageRequestSchema.safeParse({
    limit,
    ...(rawCursor === null ? {} : { cursor: rawCursor }),
  });
  return parsed.success ? parsed.data : undefined;
}

function withTimeout<T>(timeoutMs: number, operation: (options: QueryOptions) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation({ signal: controller.signal }),
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("QUERY_TIMEOUT"));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function executeView<T>(
  response: ServerResponse,
  schema: OutputSchema<T>,
  timeoutMs: number,
  maximumBytes: number,
  operation: (options: QueryOptions) => Promise<T>,
): Promise<void> {
  try {
    const value = await withTimeout(timeoutMs, operation);
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      safeError(response, 502, "INTERNAL_ERROR", "Control API returned an invalid response");
      return;
    }
    sendJson(response, 200, {
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      requestId: randomUUID(),
      observedAt: new Date().toISOString(),
      ok: true,
      result: parsed.data,
    }, maximumBytes);
  } catch {
    safeError(response, 503, "SIDECAR_UNAVAILABLE", "Control API query is unavailable");
  }
}

async function executeCommand<T>(
  response: ServerResponse,
  schema: OutputSchema<T>,
  timeoutMs: number,
  maximumBytes: number,
  operation: (options: QueryOptions) => Promise<T>,
  statusForResult: (result: T) => number = () => 200,
): Promise<void> {
  try {
    const value = await withTimeout(timeoutMs, operation);
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      safeError(response, 502, "INTERNAL_ERROR", "Control API returned an invalid response");
      return;
    }
    sendJson(response, statusForResult(parsed.data), {
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      requestId: randomUUID(),
      observedAt: new Date().toISOString(),
      ok: true,
      result: parsed.data,
    }, maximumBytes);
  } catch (error) {
    const remoteCode = error instanceof ControlClientError ? error.remoteCode : undefined;
    if (remoteCode === "CONFLICT" || remoteCode === "STALE_REVISION") {
      safeError(response, 409, remoteCode, "Command is stale or conflicts with current state");
    } else if (remoteCode === "NOT_FOUND") {
      safeError(response, 404, remoteCode, "Control command target was not found");
    } else if (remoteCode === "INVALID_REQUEST") {
      safeError(response, 400, remoteCode, "Control command was rejected");
    } else if (remoteCode === "RATE_LIMITED") {
      safeError(response, 429, remoteCode, "Control command rate limit exceeded");
    } else if (remoteCode === "CAPABILITY_UNAVAILABLE" || remoteCode === "SIDECAR_UNAVAILABLE") {
      safeError(response, 503, remoteCode, "Control command capability is unavailable");
    } else {
      safeError(response, 503, "SIDECAR_UNAVAILABLE", "Control command is unavailable");
    }
  }
}

function configurationMutationStatus(result: ConfigurationMutationResult): number {
  if (result.ok) return 200;
  if (result.diagnostic.code === "STALE_REVISION" || result.diagnostic.code === "CONFLICT") return 409;
  if (result.diagnostic.code === "NOT_FOUND") return 404;
  if (result.diagnostic.code === "INVALID_CONFIGURATION" || result.diagnostic.code === "CONSUMER_DISABLED") return 400;
  return 503;
}

export async function createConsoleGateway(options: ConsoleGatewayOptions): Promise<ConsoleGateway> {
  const host = options.host ?? "127.0.0.1";
  assertLoopbackBind(host);
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("port is invalid");
  const queryTimeoutMs = options.queryTimeoutMs ?? 2_000;
  if (!Number.isSafeInteger(queryTimeoutMs) || queryTimeoutMs < 10 || queryTimeoutMs > 30_000) throw new Error("queryTimeoutMs is invalid");
  const maximumJsonResponseBytes = options.maximumJsonResponseBytes ?? MAX_JSON_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maximumJsonResponseBytes) || maximumJsonResponseBytes < 512 || maximumJsonResponseBytes > MAX_JSON_RESPONSE_BYTES) {
    throw new Error("maximumJsonResponseBytes is invalid");
  }
  const bootstrapToken = options.bootstrapToken ?? createBootstrapToken();
  const bootstrapTtlMs = options.bootstrapTtlMs ?? 2 * 60_000;
  if (!Number.isSafeInteger(bootstrapTtlMs) || bootstrapTtlMs < 10_000 || bootstrapTtlMs > 10 * 60_000) {
    throw new Error("bootstrapTtlMs is invalid");
  }
  const sessionManager = new BrowserSessionManager(
    bootstrapToken,
    options.sessionTtlMs,
    Date.now() + bootstrapTtlMs,
  );
  const staticAssets = await StaticAssetStore.create(options.staticRoot);
  const limiter = new FixedWindowRateLimiter(options.maximumRequestsPerWindow ?? 120, options.rateWindowMs ?? 60_000);
  const bootstrapLimiter = new FixedWindowRateLimiter(10, 60_000);
  const invalidationLog = options.invalidationLog ?? new BoundedInvalidationLog();
  const publishInvalidation = (
    type: "capability.updated" | "session.updated" | "job.updated" | "configuration.updated" | "alert.updated",
    entityId?: string,
  ): void => {
    const revision = invalidationLog.currentRevision + 1;
    invalidationLog.publish({
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      eventId: `gateway-${type}-${revision}`,
      type,
      ...(entityId === undefined ? {} : { entityId }),
      revision,
      occurredAt: new Date().toISOString(),
    });
  };
  const maximumSseConnections = options.maximumSseConnections ?? 8;
  if (!Number.isSafeInteger(maximumSseConnections) || maximumSseConnections < 1 || maximumSseConnections > MAX_SSE_CONNECTIONS) {
    throw new Error("maximumSseConnections is invalid");
  }
  const minimumSsePendingBytes = invalidationLog.maximumBytes + 16_384;
  const maximumSsePendingBytes = options.maximumSsePendingBytes ?? minimumSsePendingBytes;
  if (!Number.isSafeInteger(maximumSsePendingBytes) || maximumSsePendingBytes < minimumSsePendingBytes || maximumSsePendingBytes > MAX_SSE_PENDING_BYTES) {
    throw new Error("maximumSsePendingBytes is invalid");
  }
  const sseHeartbeatMs = options.sseHeartbeatMs ?? 15_000;
  if (!Number.isSafeInteger(sseHeartbeatMs) || sseHeartbeatMs < 100 || sseHeartbeatMs > 60_000) throw new Error("sseHeartbeatMs is invalid");
  // Completion-based 2 Hz monitoring keeps the P1 status-to-UI P95 budget below one second
  // without overlapping Control API calls when a previous observation is slow.
  const pollingFallbackMs = options.pollingFallbackMs ?? 500;
  if (!Number.isSafeInteger(pollingFallbackMs) || pollingFallbackMs < 100 || pollingFallbackMs > 60_000) throw new Error("pollingFallbackMs is invalid");
  let activeSseConnections = 0;
  const activeSseClosers = new Set<() => void>();
  let monitorTimer: ReturnType<typeof setTimeout> | undefined;
  let monitorStopped = false;
  let monitorStarted = false;
  let monitorSignatures: Readonly<Record<string, string>> | undefined;
  const scheduleMonitor = (): void => {
    if (monitorStopped) return;
    monitorTimer = setTimeout(() => {
      void withTimeout(queryTimeoutMs, (queryOptions) => options.queryPort.getOverview(queryOptions))
        .then((overview) => {
          const next = Object.freeze({
            capabilities: JSON.stringify(overview.capabilities),
            sessions: JSON.stringify(overview.recentSessions),
            jobs: JSON.stringify(overview.jobs),
            alerts: String(overview.alertCount),
          });
          if (monitorSignatures !== undefined) {
            if (next.capabilities !== monitorSignatures["capabilities"]) publishInvalidation("capability.updated");
            if (next.sessions !== monitorSignatures["sessions"]) publishInvalidation("session.updated");
            if (next.jobs !== monitorSignatures["jobs"]) publishInvalidation("job.updated");
            if (next.alerts !== monitorSignatures["alerts"]) publishInvalidation("alert.updated");
          }
          monitorSignatures = next;
        })
        .catch(() => undefined)
        .finally(scheduleMonitor);
    }, pollingFallbackMs);
    monitorTimer.unref?.();
  };
  const ensureMonitor = (): void => {
    if (monitorStarted) return;
    monitorStarted = true;
    scheduleMonitor();
  };

  const server = http.createServer({
    maxHeaderSize: 16_384,
    requireHostHeader: true,
  }, async (request, response) => {
    applySafeHeaders(response);
    const boundary = hasTrustedRequestBoundary(request, request.method !== "GET" && request.method !== "HEAD");
    if (boundary === "REMOTE" || boundary === "HOST") {
      safeError(response, 403, "UNAUTHORIZED", "Request boundary rejected");
      return;
    }
    if (boundary === "ORIGIN") {
      safeError(response, 403, "FORBIDDEN_ORIGIN", "Request origin rejected");
      return;
    }
    const remoteKey = request.socket.remoteAddress ?? "unknown";
    if (!limiter.allow(remoteKey)) {
      response.setHeader("retry-after", "60");
      safeError(response, 429, "RATE_LIMITED", "Request rate limit exceeded");
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "/", `http://${request.headers.host as string}`);
    } catch {
      safeError(response, 400, "INVALID_REQUEST", "Invalid request URL");
      return;
    }

    if (url.pathname === "/api/v1/auth/exchange") {
      if (request.method !== "POST" || request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
        safeError(response, 405, "INVALID_REQUEST", "Bootstrap requires application/json POST");
        return;
      }
      if (url.search.length > 0) {
        safeError(response, 400, "INVALID_REQUEST", "Bootstrap query parameters are forbidden");
        return;
      }
      if (!bootstrapLimiter.allow(remoteKey)) {
        safeError(response, 429, "RATE_LIMITED", "Bootstrap rate limit exceeded");
        return;
      }
      try {
        const body = await readBoundedBody(request, MAX_BOOTSTRAP_BODY_BYTES);
        const decoded = JSON.parse(body.toString("utf8")) as unknown;
        if (typeof decoded !== "object" || decoded === null || Object.keys(decoded).length !== 1 || !("token" in decoded)
          || typeof (decoded as { token?: unknown }).token !== "string") {
          safeError(response, 400, "INVALID_REQUEST", "Invalid bootstrap request");
          return;
        }
        const exchange = sessionManager.exchange((decoded as { token: string }).token);
        if (!exchange) {
          safeError(response, 401, "UNAUTHORIZED", "Bootstrap token is invalid or expired");
          return;
        }
        response.setHeader("set-cookie", exchange.cookie);
        sendJson(response, 200, {
          schemaVersion: CONTROL_API_SCHEMA_VERSION,
          csrfToken: exchange.csrfToken,
          expiresAt: exchange.expiresAt,
        });
      } catch {
        if (!response.headersSent) safeError(response, 413, "INVALID_REQUEST", "Bootstrap request is invalid or too large");
      }
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      const csrfHeader = request.headers["x-zhiloop-csrf"];
      const authentication = sessionManager.authenticate(
        request.headers.cookie,
        Array.isArray(csrfHeader) ? undefined : csrfHeader,
      );
      if (!authentication.authenticated) {
        safeError(response, 401, "UNAUTHORIZED", "Browser session is missing or expired");
        return;
      }
      const nativeEventStream = request.method === "GET"
        && url.pathname === "/api/v1/invalidations"
        && url.searchParams.size === 0;
      if (!authentication.csrfValid && !nativeEventStream) {
        safeError(response, 403, "CSRF_REJECTED", "CSRF proof rejected");
        return;
      }
      const execute = <T>(schema: OutputSchema<T>, operation: (queryOptions: QueryOptions) => Promise<T>) =>
        executeView(response, schema, queryTimeoutMs, maximumJsonResponseBytes, operation);
      const executeCapture = <T>(schema: OutputSchema<T>, operation: (queryOptions: QueryOptions) => Promise<T>) =>
        executeCommand(response, schema, queryTimeoutMs, maximumJsonResponseBytes, operation);
      if (nativeEventStream) {
        ensureMonitor();
        if (activeSseConnections >= maximumSseConnections) {
          response.setHeader("retry-after", Math.ceil(pollingFallbackMs / 1_000));
          safeError(response, 503, "RATE_LIMITED", "SSE connection limit exceeded; use polling fallback");
          return;
        }
        const rawLastEventId = request.headers["last-event-id"];
        const lastEventId = typeof rawLastEventId === "string" ? parseRevision(rawLastEventId) : undefined;
        const invalidCursor = rawLastEventId !== undefined && lastEventId === undefined;
        const afterRevision = lastEventId ?? invalidationLog.currentRevision;
        const snapshot = invalidCursor ? undefined : invalidationLog.snapshot(afterRevision);
        response.statusCode = 200;
        response.setHeader("content-type", "text/event-stream; charset=utf-8");
        response.setHeader("connection", "keep-alive");
        response.setHeader("x-accel-buffering", "no");
        response.flushHeaders();
        response.write(`retry: ${pollingFallbackMs}\n\n`);
        if (invalidCursor || snapshot?.resyncRequired === true) {
          const resync = createResyncInvalidation(
            invalidationLog.currentRevision,
            invalidCursor ? "INVALID_CURSOR" : "STALE_REVISION",
          );
          response.write(encodeInvalidationFrame(resync));
        } else {
          for (const event of snapshot?.events ?? []) response.write(encodeInvalidationFrame(event));
        }
        let closed = false;
        let unsubscribe = (): void => undefined;
        const streamState: { heartbeat?: ReturnType<typeof setInterval> } = {};
        const closeStream = (): void => {
          if (closed) return;
          closed = true;
          unsubscribe();
          if (streamState.heartbeat) clearInterval(streamState.heartbeat);
          activeSseConnections -= 1;
          activeSseClosers.delete(closeStream);
          if (!response.destroyed) response.destroy();
        };
        const writeBounded = (frame: string): void => {
          if (closed) return;
          if (response.writableLength + Buffer.byteLength(frame) > maximumSsePendingBytes) {
            closeStream();
            return;
          }
          response.write(frame);
        };
        unsubscribe = invalidationLog.subscribe((_event, frame) => writeBounded(frame));
        streamState.heartbeat = setInterval(() => writeBounded(`: heartbeat revision=${invalidationLog.currentRevision}\n\n`), sseHeartbeatMs);
        streamState.heartbeat.unref();
        activeSseConnections += 1;
        activeSseClosers.add(closeStream);
        request.once("close", closeStream);
        return;
      }
      if (url.pathname === "/api/v1/invalidations/poll") {
        ensureMonitor();
        if (request.method !== "GET") {
          safeError(response, 405, "INVALID_REQUEST", "Invalidation polling requires GET");
          return;
        }
        for (const key of url.searchParams.keys()) {
          if (key !== "afterRevision" && key !== "limit") {
            safeError(response, 400, "INVALID_REQUEST", "Invalid invalidation polling query");
            return;
          }
        }
        if (url.searchParams.getAll("afterRevision").length !== 1 || url.searchParams.getAll("limit").length > 1) {
          safeError(response, 400, "INVALID_REQUEST", "Invalid invalidation polling query");
          return;
        }
        const afterRevision = parseRevision(url.searchParams.get("afterRevision"));
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit === null ? 100 : parseRevision(rawLimit);
        if (afterRevision === undefined || limit === undefined || limit < 1 || limit > MAX_POLL_INVALIDATIONS) {
          safeError(response, 400, "INVALID_REQUEST", "Invalid invalidation polling query");
          return;
        }
        const snapshot = invalidationLog.snapshot(afterRevision, Math.min(limit, invalidationLog.maximumEvents));
        const result: InvalidationPollResult = { ...snapshot, retryAfterMs: pollingFallbackMs };
        sendJson(response, 200, {
          schemaVersion: CONTROL_API_SCHEMA_VERSION,
          requestId: randomUUID(),
          observedAt: new Date().toISOString(),
          ok: true,
          result,
        }, maximumJsonResponseBytes);
        return;
      }
      const configurationCommand = url.pathname === `${CONSOLE_HTTP_API_PREFIX}${CONFIGURATION_HTTP_PATHS.draft}`
        ? "config.validate"
        : url.pathname === `${CONSOLE_HTTP_API_PREFIX}${CONFIGURATION_HTTP_PATHS.activate}`
          ? "config.activate"
          : url.pathname === `${CONSOLE_HTTP_API_PREFIX}${CONFIGURATION_HTTP_PATHS.rollback}`
            ? "config.rollback"
            : undefined;
      const extractionMatch = /^\/api\/v1\/sessions\/([^/]+)\/extraction(?:\/(preview|commit))?$/u.exec(url.pathname);
      if (extractionMatch !== null) {
        const parsedSession = sessionIdSchema.safeParse(decodePathSegment(extractionMatch[1]));
        const actionName = extractionMatch[2];
        if (!parsedSession.success || url.searchParams.size !== 0) { safeError(response, 400, "INVALID_REQUEST", "Invalid extraction target"); return; }
        if (actionName === undefined) {
          if (request.method !== "GET" || options.queryPort.getSessionExtraction === undefined) { safeError(response, 405, "CAPABILITY_UNAVAILABLE", "Extraction query is unavailable"); return; }
          await executeView(response, p2SessionExtractionViewSchema, queryTimeoutMs, maximumJsonResponseBytes, (queryOptions) => options.queryPort.getSessionExtraction!(parsedSession.data, queryOptions));
          return;
        }
        if (request.method !== "POST" || request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") { safeError(response, 405, "INVALID_REQUEST", "Extraction command requires JSON POST"); return; }
        const commandPort = options.commandPort;
        if (commandPort?.startSessionExtraction === undefined || commandPort.commitSessionExtraction === undefined) { safeError(response, 503, "CAPABILITY_UNAVAILABLE", "Extraction command is unavailable"); return; }
        try {
          const body = JSON.parse((await readBoundedBody(request, MAX_COMMAND_BODY_BYTES)).toString("utf8")) as unknown;
          const parsedBody = actionName === "preview" ? p2SessionPreviewCommandSchema.safeParse(body) : p2SessionCommitCommandSchema.safeParse(body);
          if (!parsedBody.success) { safeError(response, 400, "INVALID_REQUEST", "Invalid extraction command"); return; }
          await executeCommand(response, p2SessionExtractionViewSchema, queryTimeoutMs, maximumJsonResponseBytes, (queryOptions) => actionName === "preview"
            ? commandPort.startSessionExtraction!({ sessionId: parsedSession.data, ...(parsedBody.data as { expectedRevision: number; idempotencyKey: string }) }, queryOptions)
            : commandPort.commitSessionExtraction!({ sessionId: parsedSession.data, ...(parsedBody.data as { previewId: string; expectedPreviewRevision: number; idempotencyKey: string }) }, queryOptions));
        } catch { if (!response.headersSent) safeError(response, 400, "INVALID_REQUEST", "Invalid extraction command"); }
        return;
      }
      if (url.pathname === "/api/v1/knowledge" && request.method === "GET") {
        if (options.queryPort.listKnowledge === undefined) { safeError(response, 503, "CAPABILITY_UNAVAILABLE", "Knowledge query is unavailable"); return; }
        const filter: Record<string, unknown> = {};
        const allowed = new Set(["scope", "projectId", "kind", "status", "subject", "symbol", "keyword", "evidenceVerdict", "version", "eligible"]);
        for (const [key, value] of url.searchParams) {
          if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) { safeError(response, 400, "INVALID_REQUEST", "Invalid knowledge filter"); return; }
          if (key === "eligible" && value !== "true" && value !== "false") { safeError(response, 400, "INVALID_REQUEST", "Invalid knowledge filter"); return; }
          filter[key] = key === "version" ? Number(value) : key === "eligible" ? value === "true" : value;
        }
        const parsedFilter = p2KnowledgeFilterSchema.safeParse(filter);
        if (!parsedFilter.success) { safeError(response, 400, "INVALID_REQUEST", "Invalid knowledge filter"); return; }
        await executeView(response, p2KnowledgeListViewSchema, queryTimeoutMs, maximumJsonResponseBytes, (queryOptions) => options.queryPort.listKnowledge!(parsedFilter.data, queryOptions));
        return;
      }
      const knowledgeMatch = /^\/api\/v1\/knowledge\/([^/]+)(?:\/(edit-preview|edit-commit|suppress|restore|index-recover))?$/u.exec(url.pathname);
      if (knowledgeMatch !== null) {
        const knowledgeId = decodePathSegment(knowledgeMatch[1]);
        const actionName = knowledgeMatch[2];
        if (knowledgeId === undefined || !SAFE_KNOWLEDGE_ID.test(knowledgeId) || url.searchParams.size !== 0) { safeError(response, 400, "INVALID_REQUEST", "Invalid knowledge target"); return; }
        if (actionName === undefined) {
          if (request.method !== "GET" || options.queryPort.getKnowledge === undefined) { safeError(response, 405, "CAPABILITY_UNAVAILABLE", "Knowledge detail is unavailable"); return; }
          await executeView(response, p2KnowledgeDetailViewSchema, queryTimeoutMs, maximumJsonResponseBytes, (queryOptions) => options.queryPort.getKnowledge!(knowledgeId, queryOptions));
          return;
        }
        if (request.method !== "POST" || request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") { safeError(response, 405, "INVALID_REQUEST", "Knowledge command requires JSON POST"); return; }
        const commandPort = options.commandPort;
        try {
          const body = JSON.parse((await readBoundedBody(request, MAX_COMMAND_BODY_BYTES)).toString("utf8")) as unknown;
          if (actionName === "index-recover") {
            if (!hasExactBodyFields(body, []) || commandPort?.recoverKnowledgeIndex === undefined) throw new Error("invalid");
            await executeCommand(response, p2IndexRecoveryResultSchema, queryTimeoutMs, maximumJsonResponseBytes, (queryOptions) => commandPort.recoverKnowledgeIndex!(knowledgeId, queryOptions));
            return;
          }
          const edit = actionName === "edit-preview" || actionName === "edit-commit";
          const parsedBody = edit ? p2KnowledgeEditCommandBodySchema.safeParse(body) : p2KnowledgeLifecycleCommandBodySchema.safeParse(body);
          if (!parsedBody.success) throw new Error("invalid");
          const command = { knowledgeId, ...parsedBody.data };
          if (actionName === "edit-preview") {
            if (commandPort?.previewKnowledgeEdit === undefined) throw new Error("unavailable");
            await executeCommand(response, p2KnowledgeEditImpactSchema, queryTimeoutMs, maximumJsonResponseBytes, (queryOptions) => commandPort.previewKnowledgeEdit!(command, queryOptions));
          } else {
            const method = actionName === "edit-commit" ? commandPort?.commitKnowledgeEdit
              : actionName === "suppress" ? commandPort?.suppressKnowledge : commandPort?.restoreKnowledge;
            if (method === undefined) throw new Error("unavailable");
            await executeCommand(response, p2KnowledgeDetailViewSchema, queryTimeoutMs, maximumJsonResponseBytes, (queryOptions) => method.call(commandPort, command, queryOptions));
          }
        } catch { if (!response.headersSent) safeError(response, 400, "INVALID_REQUEST", "Invalid knowledge command"); }
        return;
      }
      const jobCommandMatch = /^\/api\/v1\/jobs\/([^/]+)\/(cancel|retry)$/u.exec(url.pathname);
      if (jobCommandMatch !== null) {
        if (request.method !== "POST" || url.searchParams.size !== 0 || request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
          safeError(response, 405, "INVALID_REQUEST", "Job command requires application/json POST");
          return;
        }
        const commandPort = options.commandPort;
        if (commandPort?.cancelJob === undefined || commandPort.retryJob === undefined) {
          safeError(response, 503, "CAPABILITY_UNAVAILABLE", "Job command capability is unavailable");
          return;
        }
        const cancelJob = commandPort.cancelJob.bind(commandPort);
        const retryJob = commandPort.retryJob.bind(commandPort);
        try {
          const decoded = JSON.parse((await readBoundedBody(request, MAX_COMMAND_BODY_BYTES)).toString("utf8")) as unknown;
          if (!hasExactBodyFields(decoded, ["expectedRevision", "idempotencyKey"])) {
            safeError(response, 400, "INVALID_REQUEST", "Invalid job command fields");
            return;
          }
          const parsedJobId = jobIdSchema.safeParse(jobCommandMatch[1]);
          const type = jobCommandMatch[2] === "cancel" ? "job.cancel" : "job.retry";
          const parsed = controlRequestSchema.safeParse({
            schemaVersion: CONTROL_API_SCHEMA_VERSION,
            requestId: randomUUID(),
            type,
            jobId: jobCommandMatch[1],
            ...decoded,
          });
          if (!parsedJobId.success || !parsed.success || (parsed.data.type !== "job.cancel" && parsed.data.type !== "job.retry")) {
            safeError(response, 400, "INVALID_REQUEST", "Invalid job command");
            return;
          }
          const jobRequest = parsed.data;
          await executeCommand(response, jobCommandResultSchema, queryTimeoutMs, maximumJsonResponseBytes, (queryOptions) => {
            const command = {
              jobId: jobRequest.jobId,
              expectedRevision: jobRequest.expectedRevision,
              idempotencyKey: jobRequest.idempotencyKey,
            };
            const operation = jobRequest.type === "job.cancel"
              ? cancelJob(command, queryOptions)
              : retryJob(command, queryOptions);
            return operation.then((result) => {
              publishInvalidation("job.updated", result.job.jobId);
              return result;
            });
          });
        } catch (error) {
          if (!response.headersSent) {
            safeError(response, error instanceof Error && error.message === "BODY_TOO_LARGE" ? 413 : 400, "INVALID_REQUEST", "Job command is invalid or too large");
          }
        }
        return;
      }
      if (configurationCommand !== undefined) {
        if (request.method !== "POST" || url.searchParams.size !== 0 || request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
          safeError(response, 405, "INVALID_REQUEST", "Configuration command requires application/json POST");
          return;
        }
        const commandPort = options.commandPort;
        if (commandPort === undefined) {
          safeError(response, 503, "CAPABILITY_UNAVAILABLE", "Configuration command capability is unavailable");
          return;
        }
        try {
          const decoded = JSON.parse((await readBoundedBody(request, MAX_COMMAND_BODY_BYTES)).toString("utf8")) as unknown;
          const fieldsValid = configurationCommand === "config.validate"
            ? hasExactBodyFields(decoded, ["baseRevision", "draft", "scope"], ["projectId"])
            : configurationCommand === "config.activate"
              ? hasExactBodyFields(decoded, ["draftRevision", "expectedRevision", "idempotencyKey"])
              : hasExactBodyFields(decoded, ["expectedRevision", "idempotencyKey", "targetRevision"]);
          if (!fieldsValid) {
            safeError(response, 400, "INVALID_REQUEST", "Invalid configuration command fields");
            return;
          }
          const parsed = controlRequestSchema.safeParse({
            schemaVersion: CONTROL_API_SCHEMA_VERSION,
            requestId: randomUUID(),
            type: configurationCommand,
            ...decoded as Record<string, unknown>,
          });
          if (!parsed.success || (parsed.data.type !== "config.validate" && parsed.data.type !== "config.activate" && parsed.data.type !== "config.rollback")) {
            safeError(response, 400, "INVALID_REQUEST", "Invalid configuration command");
            return;
          }
          const configurationRequest = parsed.data;
          if (configurationRequest.type === "config.validate") {
            await executeCommand(response, configurationValidationResultSchema, queryTimeoutMs, maximumJsonResponseBytes, (queryOptions) =>
              commandPort.validateConfiguration({
                baseRevision: configurationRequest.baseRevision,
                scope: configurationRequest.scope,
                ...(configurationRequest.projectId === undefined ? {} : { projectId: configurationRequest.projectId }),
                draft: configurationRequest.draft,
              }, queryOptions));
          } else if (configurationRequest.type === "config.activate") {
            await executeCommand(response, configurationMutationResultSchema, queryTimeoutMs, maximumJsonResponseBytes, (queryOptions) =>
              commandPort.activateConfiguration({
                expectedRevision: configurationRequest.expectedRevision,
                draftRevision: configurationRequest.draftRevision,
                idempotencyKey: configurationRequest.idempotencyKey,
              }, queryOptions).then((result) => {
                if (result.ok) publishInvalidation("configuration.updated", `configuration-${result.revision}`);
                return result;
              }), configurationMutationStatus);
          } else {
            await executeCommand(response, configurationMutationResultSchema, queryTimeoutMs, maximumJsonResponseBytes, (queryOptions) =>
              commandPort.rollbackConfiguration({
                expectedRevision: configurationRequest.expectedRevision,
                targetRevision: configurationRequest.targetRevision,
                idempotencyKey: configurationRequest.idempotencyKey,
              }, queryOptions).then((result) => {
                if (result.ok) publishInvalidation("configuration.updated", `configuration-${result.revision}`);
                return result;
              }), configurationMutationStatus);
          }
        } catch (error) {
          if (!response.headersSent) {
            safeError(response, error instanceof Error && error.message === "BODY_TOO_LARGE" ? 413 : 400, "INVALID_REQUEST", "Configuration command is invalid or too large");
          }
        }
        return;
      }
      if (url.pathname === "/api/v1/capture-jobs") {
        if (request.method !== "POST" || url.searchParams.size !== 0 || request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
          safeError(response, 405, "INVALID_REQUEST", "Capture command requires application/json POST");
          return;
        }
        const commandPort = options.commandPort;
        if (commandPort === undefined) {
          safeError(response, 503, "CAPABILITY_UNAVAILABLE", "Capture command capability is unavailable");
          return;
        }
        try {
          const decoded = JSON.parse((await readBoundedBody(request, MAX_COMMAND_BODY_BYTES)).toString("utf8")) as unknown;
          if (typeof decoded !== "object" || decoded === null || !("dryRun" in decoded) || typeof (decoded as { dryRun?: unknown }).dryRun !== "boolean") {
            safeError(response, 400, "INVALID_REQUEST", "Invalid capture command");
            return;
          }
          const dryRun = (decoded as { dryRun: boolean }).dryRun;
          const expectedKeys = dryRun
            ? ["dryRun", "sessionId"]
            : ["dryRun", "idempotencyKey", "previewRevision", "sessionId", "transcriptIdentityHash"];
          if (Object.keys(decoded).sort().join("|") !== expectedKeys.join("|")) {
            safeError(response, 400, "INVALID_REQUEST", "Invalid capture command fields");
            return;
          }
          const parsed = controlRequestSchema.safeParse(dryRun
            ? { schemaVersion: CONTROL_API_SCHEMA_VERSION, requestId: randomUUID(), type: "capture.preview", sessionId: (decoded as { sessionId?: unknown }).sessionId }
            : {
                schemaVersion: CONTROL_API_SCHEMA_VERSION,
                requestId: randomUUID(),
                type: "capture.commit",
                sessionId: (decoded as { sessionId?: unknown }).sessionId,
                previewRevision: (decoded as { previewRevision?: unknown }).previewRevision,
                transcriptIdentityHash: (decoded as { transcriptIdentityHash?: unknown }).transcriptIdentityHash,
                idempotencyKey: (decoded as { idempotencyKey?: unknown }).idempotencyKey,
              });
          if (!parsed.success || (parsed.data.type !== "capture.preview" && parsed.data.type !== "capture.commit")) {
            safeError(response, 400, "INVALID_REQUEST", "Invalid capture command");
            return;
          }
          const captureRequest = parsed.data;
          if (captureRequest.type === "capture.preview") {
            await executeCapture(capturePreviewSchema, (queryOptions) => commandPort.previewCapture(captureRequest.sessionId, queryOptions));
          } else {
            await executeCapture(captureCommitResultSchema, (queryOptions) => commandPort.commitCapture({
              sessionId: captureRequest.sessionId,
              previewRevision: captureRequest.previewRevision,
              transcriptIdentityHash: captureRequest.transcriptIdentityHash,
              idempotencyKey: captureRequest.idempotencyKey,
            }, queryOptions).then((result) => {
              publishInvalidation("session.updated", result.sessionId);
              return result;
            }));
          }
        } catch {
          if (!response.headersSent) safeError(response, 400, "INVALID_REQUEST", "Capture command is invalid or too large");
        }
        return;
      }
      if (request.method !== "GET") {
        safeError(response, 405, "INVALID_REQUEST", "Read-only endpoint requires GET");
        return;
      }
      if (url.pathname === `${CONSOLE_HTTP_API_PREFIX}${CONFIGURATION_HTTP_PATHS.view}`) {
        if (url.searchParams.getAll("projectId").length > 1 || [...url.searchParams.keys()].some((key) => key !== "projectId")) {
          safeError(response, 400, "INVALID_REQUEST", "Invalid configuration query");
          return;
        }
        const projectId = url.searchParams.get("projectId") ?? undefined;
        const parsed = controlRequestSchema.safeParse({
          schemaVersion: CONTROL_API_SCHEMA_VERSION,
          requestId: randomUUID(),
          type: "config.get",
          ...(projectId === undefined ? {} : { projectId }),
        });
        if (!parsed.success || parsed.data.type !== "config.get") {
          safeError(response, 400, "INVALID_REQUEST", "Invalid configuration query");
          return;
        }
        const configurationRequest = parsed.data;
        await execute(configurationStateSchema, (queryOptions) => options.queryPort.getConfiguration(configurationRequest.projectId, queryOptions));
        return;
      }
      const page = parsePage(url.searchParams);
      if (url.pathname === "/api/v1/overview" && url.searchParams.size === 0) {
        await execute(overviewSchema, (queryOptions) => options.queryPort.getOverview(queryOptions));
        return;
      }
      if (url.pathname === "/api/v1/capabilities" && page) {
        await execute(capabilityPageSchema, (queryOptions) => options.queryPort.listCapabilities(page, queryOptions));
        return;
      }
      if (url.pathname === "/api/v1/sessions" && page) {
        await execute(sessionPageSchema, (queryOptions) => options.queryPort.listSessions(page, queryOptions));
        return;
      }
      if (url.pathname === "/api/v1/jobs" && page) {
        await execute(jobPageSchema, (queryOptions) => options.queryPort.listJobs(page, queryOptions));
        return;
      }
      if (url.pathname === "/api/v1/diagnostics" && url.searchParams.size === 0) {
        await execute(diagnosticsSchema, (queryOptions) => options.queryPort.getDiagnostics(queryOptions));
        return;
      }
      if (url.pathname === "/api/v1/events" && page) {
        const sessionId = url.searchParams.get("sessionId");
        const parsedId = sessionIdSchema.safeParse(sessionId);
        if (!parsedId.success) {
          safeError(response, 400, "INVALID_REQUEST", "A valid sessionId is required");
          return;
        }
        await execute(eventMetadataPageSchema, (queryOptions) => options.queryPort.listSessionEvents(parsedId.data, page, queryOptions));
        return;
      }
      const detailMatch = /^\/api\/v1\/sessions\/([^/]+)$/u.exec(url.pathname);
      if (detailMatch) {
        const parsedId = sessionIdSchema.safeParse(detailMatch[1]);
        if (!parsedId.success || url.searchParams.size !== 0) {
          safeError(response, 400, "INVALID_REQUEST", "A valid sessionId is required");
          return;
        }
        await execute(sessionDetailSchema, (queryOptions) => options.queryPort.getSession(parsedId.data, queryOptions));
        return;
      }
      safeError(response, page === undefined ? 400 : 404, page === undefined ? "INVALID_REQUEST" : "NOT_FOUND", page === undefined ? "Invalid pagination query" : "Endpoint not found");
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && url.searchParams.size === 0) {
      const asset = await staticAssets.read(url.pathname);
      if (asset) {
        response.statusCode = 200;
        response.setHeader("content-type", asset.contentType);
        response.setHeader("content-length", asset.body.byteLength);
        response.end(request.method === "HEAD" ? undefined : asset.body);
        return;
      }
    }
    safeError(response, 404, "NOT_FOUND", "Resource not found");
  });

  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 2_000;
  server.maxRequestsPerSocket = 100;

  let listeningAddress: ConsoleGatewayAddress | undefined;
  return {
    async listen() {
      if (listeningAddress) return listeningAddress;
      server.listen(port, host);
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Console Gateway did not bind a TCP address");
      const authority = address.address.includes(":") ? `[${address.address}]:${address.port}` : `${address.address}:${address.port}`;
      const origin = `http://${authority}`;
      listeningAddress = {
        host: address.address,
        port: address.port,
        origin,
        bootstrapUrl: `${origin}/#bootstrap=${encodeURIComponent(bootstrapToken)}`,
      };
      return listeningAddress;
    },
    async close() {
      if (!server.listening) return;
      monitorStopped = true;
      if (monitorTimer !== undefined) clearTimeout(monitorTimer);
      for (const closeStream of [...activeSseClosers]) closeStream();
      server.close();
      await once(server, "close");
      listeningAddress = undefined;
    },
  };
}
