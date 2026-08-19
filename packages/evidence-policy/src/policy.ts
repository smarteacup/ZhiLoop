import type { AssertionKind, KnowledgeScope, KnowledgeStatus } from "@zhiloop/domain";
import {
  ASSERTION_KINDS,
  KNOWLEDGE_STATUSES,
  evaluateGlobalPromotion,
  getAllowedStatusTransitions,
  transitionKnowledgeStatus,
  locatorHasAuthoritativeRevision,
  validateKnowledgeLocator,
} from "@zhiloop/domain";

import type { EvidencePolicyDecision, EvidencePolicyInput } from "./types.js";

const STATUS_RANK: Readonly<Partial<Record<KnowledgeStatus, number>>> = {
  PROPOSED: 0,
  ACCEPTED: 1,
  IMPLEMENTED: 2,
  VERIFIED: 3,
};
const PUBLISHABLE = new Set<KnowledgeStatus>(["ACCEPTED", "IMPLEMENTED", "VERIFIED"]);
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,99}$/;
const EVIDENCE_TYPE_BY_ASSERTION: Partial<Record<AssertionKind, string>> = {
  USER_ACCEPTED: "USER_STATEMENT",
  USER_REJECTED: "USER_STATEMENT",
  SYMBOL_EXISTS: "CODE_SYMBOL",
  CALL_PATH_EXISTS: "CODE_RELATION",
  IMPACT_CONTAINS: "CODE_IMPACT",
  FILE_CONTAINS: "FILE_CONTENT",
  DEPENDENCY_PRESENT: "DEPENDENCY",
  CONFIG_EQUALS: "CONFIGURATION",
  COMMAND_SUCCEEDED: "COMMAND_RESULT",
  TEST_PASSED: "TEST_RESULT",
  CROSS_PROJECT_VERIFIED: "CROSS_PROJECT",
};

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function decision(
  input: EvidencePolicyInput,
  values: Omit<EvidencePolicyDecision, "currentStatus">,
): EvidencePolicyDecision {
  return freeze({ currentStatus: input.currentStatus, ...values });
}

function invalidInput(input: EvidencePolicyInput): EvidencePolicyDecision {
  return decision(input, {
    action: "KEEP",
    interaction: "NONE",
    targetStatus: input.currentStatus,
    transitionPath: [],
    effectiveScope: input.projectScope,
    shouldPublish: false,
    evidenceIds: [],
    reasonCodes: ["INVALID_EVIDENCE_POLICY_INPUT", "SAFE_PROJECT_FALLBACK"],
  });
}

