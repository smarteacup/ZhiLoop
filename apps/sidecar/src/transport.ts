import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import {
  p2ControlRequestSchema,
  parseControlRequestText,
  parseP2ContractText,
  type ControlRequest,
  type P2ControlRequest,
} from "@zhiloop/control-api";
import {
  p3ConsoleTransportRequestSchema,
  type P3ConsoleTransportRequest,
} from "@zhiloop/p3-console-runtime";
import type { VersionedMcpRequest } from "@zhiloop/active-knowledge-runtime";

import type { SidecarApplication } from "./application.js";
import { parseP2ConsoleRequest, type P2ConsoleRequest } from "./p2-console.js";
import { parseP4ConsoleRequest, type P4ConsoleTransportRequest } from "./p4-console.js";

const MAX_TRANSPORT_BYTES = 5_500_000;
const MAX_RESPONSE_BYTES = 1_048_576;

export type SidecarRequest =
  | { readonly type: "hook"; readonly input: unknown }
  | { readonly type: "mcp"; readonly request: VersionedMcpRequest }
  | {
    readonly type: "injection-delivery.ack";
    readonly attemptId: string;
    readonly expectedRevision: number;
    readonly deliveryEvidenceRef: string;
    readonly deliveredAt: string;
  }
  | { readonly type: "health" }
  | { readonly type: "worker" }
  | { readonly type: "capture-session"; readonly sessionId: string; readonly dryRun: boolean }
  | { readonly type: "acceptance.verify"; readonly sessionId: string; readonly taskCreatedAt: string }
  | ControlRequest
  | P2ControlRequest
  | P2ConsoleRequest
  | P3ConsoleTransportRequest
  | P4ConsoleTransportRequest;

interface SidecarResponse {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly errorCode?: string;
  readonly errorLineNumber?: number;
  readonly errorByteOffset?: number;
}

export class SidecarRequestError extends Error {
  readonly lineNumber?: number;
  readonly byteOffset?: number;

  constructor(code: string, options: { readonly lineNumber?: number; readonly byteOffset?: number } = {}) {
    super(`sidecar request failed: ${code}`);
    this.name = "SidecarRequestError";
    this.code = code;
    if (options.lineNumber !== undefined) this.lineNumber = options.lineNumber;
    if (options.byteOffset !== undefined) this.byteOffset = options.byteOffset;
  }

  readonly code: string;
}

function errorCode(error: unknown): string {
  if (error instanceof SyntaxError) return "INVALID_JSON";
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code.slice(0, 100);
  return "REQUEST_FAILED";
}

