import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { QueryContext } from "@zhiloop/query-context";

import type {
  McpExpansionResult,
  VersionedMcpRequest,
  VersionedMcpResponse,
  VersionedMcpRuntimeDependencies,
} from "./types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/u;

class McpDeadlineError extends Error {}

function canonicalTimestamp(now: () => Date): string {
  return now().toISOString();
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

function expansionId(parts: readonly unknown[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 32);
  return `mcp-expansion-${digest}`;
}

function validateEnvelope(request: VersionedMcpRequest, maximumBytes: number): void {
  const encoded = JSON.stringify(request);
  if (Buffer.byteLength(encoded, "utf8") > maximumBytes) throw new Error("MCP request exceeds byte limit");
  if (request.schemaVersion !== 1 || !SAFE_ID.test(request.requestId)) throw new Error("MCP request envelope is invalid");
  if (request.tool === "ckl.get" && request.attemptId !== undefined && !SAFE_ID.test(request.attemptId)) {
    throw new Error("MCP injection attempt identity is invalid");
  }
  const allowed = new Set(["schemaVersion", "requestId", "context", "tool", "input", ...(request.tool === "ckl.get" ? ["attemptId"] : [])]);
  if (Object.keys(request).some((key) => !allowed.has(key))) throw new Error("MCP request contains an unknown field");
}

function redactInvisibleDiagnostics<T extends { readonly diagnostics: readonly string[] }>(result: T): T {
  return {
    ...result,
    diagnostics: result.diagnostics.map((diagnostic) => diagnostic.split(":", 1)[0] as string),
  };
}

async function withinDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  externalSignal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  if (externalSignal.aborted) throw externalSignal.reason instanceof Error ? externalSignal.reason : new Error("MCP request aborted");
  const controller = new AbortController();
  const abort = (): void => controller.abort(externalSignal.reason);
  externalSignal.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new McpDeadlineError("MCP request deadline exceeded");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    externalSignal.removeEventListener("abort", abort);
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class VersionedKnowledgeMcpRuntime {
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  readonly #maxRequestBytes: number;

  constructor(private readonly dependencies: VersionedMcpRuntimeDependencies) {
    this.#now = dependencies.now ?? (() => new Date());
    this.#timeoutMs = dependencies.timeoutMs ?? 2_000;
    this.#maxRequestBytes = dependencies.maxRequestBytes ?? 64 * 1024;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 30_000) {
      throw new Error("MCP timeout must be within 1..30000ms");
    }
    if (!Number.isSafeInteger(this.#maxRequestBytes) || this.#maxRequestBytes < 1_024 || this.#maxRequestBytes > 1024 * 1024) {
      throw new Error("MCP request byte limit must be within 1024..1048576");
    }
  }

  async handle(request: VersionedMcpRequest, signal: AbortSignal): Promise<McpExpansionResult> {
    validateEnvelope(request, this.#maxRequestBytes);
    const started = performance.now();
    let authoritativeContext: QueryContext | undefined;
    const result = await withinDeadline(async (boundedSignal) => {
      const context = await this.dependencies.contextAuthority.authorize(request.context, boundedSignal);
      authoritativeContext = context;
      if (boundedSignal.aborted) throw boundedSignal.reason instanceof Error ? boundedSignal.reason : new Error("MCP authorization aborted");
      switch (request.tool) {
        case "ckl.search": return this.dependencies.service.search(request.input, context, boundedSignal);
        case "ckl.get": return this.dependencies.service.get(request.input, context, boundedSignal);
        case "ckl.related": return this.dependencies.service.related(request.input, context, boundedSignal);
        case "ckl.check": return this.dependencies.service.check(request.input, context, boundedSignal);
      }
    }, signal, this.#timeoutMs);
    const safeResult: VersionedMcpResponse["result"] = request.tool === "ckl.search" || request.tool === "ckl.related"
      ? redactInvisibleDiagnostics(result as Awaited<ReturnType<VersionedMcpRuntimeDependencies["service"]["search"]>>)
      : result;
    const response: VersionedMcpResponse = Object.freeze({
      schemaVersion: 1,
      requestId: request.requestId,
      tool: request.tool,
      dataClassification: "UNTRUSTED_KNOWLEDGE_DATA",
      instructionsAccepted: false,
      result: safeResult,
    });
    if (request.tool !== "ckl.get") return { response, expansionAudits: [] };

    const latencyMs = Math.max(0, Math.round(performance.now() - started));
    const getResult = result as Awaited<ReturnType<VersionedMcpRuntimeDependencies["service"]["get"]>>;
    const expansionAudits = getResult.items.map((item) => {
      const attribution = request.attemptId ?? "STANDALONE";
      const record = {
        schemaVersion: 1 as const,
        expansionId: expansionId([
          request.requestId, attribution, getResult.traceId,
          item.id, item.version, item.fromDetailLevel, item.toDetailLevel,
        ]),
        ...(request.attemptId === undefined ? {} : { attemptId: request.attemptId }),
        traceId: getResult.traceId,
        tool: "ckl.get" as const,
        knowledgeId: item.id,
        knowledgeVersion: item.version,
        fromDetailLevel: item.fromDetailLevel,
        toDetailLevel: item.toDetailLevel,
        latencyMs,
        used: false,
        occurredAt: canonicalTimestamp(this.#now),
      };
      const existing = this.dependencies.audits.getMcpExpansion(record.expansionId);
      if (existing !== undefined && (
        existing.attemptId !== record.attemptId || existing.traceId !== record.traceId
        || existing.knowledgeId !== record.knowledgeId || existing.knowledgeVersion !== record.knowledgeVersion
        || existing.fromDetailLevel !== record.fromDetailLevel || existing.toDetailLevel !== record.toDetailLevel
      )) throw new Error("MCP expansion identity conflicts with the audited version and detail transition");
      const audit = existing ?? this.dependencies.audits.recordMcpExpansion(record);
      this.dependencies.feedback.recordExpansion({
        expansionId: audit.expansionId,
        assetId: audit.knowledgeId,
        scopeKey: scopeKey(authoritativeContext ?? request.context),
        traceId: audit.traceId,
        occurredAt: audit.occurredAt,
      });
      return audit;
    });
    return { response, expansionAudits };
  }
}