function validateInput(input: EvidencePolicyInput): boolean {
  if (!KNOWLEDGE_STATUSES.includes(input.currentStatus) || input.candidate.status !== "PROPOSED") return false;
  if (input.projectScope.level !== "PROJECT" || input.projectScope.projectId.trim().length === 0) return false;
  if (input.candidate.scopeHint.projectId !== undefined
    && input.candidate.scopeHint.projectId !== input.projectScope.projectId) return false;
  if (input.candidate.schemaVersion === 2 && (
    input.candidate.locator.projectId !== input.projectScope.projectId
    || !validateKnowledgeLocator(input.candidate.locator).valid
  )) return false;
  if (input.verificationPolicy.globalPromotion.minVerifiedProjects < 2
    || input.verificationPolicy.globalPromotion.minVerifiedProjects > 20) return false;
  const implementationRule = input.verificationPolicy.autoPublish.IMPLEMENTATION;
  const experienceRule = input.verificationPolicy.autoPublish.EXPERIENCE;
  if (implementationRule.maxStatus !== "IMPLEMENTED" || implementationRule.requiredAssertions.length === 0
    || !implementationRule.requiredAssertions.includes("SYMBOL_EXISTS")
    || experienceRule.maxStatus !== "VERIFIED" || experienceRule.requiredAssertions.length === 0
    || !experienceRule.requiredAssertions.includes("TEST_PASSED")
    || ![...implementationRule.requiredAssertions, ...experienceRule.requiredAssertions]
      .every((kind) => ASSERTION_KINDS.includes(kind))
    || input.verificationPolicy.interaction.maxQuestionsPerTurn !== 1
    || input.verificationPolicy.interaction.questionWindowTurns !== 20
    || input.verificationPolicy.interaction.defaultScope !== "PROJECT"
    || input.verificationPolicy.interaction.unansweredBehavior !== "SAFE_DEFAULT"
    || input.verificationPolicy.interaction.createReviewTasks !== false) return false;
  if ("projectId" in input.resolvedScope && input.resolvedScope.projectId !== undefined
    && input.resolvedScope.projectId !== input.projectScope.projectId) return false;
  const assertions = new Map(input.candidate.assertions.map((assertion) => [assertion.assertionId, assertion]));
  if (assertions.size !== input.candidate.assertions.length
    || input.candidate.assertions.some((assertion) => assertion.candidateId !== input.candidate.candidateId)) return false;
  const seenResults = new Set<string>();
  for (const result of input.verificationResults) {
    const assertion = assertions.get(result.assertionId);
    if (assertion === undefined || assertion.kind !== result.assertionKind || seenResults.has(result.assertionId)) return false;
    seenResults.add(result.assertionId);
    if (!(["SUPPORTED", "REFUTED", "UNKNOWN", "ERROR"] as const).includes(result.status)) return false;
    if (result.reasonCodes.length === 0 || !result.reasonCodes.every((reason) => REASON_CODE.test(reason))) return false;
    if (result.status === "ERROR" && result.evidence !== undefined) return false;
    if (result.status === "SUPPORTED" && result.evidence?.verdict !== "SUPPORTS") return false;
    if (result.status === "REFUTED" && result.evidence?.verdict !== "CONTRADICTS") return false;
    if (result.status === "UNKNOWN" && result.evidence !== undefined && result.evidence.verdict !== "INCONCLUSIVE") return false;
    if (result.evidence !== undefined && (
      result.evidence.assertionId !== assertion.assertionId
      || result.evidence.type !== EVIDENCE_TYPE_BY_ASSERTION[assertion.kind]
      || result.evidence.projectId !== input.projectScope.projectId
      || result.evidence.correlationId !== input.candidate.correlationId
      || result.evidence.evidenceId.trim().length === 0 || result.evidence.evidenceId.length > 500
      || result.evidence.sourceRef.trim().length === 0 || result.evidence.sourceRef.length > 1_000
      || !Number.isFinite(Date.parse(result.evidence.observedAt))
    )) return false;
  }
  return (input.conflictIds ?? []).every((id) => id.trim().length > 0 && id.length <= 500 && !/[\0\r\n]/.test(id))
    && (input.contentRevisionRequested === undefined || typeof input.contentRevisionRequested === "boolean")
    && input.projectSpecificSignals.every((signal) => REASON_CODE.test(signal))
    && (input.verifiedProjects ?? []).every((item) =>
      item.subjectKey === input.candidate.subjectKey
      && [item.projectId, item.evidenceId, item.sourceRef].every((value) =>
        value.trim().length > 0 && value.length <= 1_000 && !/[\0\r\n]/.test(value))
      && Number.isFinite(Date.parse(item.observedAt)));
}

function transitionPath(from: KnowledgeStatus, to: KnowledgeStatus): readonly KnowledgeStatus[] | undefined {
  if (from === to) return [];
  const queue: Array<{ status: KnowledgeStatus; path: KnowledgeStatus[] }> = [{ status: from, path: [] }];
  const visited = new Set<KnowledgeStatus>([from]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const next of getAllowedStatusTransitions(current.status)) {
      if (visited.has(next)) continue;
      const path = [...current.path, next];
      if (next === to) return path;
      visited.add(next);
      queue.push({ status: next, path });
    }
  }
  return undefined;
}

