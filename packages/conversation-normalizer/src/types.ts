import type { NormalizedSession } from "@zhiloop/domain";

export interface ConversationNormalizationOptions {
  readonly asOf: string;
  readonly inactivityTimeoutMs?: number;
  readonly closeFromNextSession?: boolean;
}

export interface ConversationNormalizationDiagnostic {
  readonly code:
    | "DUPLICATE_SEQUENCE"
    | "EVENT_AFTER_SESSION_END"
    | "MULTIPLE_SESSION_END";
  readonly sessionId: string;
  readonly eventId: string;
  readonly sourceOrder: number;
}

export interface ConversationNormalizationResult {
  readonly sessions: readonly NormalizedSession[];
  readonly diagnostics: readonly ConversationNormalizationDiagnostic[];
}
