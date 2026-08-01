import { createHash } from "node:crypto";

import type { EventEnvelope, EventType } from "@zhiloop/domain";
import { parseEventEnvelope } from "@zhiloop/schemas";

import { canonicalStringify, normalizeJson } from "./canonical-json.js";
import {
  CODEX_PERMISSION_MODES,
  SUPPORTED_CODEX_HOOK_EVENTS,
  type CodexHookAdaptResult,
  type CodexHookAdapterOptions,
  type CodexHookDiagnostic,
  type CodexHookPayload,
  type CodexPermissionMode,
  type SupportedCodexHookEvent,
} from "./types.js";

const DEFAULT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const permissionModes = new Set<string>(CODEX_PERMISSION_MODES);
const supportedEvents = new Set<string>(SUPPORTED_CODEX_HOOK_EVENTS);

interface CommonFields {
  readonly eventName: SupportedCodexHookEvent;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly permissionMode?: CodexPermissionMode;
}

interface NormalizedHook {
  readonly common: CommonFields;
  readonly eventType: EventType;
  readonly sourceItemId: string;
  readonly payload: CodexHookPayload;
}

function diagnostic(
  code: CodexHookDiagnostic["code"],
  message: string,
  path = "$",
  issueCode = code.toLowerCase(),
): CodexHookAdaptResult {
  return { ok: false, error: { code, message, issues: [{ path, code: issueCode, message }] } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`$.${key} must be a non-empty string`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`$.${key} must be a non-empty string or null`);
  return value;
}

function optionalPermissionMode(record: Record<string, unknown>): CodexPermissionMode | undefined {
  const value = record["permission_mode"];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !permissionModes.has(value)) {
    throw new Error("$.permission_mode is not a supported Codex permission mode");
  }
  return value as CodexPermissionMode;
}

function optionalMetadata(common: CommonFields): { model?: string; permissionMode?: CodexPermissionMode } {
  return {
    ...(common.model === undefined ? {} : { model: common.model }),
    ...(common.permissionMode === undefined ? {} : { permissionMode: common.permissionMode }),
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value)).digest("hex");
}

