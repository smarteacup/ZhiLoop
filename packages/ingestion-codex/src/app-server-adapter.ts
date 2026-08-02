import { createHash } from "node:crypto";

import type { EventEnvelope, EventType } from "@zhiloop/domain";
import { parseEventEnvelope } from "@zhiloop/schemas";

import { canonicalStringify, normalizeJson } from "./canonical-json.js";
import {
  SUPPORTED_APP_SERVER_NOTIFICATIONS,
  type AppServerAdaptBatch,
  type AppServerAdaptResult,
  type AppServerAdapterOptions,
  type AppServerDiagnostic,
  type CodexAppServerPayload,
  type SupportedAppServerNotification,
} from "./app-server-types.js";
import type { JsonValue } from "./types.js";

const DEFAULT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_STATE_ENTRIES = 10_000;
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const supportedMethods = new Set<string>(SUPPORTED_APP_SERVER_NOTIFICATIONS);
const TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
  "sleep",
  "imageGeneration",
]);

interface ThreadMetadata {
  readonly cwd?: string;
  readonly sourceVersion?: string;
}

interface FinalMessage {
  readonly text: string;
  readonly authoritative: boolean;
}

interface BuildEventInput {
  readonly eventType: EventType;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly sourceItemId: string;
  readonly occurredAt: string;
  readonly payload: CodexAppServerPayload;
  readonly cwd?: string;
  readonly sourceVersion?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) throw new Error(`$.${key} must be an object`);
  return value;
}

function requiredString(record: Record<string, unknown>, key: string, path = "$."): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path}${key} must be a non-empty string`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`$.${key} must be a non-empty string or null`);
  return value;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`$.${key} must be a boolean or null`);
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value)).digest("hex");
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function validIso(value: string): boolean {
  const match = ISO_DATE_TIME.exec(value);
  if (match === null || Number.isNaN(Date.parse(value))) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth &&
    Number(hourText) <= 23 && Number(minuteText) <= 59 && Number(secondText) <= 59 &&
    Number(offsetHourText ?? 0) <= 23 && Number(offsetMinuteText ?? 0) <= 59;
}

function dateFromNumber(value: unknown, unit: "seconds" | "milliseconds", path: string): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${path} timestamp must be a non-negative finite number`);
  try {
    return new Date(unit === "seconds" ? value * 1_000 : value).toISOString();
  } catch {
    throw new Error(`${path} timestamp is outside the supported date range`);
  }
}

function fallbackObservedAt(options: AppServerAdapterOptions): string {
  if (options.observedAt !== undefined) {
    if (!validIso(options.observedAt)) throw new Error("$.options.observedAt timestamp must be an ISO date-time");
    return options.observedAt;
  }
  const value = (options.clock ?? (() => new Date()))();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error("$.options.clock returned an invalid timestamp");
  return value.toISOString();
}

function errorResult(
  code: AppServerDiagnostic["code"],
  message: string,
  path = "$",
  issueCode = code.toLowerCase(),
): AppServerAdaptResult {
  return { ok: false, error: { code, message, issues: [{ path, code: issueCode, message }] } };
}

function ignored(reason: AppServerAdaptBatch["ignoredReason"]): AppServerAdaptResult {
  return { ok: true, value: { events: [], ignored: true, ...(reason === undefined ? {} : { ignoredReason: reason }) } };
}

function boundedSet(map: Map<string, true>, key: string, maximum: number): boolean {
  if (map.has(key)) return false;
  map.set(key, true);
  if (map.size > maximum) map.delete(map.keys().next().value as string);
  return true;
}

function boundedMap<K, V>(map: Map<K, V>, key: K, value: V, maximum: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > maximum) map.delete(map.keys().next().value as K);
}

function itemId(item: Record<string, unknown>): string {
  return requiredString(item, "id", "$.params.item.");
}

function userPrompt(item: Record<string, unknown>): { prompt: string; content: JsonValue } {
  const content = item["content"];
  if (!Array.isArray(content)) throw new Error("$.params.item.content must be an array");
  const normalized = normalizeJson(content, "$.params.item.content");
  const prompt = content
    .filter((entry): entry is Record<string, unknown> => isRecord(entry) && entry["type"] === "text")
    .map((entry) => requiredString(entry, "text", "$.params.item.content[]."))
    .join("\n\n");
  return { prompt, content: normalized };
}