function parseRequest(value: unknown): SidecarRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid request");
  const type = (value as { type?: unknown }).type;
  if (type === "hook") return { type, input: (value as { input?: unknown }).input };
  if (type === "mcp") {
    if (Object.keys(value).some((key) => key !== "type" && key !== "request") || !("request" in value)) {
      throw Object.assign(new Error("invalid MCP transport request"), { code: "INVALID_REQUEST" });
    }
    return { type, request: value.request as VersionedMcpRequest };
  }
  if (type === "injection-delivery.ack") {
    const allowed = new Set(["type", "attemptId", "expectedRevision", "deliveryEvidenceRef", "deliveredAt"]);
    const attemptId = (value as Record<string, unknown>)["attemptId"];
    const expectedRevision = (value as Record<string, unknown>)["expectedRevision"];
    const deliveryEvidenceRef = (value as Record<string, unknown>)["deliveryEvidenceRef"];
    const deliveredAt = (value as Record<string, unknown>)["deliveredAt"];
    if (Object.keys(value).some((key) => !allowed.has(key))
      || typeof attemptId !== "string" || typeof deliveryEvidenceRef !== "string"
      || !Number.isSafeInteger(expectedRevision) || expectedRevision !== 1
      || typeof deliveredAt !== "string" || !Number.isFinite(Date.parse(deliveredAt))
      || new Date(Date.parse(deliveredAt)).toISOString() !== deliveredAt) {
      throw Object.assign(new Error("invalid injection delivery acknowledgement"), { code: "INVALID_REQUEST" });
    }
    return { type, attemptId, expectedRevision: 1, deliveryEvidenceRef, deliveredAt };
  }
  if (type === "health" || type === "worker") return { type };
  if (type === "capture-session") {
    const sessionId = (value as { sessionId?: unknown }).sessionId;
    const dryRun = (value as { dryRun?: unknown }).dryRun;
    if (typeof sessionId !== "string" || typeof dryRun !== "boolean") throw new Error("invalid capture-session request");
    return { type, sessionId, dryRun };
  }
  if (type === "acceptance.verify") {
    const sessionId = (value as { sessionId?: unknown }).sessionId;
    const taskCreatedAt = (value as { taskCreatedAt?: unknown }).taskCreatedAt;
    if (
      typeof sessionId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,999}$/u.test(sessionId)
      || typeof taskCreatedAt !== "string"
      || !Number.isFinite(Date.parse(taskCreatedAt))
    ) {
      const error = new Error("invalid acceptance.verify request") as Error & { code: string };
      error.code = "INVALID_ACCEPTANCE_REQUEST";
      throw error;
    }
    return { type, sessionId, taskCreatedAt };
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("invalid request");
  if (typeof type === "string" && type.startsWith("p2.")) return parseP2ConsoleRequest(value);
  if (typeof type === "string" && type.startsWith("p3.")) {
    const parsed = p3ConsoleTransportRequestSchema.safeParse(value);
    if (!parsed.success) {
      const error = new Error("invalid P3 control request") as Error & { code: string };
      error.code = "INVALID_REQUEST";
      throw error;
    }
    return parsed.data;
  }
  if (typeof type === "string" && type.startsWith("p4.")) return parseP4ConsoleRequest(value);
  if (typeof type === "string" && (type.startsWith("extraction.") || type.startsWith("knowledge.migrations."))) {
    const parsed = parseP2ContractText(serialized, p2ControlRequestSchema);
    if (!parsed.ok) {
      const error = new Error("invalid P2 control request") as Error & { code: string };
      error.code = parsed.code;
      throw error;
    }
    return parsed.value;
  }
  const parsed = parseControlRequestText(serialized);
  if (!parsed.ok) {
    const error = new Error("invalid control request") as Error & { code: string };
    error.code = parsed.code;
    throw error;
  }
  return parsed.value;
}

async function readOne(socket: Socket, maximum: number): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    const fail = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onError = (error: Error): void => fail(error);
    const onEnd = (): void => fail(new SyntaxError("transport message ended before newline"));
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maximum) {
        fail(new RangeError("transport message too large"));
        return;
      }
      chunks.push(chunk);
      const newline = chunk.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== chunk.length - 1) {
        fail(new SyntaxError("transport accepts exactly one frame per connection"));
        return;
      }
      const combined = chunks.length === 1 ? chunk : Buffer.concat(chunks, size);
      cleanup();
      try {
        resolve(JSON.parse(combined.subarray(0, combined.length - 1).toString("utf8")) as unknown);
      } catch (error) {
        reject(error);
      }
    };
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
  });
}

