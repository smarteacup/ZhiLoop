import type { VerificationPolicy } from "@zhiloop/config";
import type { ConfirmationEffect, ConfirmationKind, ConfirmationRequest } from "@zhiloop/domain";

export type InteractionImpact = "LOW" | "MEDIUM" | "HIGH";

export interface InteractionIdentity {
  readonly sessionId: string;
  readonly turnId: string;
  readonly turnOrdinal: number;
}

export interface InteractionTrigger {
  readonly triggerId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly turnOrdinal: number;
  readonly kind: ConfirmationKind;
  readonly impact: InteractionImpact;
  readonly irreversible: boolean;
  readonly subjectIds: readonly string[];
  readonly summary: string;
}

export interface ConfirmationHistoryEntry {
  readonly confirmationId: string;
  readonly triggerId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly turnOrdinal: number;
}

export interface InteractionPolicyInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly turnOrdinal: number;
  readonly now: string;
  readonly triggers: readonly InteractionTrigger[];
  readonly history: readonly ConfirmationHistoryEntry[];
  readonly policy: VerificationPolicy["interaction"];
}

export interface SafeDefaultDecision {
  readonly triggerId: string;
  readonly subjectIds: readonly string[];
  readonly effect: ConfirmationEffect;
  readonly reasonCode: "LOW_IMPACT_UNKNOWN" | "QUESTION_BUDGET_EXHAUSTED" | "LOWER_PRIORITY_DEFERRED" | "TRIGGER_ALREADY_ASKED";
}

export interface InteractionPolicyDecision {
  readonly action: "NONE" | "ASK_USER" | "DEFER";
  readonly request?: ConfirmationRequest;
  readonly defaults: readonly SafeDefaultDecision[];
  readonly deferredTriggerIds: readonly string[];
  readonly reviewTasksCreated: 0;
  readonly reasonCodes: readonly string[];
}
