import type { EventEnvelope } from "@zhiloop/domain";

import type { JsonValue } from "./types.js";

export const SUPPORTED_APP_SERVER_NOTIFICATIONS = [
  "thread/started",
  "thread/closed",
  "turn/started",
  "turn/completed",
  "turn/diff/updated",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
] as const;

export type SupportedAppServerNotification = (typeof SUPPORTED_APP_SERVER_NOTIFICATIONS)[number];

export interface AppServerSessionStartedPayload {
  readonly kind: "app-server-session-started";
  readonly modelProvider?: string;
  readonly cliVersion?: string;
  readonly ephemeral?: boolean;
  readonly source?: JsonValue;
}

export interface AppServerUserPromptPayload {
  readonly kind: "user-prompt";
  readonly prompt: string;
  readonly content: JsonValue;
}

export interface AppServerToolCompletedPayload {
  readonly kind: "tool-completed";
  readonly toolName: string;
  readonly toolUseId: string;
  readonly toolInput: JsonValue;
  readonly toolResponse: JsonValue;
}

export interface AppServerFileChangedPayload {
  readonly kind: "app-server-file-changed" | "app-server-turn-diff";
  readonly status?: string;
  readonly changes?: JsonValue;
  readonly diff?: string;
}

export interface AppServerTurnStoppedPayload {
  readonly kind: "turn-stopped";
  readonly stopHookActive: false;
  readonly lastAssistantMessage: string | null;
  readonly status: "completed" | "interrupted" | "failed";
  readonly error?: JsonValue;
  readonly durationMs?: number;
}

export type CodexAppServerPayload =
  | AppServerSessionStartedPayload
  | AppServerUserPromptPayload
  | AppServerToolCompletedPayload
  | AppServerFileChangedPayload
  | AppServerTurnStoppedPayload;

export interface AppServerAdapterOptions {
  readonly observedAt?: string;
  readonly clock?: () => Date;
  readonly sourceVersion?: string;
  readonly maxPayloadBytes?: number;
  readonly maxStateEntries?: number;
}

export interface AppServerIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface AppServerDiagnostic {
  readonly code:
    | "INVALID_APP_SERVER_NOTIFICATION"
    | "UNSUPPORTED_APP_SERVER_NOTIFICATION"
    | "APP_SERVER_NOTIFICATION_TOO_LARGE"
    | "INVALID_APP_SERVER_TIMESTAMP"
    | "INTERNAL_ENVELOPE_INVALID";
  readonly message: string;
  readonly issues: readonly AppServerIssue[];
}

export interface AppServerAdaptBatch {
  readonly events: readonly EventEnvelope<CodexAppServerPayload>[];
  readonly ignored: boolean;
  readonly ignoredReason?: "NON_AUTHORITATIVE_LIFECYCLE" | "NON_MATERIAL_ITEM" | "DUPLICATE_IN_CONNECTION";
}

export type AppServerAdaptResult =
  | { readonly ok: true; readonly value: AppServerAdaptBatch }
  | { readonly ok: false; readonly error: AppServerDiagnostic };
