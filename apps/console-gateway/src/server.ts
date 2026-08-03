import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

import {
  CONTROL_API_SCHEMA_VERSION,
  capabilityPageSchema,
  diagnosticsSchema,
  eventMetadataPageSchema,
  jobPageSchema,
  overviewSchema,
  pageRequestSchema,
  sessionDetailSchema,
  sessionIdSchema,
  sessionPageSchema,
} from "@zhiloop/control-api";

import { BrowserSessionManager, createBootstrapToken } from "./auth.js";
import type { ControlQueryPort, PageQuery, QueryOptions } from "./ports.js";
import {
  FixedWindowRateLimiter,
  applySafeHeaders,
  assertLoopbackBind,
  hasTrustedRequestBoundary,
} from "./security.js";
import { StaticAssetStore } from "./static-assets.js";

const MAX_BOOTSTRAP_BODY_BYTES = 8_192;
const MAX_JSON_RESPONSE_BYTES = 1_048_576;

interface OutputSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export interface ConsoleGatewayOptions {
  readonly queryPort: ControlQueryPort;
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

type ControlErrorCode = "UNAUTHORIZED" | "FORBIDDEN_ORIGIN" | "CSRF_REJECTED" | "NOT_FOUND" | "INVALID_REQUEST" | "RATE_LIMITED" | "SIDECAR_UNAVAILABLE" | "INTERNAL_ERROR";

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
      if (!authentication.csrfValid) {
        safeError(response, 403, "CSRF_REJECTED", "CSRF proof rejected");
        return;
      }
      if (request.method !== "GET") {
        safeError(response, 405, "INVALID_REQUEST", "Read-only endpoint requires GET");
        return;
      }
      const page = parsePage(url.searchParams);
      const execute = <T>(schema: OutputSchema<T>, operation: (queryOptions: QueryOptions) => Promise<T>) =>
        executeView(response, schema, queryTimeoutMs, maximumJsonResponseBytes, operation);
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
      server.close();
      await once(server, "close");
      listeningAddress = undefined;
    },
  };
}