function toolName(item: Record<string, unknown>): string {
  const type = requiredString(item, "type", "$.params.item.");
  if (type === "mcpToolCall") return `${requiredString(item, "server", "$.params.item.")}.${requiredString(item, "tool", "$.params.item.")}`;
  if (type === "dynamicToolCall") {
    const namespace = optionalString(item, "namespace");
    const tool = requiredString(item, "tool", "$.params.item.");
    return namespace === undefined ? tool : `${namespace}.${tool}`;
  }
  if (type === "collabAgentToolCall") return `collaboration.${requiredString(item, "tool", "$.params.item.")}`;
  return type;
}

function toolPayload(item: Record<string, unknown>): CodexAppServerPayload {
  const type = requiredString(item, "type", "$.params.item.");
  const id = itemId(item);
  if (item["status"] === "inProgress") throw new Error("$.params.item.status must be terminal for item/completed");
  let input: JsonValue;
  let response: JsonValue;
  if (type === "commandExecution") {
    input = normalizeJson({ command: item["command"], cwd: item["cwd"], commandActions: item["commandActions"] }, "$.params.item.command");
    response = normalizeJson({ status: item["status"], aggregatedOutput: item["aggregatedOutput"], exitCode: item["exitCode"], durationMs: item["durationMs"] }, "$.params.item.response");
  } else if (type === "mcpToolCall" || type === "dynamicToolCall") {
    input = normalizeJson(item["arguments"], "$.params.item.arguments");
    response = normalizeJson({ status: item["status"], result: item["result"] ?? item["contentItems"] ?? null, error: item["error"] ?? null, success: item["success"] ?? null, durationMs: item["durationMs"] ?? null }, "$.params.item.response");
  } else {
    input = normalizeJson({ itemType: type }, "$.params.item.input");
    response = normalizeJson(item, "$.params.item");
  }
  return { kind: "tool-completed", toolName: toolName(item), toolUseId: id, toolInput: input, toolResponse: response };
}

export class CodexAppServerEventAdapter {
  readonly #options: AppServerAdapterOptions;
  readonly #maxStateEntries: number;
  readonly #seen = new Map<string, true>();
  readonly #threads = new Map<string, ThreadMetadata>();
  readonly #messages = new Map<string, FinalMessage>();