async function handle(socket: Socket, application: SidecarApplication): Promise<void> {
  let response: SidecarResponse;
  const controller = new AbortController();
  const cancel = (): void => controller.abort("TRANSPORT_CLOSED");
  socket.once("close", cancel);
  try {
    const request = parseRequest(await readOne(socket, MAX_TRANSPORT_BYTES));
    const result = request.type === "hook"
      ? await application.handleHookForTransport(request.input).then((hook) => hook.delivery === undefined ? hook.hookOutput : hook)
      : request.type === "mcp"
        ? await application.handleMcp(request.request, controller.signal)
        : request.type === "injection-delivery.ack"
          ? application.acknowledgeInjectionDelivery(request)
      : request.type === "health"
        ? await application.health()
        : request.type === "worker"
          ? await application.runWorkerOnce()
          : request.type === "capture-session"
            ? await application.captureSession({ sessionId: request.sessionId, dryRun: request.dryRun })
            : request.type === "acceptance.verify"
              ? await application.verifyRealCodexIngestion({ sessionId: request.sessionId, taskCreatedAt: request.taskCreatedAt })
            : request.type.startsWith("p3.")
              ? await application.handleP3Console(request as P3ConsoleTransportRequest, controller.signal)
            : request.type.startsWith("p4.")
              ? await application.handleP4Console(request as P4ConsoleTransportRequest, controller.signal)
            : request.type.startsWith("p2.")
              ? await application.handleP2Console(request as P2ConsoleRequest)
            : await application.handleControl(request as ControlRequest | P2ControlRequest);
    response = { ok: true, result };
  } catch (error) {
    const lineNumber = error instanceof Error && "lineNumber" in error && typeof error.lineNumber === "number" && Number.isSafeInteger(error.lineNumber)
      ? error.lineNumber as number
      : undefined;
    const byteOffset = error instanceof Error && "byteOffset" in error && typeof error.byteOffset === "number" && Number.isSafeInteger(error.byteOffset)
      ? error.byteOffset as number
      : undefined;
    response = {
      ok: false,
      errorCode: errorCode(error),
      ...(lineNumber === undefined ? {} : { errorLineNumber: lineNumber }),
      ...(byteOffset === undefined ? {} : { errorByteOffset: byteOffset }),
    };
  }
  if (!socket.destroyed) {
    let serialized = `${JSON.stringify(response)}\n`;
    if (Buffer.byteLength(serialized) > MAX_RESPONSE_BYTES) {
      serialized = `${JSON.stringify({ ok: false, errorCode: "RESPONSE_TOO_LARGE" })}\n`;
    }
    socket.end(serialized);
  }
  socket.off("close", cancel);
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isSocket()) throw new Error("socket target must be absent or a Unix socket");
    if (await socketIsLive(path)) throw new Error("another ZhiLoop sidecar already owns the Unix socket");
    await unlink(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

async function socketIsLive(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise, reject) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(value);
    };
    const timer = setTimeout(() => finish(true), 100);
    socket.once("connect", () => finish(true));
    socket.once("error", (error: Error & { code?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolvePromise(false);
      else reject(error);
    });
  });
}

export async function startSidecarServer(path: string, application: SidecarApplication): Promise<Server> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await removeStaleSocket(path);
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    void handle(socket, application).catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => reject(error);
    server.once("error", failed);
    server.listen(path, () => {
      server.off("error", failed);
      resolve();
    });
  });
  if (process.platform !== "win32") await chmod(path, 0o600);
  return server;
}

export async function stopSidecarServer(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  await unlink(path).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  });
}

export async function requestSidecar(path: string, request: SidecarRequest, timeoutMs: number): Promise<unknown> {
  const socket = createConnection(path);
  const timer = setTimeout(() => socket.destroy(new SidecarRequestError("SIDECAR_UNAVAILABLE")), timeoutMs);
  timer.unref?.();
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(`${JSON.stringify(request)}\n`);
    const response = await readOne(socket, MAX_RESPONSE_BYTES) as SidecarResponse;
    if (typeof response !== "object" || response === null || response.ok !== true) {
      throw new SidecarRequestError(
        typeof response?.errorCode === "string" ? response.errorCode : "INVALID_RESPONSE",
        {
          ...(Number.isSafeInteger(response?.errorLineNumber) ? { lineNumber: response.errorLineNumber } : {}),
          ...(Number.isSafeInteger(response?.errorByteOffset) ? { byteOffset: response.errorByteOffset } : {}),
        },
      );
    }
    return response.result;
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}