function supported(input: EvidencePolicyInput, kind: AssertionKind): boolean {
  const relevant = input.candidate.assertions.filter((assertion) => assertion.kind === kind);
  return relevant.length > 0 && relevant.every((assertion) =>
    input.verificationResults.find((result) => result.assertionId === assertion.assertionId)?.status === "SUPPORTED");
}

function requiredKinds(input: EvidencePolicyInput): readonly AssertionKind[] {
  if (input.candidate.claimMode !== undefined && input.candidate.claimMode !== "CURRENT_STATE") return [];
  if (input.candidate.kind === "IMPLEMENTATION") return input.verificationPolicy.autoPublish.IMPLEMENTATION.requiredAssertions;
  if (input.candidate.kind === "EXPERIENCE") return input.verificationPolicy.autoPublish.EXPERIENCE.requiredAssertions;
  return [];
}

function evidenceIds(input: EvidencePolicyInput): readonly string[] {
  return [...new Set([
    ...input.verificationResults.flatMap((result) =>
      result.evidence === undefined ? [] : [result.evidence.evidenceId]),
    ...(input.verifiedProjects ?? []).map((item) => item.evidenceId),
  ])].sort();
}

function effectiveGlobalScope(
  input: EvidencePolicyInput,
  reasons: Set<string>,
  requestConfirmation: boolean,
): { scope: KnowledgeScope; interaction: "NONE" | "ASK_USER" } {
  if (input.resolvedScope.level !== "GLOBAL") return { scope: input.resolvedScope, interaction: "NONE" };
  const verifiedProjects = [...new Set((input.verifiedProjects ?? []).map((item) => item.projectId.trim()))];
  if (input.userExplicitlyApprovedGlobal !== true
    && verifiedProjects.length < input.verificationPolicy.globalPromotion.minVerifiedProjects) {
    reasons.add("GLOBAL_INSUFFICIENT_VERIFIED_PROJECTS");
    reasons.add("GLOBAL_FALLBACK_PROJECT");
    return { scope: input.projectScope, interaction: requestConfirmation ? "ASK_USER" : "NONE" };
  }
  const promotion = evaluateGlobalPromotion({
    kind: input.candidate.kind,
    verifiedProjectIds: verifiedProjects,
    hasProjectSpecificMarkers: input.projectSpecificSignals.length > 0,
    userExplicitlyApprovedGlobal: input.userExplicitlyApprovedGlobal === true,
  });
  if (promotion.allowed) {
    reasons.add(`GLOBAL_${promotion.reason}`);
    return { scope: input.resolvedScope, interaction: "NONE" };
  }
  reasons.add(`GLOBAL_${promotion.reason}`);
  reasons.add("GLOBAL_FALLBACK_PROJECT");
  return { scope: input.projectScope, interaction: requestConfirmation ? "ASK_USER" : "NONE" };
}

function applyTarget(
  input: EvidencePolicyInput,
  targetStatus: KnowledgeStatus,
  reasons: Set<string>,
  scope: KnowledgeScope,
  interaction: "NONE" | "ASK_USER",
  contentRevisionAllowed = false,
): EvidencePolicyDecision {
  const path = transitionPath(input.currentStatus, targetStatus);
  if (path === undefined) {
    reasons.add("INVALID_POLICY_STATUS_TRANSITION");
    return decision(input, {
      action: "KEEP",
      interaction: "ASK_USER",
      targetStatus: input.currentStatus,
      transitionPath: [],
      effectiveScope: scope,
      shouldPublish: false,
      evidenceIds: evidenceIds(input),
      reasonCodes: [...reasons],
    });
  }
  for (let index = 0, from = input.currentStatus; index < path.length; index += 1) {
    const to = path[index];
    if (to === undefined || !transitionKnowledgeStatus(from, to).ok) return invalidInput(input);
    from = to;
  }
  return decision(input, {
    action: path.length === 0 && !contentRevisionAllowed ? "KEEP" : "APPLY",
    interaction,
    targetStatus,
    transitionPath: path,
    effectiveScope: scope,
    shouldPublish: PUBLISHABLE.has(targetStatus) && (path.length > 0 || contentRevisionAllowed),
    evidenceIds: evidenceIds(input),
    reasonCodes: [...reasons],
  });
}