  constructor(options: AppServerAdapterOptions = {}) {
    const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    const maxStateEntries = options.maxStateEntries ?? DEFAULT_MAX_STATE_ENTRIES;
    if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1) throw new Error("maxPayloadBytes must be a positive safe integer");
    if (!Number.isSafeInteger(maxStateEntries) || maxStateEntries < 1) throw new Error("maxStateEntries must be a positive safe integer");
    if (options.sourceVersion !== undefined && options.sourceVersion.length === 0) throw new Error("sourceVersion must be non-empty");
    this.#options = { ...options, maxPayloadBytes };
    this.#maxStateEntries = maxStateEntries;
  }

  #metadata(threadId: string): ThreadMetadata {
    return this.#threads.get(threadId) ?? {
      ...(this.#options.sourceVersion === undefined ? {} : { sourceVersion: this.#options.sourceVersion }),
    };
  }

  #build(input: BuildEventInput): EventEnvelope<CodexAppServerPayload> {
    const payloadJson = canonicalStringify(input.payload);
    if (Buffer.byteLength(payloadJson, "utf8") > (this.#options.maxPayloadBytes as number)) {
      throw new RangeError(`normalized App Server payload exceeds ${String(this.#options.maxPayloadBytes)} bytes`);
    }
    const contentHash = createHash("sha256").update(payloadJson).digest("hex");
    const eventId = hash(["codex-app-server", input.sessionId, input.turnId ?? null, input.eventType, input.sourceItemId, contentHash]);
    const envelope: EventEnvelope<CodexAppServerPayload> = {
      schemaVersion: 1,
      eventId,
      source: "codex-app-server",
      ...(input.sourceVersion === undefined ? {} : { sourceVersion: input.sourceVersion }),
      sourceItemId: input.sourceItemId,
      eventType: input.eventType,
      sessionId: input.sessionId,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      occurredAt: input.occurredAt,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      contentHash,
      correlationId: hash([input.sessionId, input.turnId ?? null]),
      payload: deepFreeze(input.payload),
    };
    const parsed = parseEventEnvelope(envelope);
    if (!parsed.ok) throw new TypeError(`INTERNAL_ENVELOPE_INVALID:${parsed.error.message}`);
    return deepFreeze(envelope);
  }

  #mapItem(item: Record<string, unknown>, threadId: string, turnId: string, occurredAt: string): EventEnvelope<CodexAppServerPayload> | undefined {
    const type = requiredString(item, "type", "$.params.item.");
    const metadata = this.#metadata(threadId);
    if (type === "agentMessage") {
      const text = requiredString(item, "text", "$.params.item.");
      const phase = item["phase"];
      if (phase !== null && phase !== undefined && phase !== "commentary" && phase !== "final_answer") throw new Error("$.params.item.phase is unsupported");
      const key = `${threadId}\0${turnId}`;
      const previous = this.#messages.get(key);
      const authoritative = phase === "final_answer";
      if (previous === undefined || authoritative || !previous.authoritative) boundedMap(this.#messages, key, { text, authoritative }, this.#maxStateEntries);
      return undefined;
    }
    if (type === "userMessage") {
      const normalized = userPrompt(item);
      return this.#build({ eventType: "user.prompted", sessionId: threadId, turnId, sourceItemId: itemId(item), occurredAt, payload: { kind: "user-prompt", ...normalized }, ...metadata });
    }
    if (type === "fileChange") {
      const status = requiredString(item, "status", "$.params.item.");
      return this.#build({ eventType: "file.changed", sessionId: threadId, turnId, sourceItemId: itemId(item), occurredAt, payload: { kind: "app-server-file-changed", status, changes: normalizeJson(item["changes"], "$.params.item.changes") }, ...metadata });
    }
    if (TOOL_ITEM_TYPES.has(type)) {
      return this.#build({ eventType: "tool.completed", sessionId: threadId, turnId, sourceItemId: itemId(item), occurredAt, payload: toolPayload(item), ...metadata });
    }
    return undefined;
  }

  #deduplicate(events: readonly EventEnvelope<CodexAppServerPayload>[]): AppServerAdaptResult {
    const unique = events.filter((event) => boundedSet(this.#seen, event.eventId, this.#maxStateEntries));
    if (unique.length === 0 && events.length > 0) return ignored("DUPLICATE_IN_CONNECTION");
    return { ok: true, value: { events: Object.freeze(unique), ignored: unique.length === 0 } };
  }

  adapt(input: unknown): AppServerAdaptResult {
    if (!isRecord(input)) return errorResult("INVALID_APP_SERVER_NOTIFICATION", "App Server notification must be a JSON object");
    if (Object.hasOwn(input, "id")) return errorResult("INVALID_APP_SERVER_NOTIFICATION", "App Server notifications must not contain id", "$.id");
    const method = input["method"];
    if (typeof method !== "string" || method.length === 0) return errorResult("INVALID_APP_SERVER_NOTIFICATION", "$.method must be a non-empty string", "$.method");
    if (!supportedMethods.has(method)) return errorResult("UNSUPPORTED_APP_SERVER_NOTIFICATION", `unsupported App Server notification: ${method}`, "$.method", "unsupported_notification");
    try {
      const rawBytes = Buffer.byteLength(canonicalStringify(input), "utf8");
      if (rawBytes > (this.#options.maxPayloadBytes as number)) return errorResult("APP_SERVER_NOTIFICATION_TOO_LARGE", `App Server notification is ${rawBytes} bytes; limit is ${String(this.#options.maxPayloadBytes)}`, "$", "notification_too_large");
      const params = requiredRecord(input, "params");
      const typedMethod = method as SupportedAppServerNotification;
      if (typedMethod === "thread/closed" || typedMethod === "turn/started" || typedMethod === "item/started" || typedMethod === "item/agentMessage/delta") return ignored("NON_AUTHORITATIVE_LIFECYCLE");
      if (typedMethod === "thread/started") {
        const thread = requiredRecord(params, "thread");
        const threadId = requiredString(thread, "id", "$.params.thread.");
        const cwd = optionalString(thread, "cwd");
        const cliVersion = optionalString(thread, "cliVersion") ?? this.#options.sourceVersion;
        boundedMap(this.#threads, threadId, { ...(cwd === undefined ? {} : { cwd }), ...(cliVersion === undefined ? {} : { sourceVersion: cliVersion }) }, this.#maxStateEntries);
        const occurredAt = dateFromNumber(thread["createdAt"], "seconds", "$.params.thread.createdAt");
        const modelProvider = optionalString(thread, "modelProvider");
        const ephemeral = optionalBoolean(thread, "ephemeral");
        const payload: CodexAppServerPayload = {
          kind: "app-server-session-started",
          ...(modelProvider === undefined ? {} : { modelProvider }),
          ...(cliVersion === undefined ? {} : { cliVersion }),
          ...(ephemeral === undefined ? {} : { ephemeral }),
          ...(thread["source"] === undefined ? {} : { source: normalizeJson(thread["source"], "$.params.thread.source") }),
        };
        return this.#deduplicate([this.#build({ eventType: "session.started", sessionId: threadId, sourceItemId: threadId, occurredAt, payload, ...this.#metadata(threadId) })]);
      }
      if (typedMethod === "turn/diff/updated") {
        const threadId = requiredString(params, "threadId", "$.params.");
        const turnId = requiredString(params, "turnId", "$.params.");
        if (typeof params["diff"] !== "string") throw new Error("$.params.diff must be a string");
        return this.#deduplicate([this.#build({ eventType: "file.changed", sessionId: threadId, turnId, sourceItemId: `${turnId}:aggregated-diff`, occurredAt: fallbackObservedAt(this.#options), payload: { kind: "app-server-turn-diff", diff: params["diff"] }, ...this.#metadata(threadId) })]);
      }
      if (typedMethod === "item/completed") {
        const threadId = requiredString(params, "threadId", "$.params.");
        const turnId = requiredString(params, "turnId", "$.params.");
        const occurredAt = dateFromNumber(params["completedAtMs"], "milliseconds", "$.params.completedAtMs");
        const event = this.#mapItem(requiredRecord(params, "item"), threadId, turnId, occurredAt);
        return event === undefined ? ignored("NON_MATERIAL_ITEM") : this.#deduplicate([event]);
      }
      const threadId = requiredString(params, "threadId", "$.params.");
      const turn = requiredRecord(params, "turn");
      const turnId = requiredString(turn, "id", "$.params.turn.");
      const status = requiredString(turn, "status", "$.params.turn.");
      if (status !== "completed" && status !== "interrupted" && status !== "failed") throw new Error("$.params.turn.status must be terminal");
      const occurredAt = turn["completedAt"] === null || turn["completedAt"] === undefined ? fallbackObservedAt(this.#options) : dateFromNumber(turn["completedAt"], "seconds", "$.params.turn.completedAt");
      const recovered: EventEnvelope<CodexAppServerPayload>[] = [];
      const items = turn["items"];
      if (!Array.isArray(items)) throw new Error("$.params.turn.items must be an array");
      for (const item of items) {
        if (!isRecord(item)) throw new Error("$.params.turn.items[] must be an object");
        const event = this.#mapItem(item, threadId, turnId, occurredAt);
        if (event !== undefined) recovered.push(event);
      }
      const messageKey = `${threadId}\0${turnId}`;
      const message = this.#messages.get(messageKey)?.text ?? null;
      this.#messages.delete(messageKey);
      const error = turn["error"];
      const durationMs = turn["durationMs"];
      if (durationMs !== undefined && durationMs !== null && (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0)) throw new Error("$.params.turn.durationMs must be a non-negative finite number or null");
      const payload: CodexAppServerPayload = {
        kind: "turn-stopped", stopHookActive: false, lastAssistantMessage: message, status,
        ...(error === undefined || error === null ? {} : { error: normalizeJson(error, "$.params.turn.error") }),
        ...(durationMs === undefined || durationMs === null ? {} : { durationMs }),
      };
      recovered.push(this.#build({ eventType: "turn.stopped", sessionId: threadId, turnId, sourceItemId: turnId, occurredAt, payload, ...this.#metadata(threadId) }));
      return this.#deduplicate(recovered);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const path = /^\$[^ ]*/.exec(message)?.[0] ?? "$";
      if (error instanceof RangeError && message.includes("payload exceeds")) return errorResult("APP_SERVER_NOTIFICATION_TOO_LARGE", message, "$.params", "payload_too_large");
      if (message.includes("date") || message.includes("timestamp")) return errorResult("INVALID_APP_SERVER_TIMESTAMP", message, path, "invalid_timestamp");
      if (message.startsWith("INTERNAL_ENVELOPE_INVALID:")) return errorResult("INTERNAL_ENVELOPE_INVALID", message.slice("INTERNAL_ENVELOPE_INVALID:".length), "$", "schema_validation");
      return errorResult("INVALID_APP_SERVER_NOTIFICATION", message, path, "invalid_field");
    }
  }
}
