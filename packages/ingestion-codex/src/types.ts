import type { EventEnvelope } from "@zhiloop/domain";

export const SUPPORTED_CODEX_HOOK_EVENTS = [
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
  "SessionEnd",
] as const;

export type SupportedCodexHookEvent = (typeof SUPPORTED_CODEX_HOOK_EVENTS)[number];

export const CODEX_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
] as const;

export type CodexPermissionMode = (typeof CODEX_PERMISSION_MODES)[number];

export interface UserPromptPayload {
  readonly kind: "user-prompt";
  readonly prompt: string;
  readonly model?: string;
  readonly permissionMode?: CodexPermissionMode;
}

export interface ToolCompletedPayload {
  readonly kind: "tool-completed";
  readonly toolName: string;
  readonly toolUseId: string;
  readonly toolInput: JsonValue;
  readonly toolResponse: JsonValue;
  readonly model?: string;
  readonly permissionMode?: CodexPermissionMode;
}

export interface TurnStoppedPayload {
  readonly kind: "turn-stopped";
  readonly stopHookActive: boolean;
  readonly lastAssistantMessage: string | null;
  readonly model?: string;
  readonly permissionMode?: CodexPermissionMode;
}

export interface SessionEndedPayload {
  readonly kind: "session-ended";
  readonly reason: "other";
  readonly model?: string;
}

export type CodexHookPayload =
  | UserPromptPayload
  | ToolCompletedPayload
  | TurnStoppedPayload
  | SessionEndedPayload;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface CodexHookIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface CodexHookDiagnostic {
  readonly code:
    | "INVALID_HOOK_INPUT"
    | "UNSUPPORTED_HOOK_EVENT"
    | "HOOK_INPUT_TOO_LARGE"
    | "INVALID_OBSERVED_AT"
    | "INTERNAL_ENVELOPE_INVALID";
  readonly message: string;
  readonly issues: readonly CodexHookIssue[];
}

export type CodexHookAdaptResult =
  | { readonly ok: true; readonly value: EventEnvelope<CodexHookPayload> }
  | { readonly ok: false; readonly error: CodexHookDiagnostic };

export interface CodexHookAdapterOptions {
  readonly observedAt?: string;
  readonly clock?: () => Date;
  readonly maxPayloadBytes?: number;
}