export function evaluateEvidencePolicy(input: EvidencePolicyInput): EvidencePolicyDecision {
  try {
    if (!validateInput(input)) return invalidInput(input);
  } catch {
    return invalidInput(input);
  }
  const reasons = new Set<string>();
  const accepted = supported(input, "USER_ACCEPTED");
  const rejected = supported(input, "USER_REJECTED");

  if (input.candidate.schemaVersion === 2 && input.candidate.claimMode === "CURRENT_STATE"
    && !locatorHasAuthoritativeRevision(input.candidate.locator)) {
    reasons.add("LOCATOR_REVISION_UNRESOLVED");
    reasons.add("CURRENT_STATE_PUBLICATION_BLOCKED");
    return decision(input, {
      action: "KEEP",
      interaction: "NONE",
      targetStatus: input.currentStatus,
      transitionPath: [],
      effectiveScope: input.resolvedScope,
      shouldPublish: false,
      evidenceIds: evidenceIds(input),
      reasonCodes: [...reasons],
    });
  }

  if (input.currentStatus === "REJECTED" || input.currentStatus === "SUPERSEDED") {
    reasons.add("TERMINAL_STATUS_RETAINED");
    return decision(input, {
      action: "KEEP",
      interaction: "NONE",
      targetStatus: input.currentStatus,
      transitionPath: [],
      effectiveScope: input.resolvedScope,
      shouldPublish: false,
      evidenceIds: evidenceIds(input),
      reasonCodes: [...reasons],
    });
  }

  if ((input.conflictIds?.length ?? 0) > 0 || (accepted && rejected)) {
    const global = effectiveGlobalScope(input, reasons, false);
    reasons.add(accepted && rejected ? "CONFLICTING_USER_DECISIONS" : "KNOWLEDGE_CONFLICT_REQUIRES_CONFIRMATION");
    return decision(input, {
      action: "ASK_USER",
      interaction: "ASK_USER",
      targetStatus: input.currentStatus,
      transitionPath: [],
      effectiveScope: global.scope,
      shouldPublish: false,
      evidenceIds: evidenceIds(input),
      reasonCodes: [...reasons],
    });
  }

  if (rejected) {
    const global = effectiveGlobalScope(input, reasons, false);
    reasons.add("USER_REJECTION_SUPPORTED");
    return applyTarget(input, "REJECTED", reasons, global.scope, global.interaction);
  }

  const futureMode = input.candidate.claimMode === "USER_DECISION" || input.candidate.claimMode === "FUTURE_REQUIREMENT";
  const codeAssertionKinds = new Set<AssertionKind>([
    "SYMBOL_EXISTS", "CALL_PATH_EXISTS", "IMPACT_CONTAINS", "FILE_CONTAINS", "DEPENDENCY_PRESENT", "CONFIG_EQUALS",
  ]);
  const assertionById = new Map(input.candidate.assertions.map((assertion) => [assertion.assertionId, assertion]));
  const pendingImplementation = futureMode && input.verificationResults.some((result) =>
    result.status === "REFUTED" && codeAssertionKinds.has(assertionById.get(result.assertionId)?.kind as AssertionKind));
  if (pendingImplementation) reasons.add("PENDING_IMPLEMENTATION");
  const refuted = input.verificationResults.some((result) => {
    if (result.status !== "REFUTED") return false;
    const kind = assertionById.get(result.assertionId)?.kind;
    return !futureMode || kind === "USER_ACCEPTED" || kind === "USER_REJECTED";
  });
  if (refuted) {
    const global = effectiveGlobalScope(input, reasons, false);
    reasons.add("ASSERTION_REFUTED");
    return decision(input, {
      action: input.currentStatus === "PROPOSED" ? "KEEP" : "ASK_USER",
      interaction: input.currentStatus === "PROPOSED" ? global.interaction : "ASK_USER",
      targetStatus: input.currentStatus,
      transitionPath: [],
      effectiveScope: global.scope,
      shouldPublish: false,
      evidenceIds: evidenceIds(input),
      reasonCodes: [...reasons],
    });
  }

  let targetStatus: KnowledgeStatus = accepted ? "ACCEPTED" : "PROPOSED";
  if (accepted) reasons.add("USER_ACCEPTANCE_SUPPORTED");
  const required = requiredKinds(input);
  if (required.length > 0 && required.every((kind) => supported(input, kind))) {
    if (input.candidate.kind === "IMPLEMENTATION") {
      targetStatus = "IMPLEMENTED";
      reasons.add("IMPLEMENTATION_ASSERTIONS_SUPPORTED");
      reasons.add("CODE_EVIDENCE_CAPPED_IMPLEMENTED");
    } else if (input.candidate.kind === "EXPERIENCE") {
      targetStatus = "VERIFIED";
      reasons.add("EXPERIENCE_TEST_ASSERTIONS_SUPPORTED");
    }
  } else if (required.length > 0) {
    reasons.add("AUTO_PUBLISH_ASSERTIONS_INCOMPLETE");
    if (input.verificationResults.some((result) => result.status === "ERROR")) reasons.add("VERIFIER_ERROR_NOT_EVIDENCE");
    if (input.verificationResults.some((result) => result.status === "UNKNOWN")) reasons.add("VERIFICATION_UNKNOWN");
  }
  if (input.verificationResults.some((result) => result.status === "ERROR")) reasons.add("VERIFIER_ERROR_NOT_EVIDENCE");
  if (input.verificationResults.some((result) => result.reasonCodes.includes("INVALID_ASSERTION"))) {
    reasons.add("INVALID_ASSERTION");
  }
  if (input.verificationResults.some((result) => result.status === "UNKNOWN")) reasons.add("VERIFICATION_UNKNOWN");

  const currentRank = STATUS_RANK[input.currentStatus];
  const targetRank = STATUS_RANK[targetStatus];
  if (currentRank !== undefined && targetRank !== undefined && currentRank > targetRank) {
    targetStatus = input.currentStatus;
    reasons.add("STATUS_ALREADY_EXCEEDS_POLICY_TARGET");
  }
  if (targetStatus === "PROPOSED") reasons.add("MODEL_ONLY_REMAINS_PROPOSED");
  if (input.currentStatus === "STALE" && targetStatus !== "VERIFIED") {
    reasons.add("STALE_REQUIRES_REVERIFICATION");
    const global = effectiveGlobalScope(input, reasons, false);
    return decision(input, {
      action: "KEEP",
      interaction: "NONE",
      targetStatus: "STALE",
      transitionPath: [],
      effectiveScope: global.scope,
      shouldPublish: false,
      evidenceIds: evidenceIds(input),
      reasonCodes: [...reasons],
    });
  }
  const contentRevisionAllowed = input.contentRevisionRequested === true
    && (accepted || (required.length > 0 && required.every((kind) => supported(input, kind))));
  if (input.contentRevisionRequested === true) {
    reasons.add(contentRevisionAllowed ? "CONTENT_REVISION_EVIDENCE_SUPPORTED" : "CONTENT_REVISION_EVIDENCE_INCOMPLETE");
  }
  if (input.adoptionAmbiguous === true && targetStatus === "PROPOSED") {
    const global = effectiveGlobalScope(input, reasons, false);
    reasons.add("ADOPTION_REQUIRES_CONFIRMATION");
    return decision(input, {
      action: "ASK_USER",
      interaction: "ASK_USER",
      targetStatus,
      transitionPath: [],
      effectiveScope: global.scope,
      shouldPublish: false,
      evidenceIds: evidenceIds(input),
      reasonCodes: [...reasons],
    });
  }
  const global = effectiveGlobalScope(input, reasons, PUBLISHABLE.has(targetStatus));
  return applyTarget(input, targetStatus, reasons, global.scope, global.interaction, contentRevisionAllowed);
}
