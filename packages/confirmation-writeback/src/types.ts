import type {
  ConfirmationEffect,
  ConfirmationRequest,
  ConfirmationResolution,
  ConfirmationVersionRelation,
} from "@zhiloop/domain";

export interface ConfirmationTargetSnapshot {
  readonly subjectId: string;
  readonly expectedRevision: string;
}

export interface PendingConfirmation {
  readonly request: ConfirmationRequest;
  readonly targets: readonly ConfirmationTargetSnapshot[];
}

export type ConfirmationClaimResult = "CLAIMED" | "RETRY" | "RESOLVED" | "CONFLICT";

export interface ConfirmationWritebackRepository {
  save(request: ConfirmationRequest, targets: readonly ConfirmationTargetSnapshot[]): "SAVED" | "EXISTING";
  pending(sessionId: string, confirmationId?: string): readonly PendingConfirmation[];
  claim(confirmationId: string, resolutionId: string, responseEventId: string, responseTextHash: string): ConfirmationClaimResult;
  complete(resolution: ConfirmationResolution): "COMPLETED" | "EXISTING";
  resolution(confirmationId: string): ConfirmationResolution | undefined;
}

export interface ConfirmationEffectCommand {
  readonly resolutionId: string;
  readonly confirmationId: string;
  readonly effect: ConfirmationEffect;
  readonly responseKind: "OPTION" | "CORRECTION";
  readonly responseEventId: string;
  readonly responseText: string;
  readonly targets: readonly ConfirmationTargetSnapshot[];
  readonly signal: AbortSignal;
}

export interface ConfirmationEffectPort {
  apply(command: ConfirmationEffectCommand): Promise<{ readonly relations: readonly ConfirmationVersionRelation[] }>;
}

export interface ConfirmationReply {
  readonly sessionId: string;
  readonly turnId: string;
  readonly turnOrdinal: number;
  readonly eventId: string;
  readonly statement: string;
  readonly occurredAt: string;
  readonly confirmationId?: string;
}

export type ConfirmationWritebackStatus =
  | "NO_PENDING"
  | "AMBIGUOUS_PENDING"
  | "NO_EXPLICIT_CHOICE"
  | "AMBIGUOUS_CHOICE"
  | "RESOLVED"
  | "ALREADY_RESOLVED"
  | "CONFLICT"
  | "RETRYABLE"
  | "INVALID_INPUT";

export interface ConfirmationWritebackResult {
  readonly status: ConfirmationWritebackStatus;
  readonly confirmationId?: string;
  readonly resolution?: ConfirmationResolution;
  readonly diagnostic?: string;
}

export interface ConfirmationWritebackOptions {
  readonly effectDeadlineMs: number;
}
