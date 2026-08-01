import type { KnowledgeStatus } from "./knowledge.js";

const ALLOWED_TRANSITIONS = Object.freeze({
  PROPOSED: Object.freeze(["ACCEPTED", "IMPLEMENTED", "REJECTED", "SUPERSEDED"] as const),
  ACCEPTED: Object.freeze(["IMPLEMENTED", "REJECTED", "SUPERSEDED"] as const),
  IMPLEMENTED: Object.freeze(["VERIFIED", "STALE", "SUPERSEDED"] as const),
  VERIFIED: Object.freeze(["STALE", "SUPERSEDED"] as const),
  REJECTED: Object.freeze([] as const),
  STALE: Object.freeze(["VERIFIED", "SUPERSEDED"] as const),
  SUPERSEDED: Object.freeze([] as const),
}) satisfies Readonly<Record<KnowledgeStatus, readonly KnowledgeStatus[]>>;

export type StatusTransitionResult =
  | {
      readonly ok: true;
      readonly from: KnowledgeStatus;
      readonly to: KnowledgeStatus;
      readonly changed: boolean;
    }
  | {
      readonly ok: false;
      readonly from: KnowledgeStatus;
      readonly to: KnowledgeStatus;
      readonly code: "INVALID_STATUS_TRANSITION";
    };

export function getAllowedStatusTransitions(status: KnowledgeStatus): readonly KnowledgeStatus[] {
  return ALLOWED_TRANSITIONS[status];
}

export function transitionKnowledgeStatus(
  from: KnowledgeStatus,
  to: KnowledgeStatus,
): StatusTransitionResult {
  if (from === to) return { ok: true, from, to, changed: false };
  const allowed: readonly KnowledgeStatus[] = ALLOWED_TRANSITIONS[from];
  if (allowed.includes(to)) return { ok: true, from, to, changed: true };
  return { ok: false, from, to, code: "INVALID_STATUS_TRANSITION" };
}