function normalizeCommon(input: Record<string, unknown>): CommonFields {
  const eventName = requiredString(input, "hook_event_name");
  if (!supportedEvents.has(eventName)) throw new Error(`$.hook_event_name is unsupported: ${eventName}`);

  const turnId = optionalString(input, "turn_id");
  const cwd = optionalString(input, "cwd");
  const model = optionalString(input, "model");
  const permissionMode = optionalPermissionMode(input);
  return {
    eventName: eventName as SupportedCodexHookEvent,
    sessionId: requiredString(input, "session_id"),
    ...(turnId === undefined ? {} : { turnId }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(model === undefined ? {} : { model }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
  };
}

function normalizeHook(input: Record<string, unknown>, common: CommonFields): NormalizedHook {
  switch (common.eventName) {
    case "UserPromptSubmit": {
      const prompt = requiredString(input, "prompt");
      return {
        common,
        eventType: "user.prompted",
        sourceItemId: common.turnId ?? hash([common.sessionId, prompt]),
        payload: { kind: "user-prompt", prompt, ...optionalMetadata(common) },
      };
    }
    case "PostToolUse": {
      const toolUseId = requiredString(input, "tool_use_id");
      return {
        common,
        eventType: "tool.completed",
        sourceItemId: toolUseId,
        payload: {
          kind: "tool-completed",
          toolName: requiredString(input, "tool_name"),
          toolUseId,
          toolInput: normalizeJson(input["tool_input"], "$.tool_input"),
          toolResponse: normalizeJson(input["tool_response"], "$.tool_response"),
          ...optionalMetadata(common),
        },
      };
    }
    case "Stop": {
      const stopHookActive = input["stop_hook_active"];
      const lastAssistantMessage = input["last_assistant_message"];
      if (typeof stopHookActive !== "boolean") throw new Error("$.stop_hook_active must be a boolean");
      if (lastAssistantMessage !== null && typeof lastAssistantMessage !== "string") {
        throw new Error("$.last_assistant_message must be a string or null");
      }
      return {
        common,
        eventType: "turn.stopped",
        sourceItemId: common.turnId ?? hash([common.sessionId, "Stop"]),
        payload: {
          kind: "turn-stopped",
          stopHookActive,
          lastAssistantMessage,
          ...optionalMetadata(common),
        },
      };
    }
    case "SessionEnd": {
      const reason = requiredString(input, "reason");
      if (reason !== "other") throw new Error("$.reason must be other for the current Codex release");
      return {
        common,
        eventType: "session.ended",
        sourceItemId: hash([common.sessionId, "SessionEnd", reason]),
        payload: { kind: "session-ended", reason, ...(common.model === undefined ? {} : { model: common.model }) },
      };
    }
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function observedAt(options: CodexHookAdapterOptions): string | undefined {
  if (options.observedAt !== undefined) {
    const match = ISO_DATE_TIME.exec(options.observedAt);
    if (match === null || Number.isNaN(Date.parse(options.observedAt))) return undefined;
    const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    const offsetHour = Number(offsetHourText ?? 0);
    const offsetMinute = Number(offsetMinuteText ?? 0);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > daysInMonth ||
      hour > 23 ||
      minute > 59 ||
      second > 59 ||
      offsetHour > 23 ||
      offsetMinute > 59
    ) {
      return undefined;
    }
    return options.observedAt;
  }
  const value = (options.clock ?? (() => new Date()))();
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : undefined;
}

export function adaptCodexHook(input: unknown, options: CodexHookAdapterOptions = {}): CodexHookAdaptResult {
  if (!isRecord(input)) return diagnostic("INVALID_HOOK_INPUT", "hook input must be a JSON object");

  const rawEventName = input["hook_event_name"];
  if (typeof rawEventName === "string" && !supportedEvents.has(rawEventName)) {
    return diagnostic(
      "UNSUPPORTED_HOOK_EVENT",
      `unsupported Codex hook event: ${rawEventName}`,
      "$.hook_event_name",
      "unsupported_hook_event",
    );
  }

  try {
    const normalized = normalizeHook(input, normalizeCommon(input));
    const payloadJson = canonicalStringify(normalized.payload);
    const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
    const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1) {
      return diagnostic("INVALID_HOOK_INPUT", "maxPayloadBytes must be a positive safe integer", "$.options.maxPayloadBytes");
    }
    if (payloadBytes > maxPayloadBytes) {
      return diagnostic(
        "HOOK_INPUT_TOO_LARGE",
        `normalized hook payload is ${payloadBytes} bytes; limit is ${maxPayloadBytes}`,
        "$.payload",
        "payload_too_large",
      );
    }

    const occurredAt = observedAt(options);
    if (occurredAt === undefined) {
      return diagnostic("INVALID_OBSERVED_AT", "observedAt must be an ISO 8601 date-time", "$.options.observedAt");
    }

    const contentHash = createHash("sha256").update(payloadJson).digest("hex");
    const correlationId = hash([normalized.common.sessionId, normalized.common.turnId ?? null]);
    const eventId = hash([
      "codex-hook",
      normalized.common.sessionId,
      normalized.common.turnId ?? null,
      normalized.eventType,
      normalized.sourceItemId,
      contentHash,
    ]);
    const envelope: EventEnvelope<CodexHookPayload> = {
      schemaVersion: 1,
      eventId,
      source: "codex-hook",
      sourceItemId: normalized.sourceItemId,
      eventType: normalized.eventType,
      sessionId: normalized.common.sessionId,
      ...(normalized.common.turnId === undefined ? {} : { turnId: normalized.common.turnId }),
      occurredAt,
      ...(normalized.common.cwd === undefined ? {} : { cwd: normalized.common.cwd }),
      contentHash,
      correlationId,
      payload: deepFreeze(normalized.payload),
    };

    const validated = parseEventEnvelope(envelope);
    if (!validated.ok) {
      return {
        ok: false,
        error: {
          code: "INTERNAL_ENVELOPE_INVALID",
          message: validated.error.message,
          issues: validated.error.issues.map((issue) => ({
            path: issue.instancePath || "$",
            code: issue.keyword,
            message: issue.message,
          })),
        },
      };
    }
    return { ok: true, value: deepFreeze(envelope) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const path = /^\$[^ ]*/.exec(message)?.[0] ?? "$";
    return diagnostic("INVALID_HOOK_INPUT", message, path, "invalid_field");
  }
}
