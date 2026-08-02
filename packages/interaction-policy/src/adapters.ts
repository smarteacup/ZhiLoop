import { createHash } from "node:crypto";

import type { ClosureVerificationResult } from "@zhiloop/domain";
import type { EvidencePolicyDecision } from "@zhiloop/evidence-policy";

import type { InteractionIdentity, InteractionTrigger } from "./types.js";

function triggerId(source: string, kind: InteractionTrigger["kind"], subjectIds: readonly string[]): string {
  const digest = createHash("sha256").update(JSON.stringify([source, kind, [...subjectIds].sort()])).digest("hex").slice(0, 24);
  return `trigger-${digest}`;
}

function trigger(
  identity: InteractionIdentity,
  source: string,
  kind: InteractionTrigger["kind"],
  subjectIds: readonly string[],
  summary: string,
  impact: InteractionTrigger["impact"],
  irreversible: boolean,
): InteractionTrigger {
  return Object.freeze({
    triggerId: triggerId(source, kind, subjectIds), ...identity, kind, impact, irreversible,
    subjectIds: Object.freeze([...subjectIds].sort()), summary,
  });
}

export function evidencePolicyTriggers(
  identity: InteractionIdentity,
  subjectId: string,
  summary: string,
  decision: EvidencePolicyDecision,
): readonly InteractionTrigger[] {
  const reasons = new Set(decision.reasonCodes);
  const result: InteractionTrigger[] = [];
  const conflict = reasons.has("CONFLICTING_USER_DECISIONS")
    || reasons.has("KNOWLEDGE_CONFLICT_REQUIRES_CONFIRMATION")
    || reasons.has("ADOPTION_REQUIRES_CONFIRMATION")
    || reasons.has("INVALID_POLICY_STATUS_TRANSITION");
  if (decision.interaction === "ASK_USER" && conflict) {
    result.push(trigger(identity, "evidence", "KNOWLEDGE_CONFLICT", [subjectId], summary, "HIGH", false));
  }
  if (decision.interaction === "ASK_USER" && reasons.has("GLOBAL_FALLBACK_PROJECT")) {
    result.push(trigger(identity, "evidence", "SCOPE_PROMOTION", [subjectId], summary, "MEDIUM", false));
  }
  if (decision.targetStatus === "PROPOSED" && reasons.has("VERIFICATION_UNKNOWN")) {
    result.push(trigger(identity, "evidence", "LOW_IMPACT_UNKNOWN", [subjectId], summary, "LOW", false));
  }
  return Object.freeze(result);
}

export function closureInteractionTrigger(
  identity: InteractionIdentity,
  summary: string,
  result: ClosureVerificationResult,
): InteractionTrigger | undefined {
  if (result.decision !== "ASK_USER") return undefined;
  return trigger(identity, "closure", "CLOSURE_ASK_USER", [result.verificationId], summary, "MEDIUM", false);
}

export function ruleOverrideTrigger(
  identity: InteractionIdentity,
  ruleId: string,
  summary: string,
  irreversible = true,
): InteractionTrigger {
  return trigger(identity, "rule", "RULE_OVERRIDE", [ruleId], summary, irreversible ? "HIGH" : "MEDIUM", irreversible);
}
