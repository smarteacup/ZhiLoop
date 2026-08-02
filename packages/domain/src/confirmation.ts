export const CONFIRMATION_KINDS = [
  "KNOWLEDGE_CONFLICT",
  "SCOPE_PROMOTION",
  "RULE_OVERRIDE",
  "CLOSURE_ASK_USER",
  "LOW_IMPACT_UNKNOWN",
] as const;

export type ConfirmationKind = (typeof CONFIRMATION_KINDS)[number];

export const CONFIRMATION_EFFECTS = [
  "KEEP_PROPOSED",
  "KEEP_CURRENT",
  "ACCEPT_CANDIDATE",
  "KEEP_PROJECT",
  "PROMOTE_GLOBAL",
  "KEEP_RULE",
  "APPLY_OVERRIDE",
  "STOP_WITHOUT_EXPANSION",
  "CONTINUE_ORIGINAL_SCOPE",
] as const;

export type ConfirmationEffect = (typeof CONFIRMATION_EFFECTS)[number];

export const SAFE_CONFIRMATION_EFFECT_BY_KIND = Object.freeze({
  KNOWLEDGE_CONFLICT: "KEEP_PROPOSED",
  SCOPE_PROMOTION: "KEEP_PROJECT",
  RULE_OVERRIDE: "KEEP_RULE",
  CLOSURE_ASK_USER: "STOP_WITHOUT_EXPANSION",
} as const satisfies Readonly<Record<Exclude<ConfirmationKind, "LOW_IMPACT_UNKNOWN">, ConfirmationEffect>>);

export const CONFIRMATION_EFFECTS_BY_KIND = Object.freeze({
  KNOWLEDGE_CONFLICT: Object.freeze(["KEEP_PROPOSED", "ACCEPT_CANDIDATE"]),
  SCOPE_PROMOTION: Object.freeze(["KEEP_PROJECT", "PROMOTE_GLOBAL"]),
  RULE_OVERRIDE: Object.freeze(["KEEP_RULE", "APPLY_OVERRIDE"]),
  CLOSURE_ASK_USER: Object.freeze(["STOP_WITHOUT_EXPANSION", "CONTINUE_ORIGINAL_SCOPE"]),
} as const satisfies Readonly<Record<Exclude<ConfirmationKind, "LOW_IMPACT_UNKNOWN">, readonly ConfirmationEffect[]>>);

export interface ConfirmationOption {
  readonly optionId: string;
  readonly label: string;
  readonly effect: ConfirmationEffect;
}

export interface ConfirmationRequest {
  readonly schemaVersion: 1;
  readonly confirmationId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly turnOrdinal: number;
  readonly triggerId: string;
  readonly kind: Exclude<ConfirmationKind, "LOW_IMPACT_UNKNOWN">;
  readonly subjectIds: readonly string[];
  readonly question: string;
  readonly options: readonly ConfirmationOption[];
  readonly safeDefaultOptionId: string;
  readonly createdAt: string;
}
