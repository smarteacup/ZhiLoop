import type { KnowledgeAsset, KnowledgeCandidate, KnowledgeScope } from "@zhiloop/domain";

import {
  EVOLUTION_ACTIONS,
  type DecidedEvolutionDecision,
  type EvolutionAction,
  type EvolutionDecision,
  type EvolutionMatchInput,
  type EvolutionSemanticJudgment,
  type EvolutionTargetVersion,
  type KnowledgeEvolutionSemanticPort,
  type PendingEvolutionDecision,
} from "./types.js";

const MAX_TARGETS = 5;
const AUTHORITATIVE_STATUSES = new Set(["IMPLEMENTED", "VERIFIED"]);

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)])) as T;
  }
  return value;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function scopeIdentity(scope: KnowledgeScope): string {
  return canonical(scope);
}

function scopeCanSplit(proposed: KnowledgeScope, existing: KnowledgeScope): boolean {
  if (proposed.level === existing.level) return true;
  if (existing.level === "GLOBAL") return proposed.level !== "GLOBAL";
  if (proposed.level === "GLOBAL") return false;
  const projectRank: Partial<Record<KnowledgeScope["level"], number>> = {
    TASK: 0,
    SYMBOL: 1,
    MODULE: 2,
    PROJECT: 3,
  };
  const organizationRank: Partial<Record<KnowledgeScope["level"], number>> = {
    USER: 0,
    TEAM: 1,
  };
  const proposedProject = projectRank[proposed.level];
  const existingProject = projectRank[existing.level];
  if (proposedProject !== undefined && existingProject !== undefined) return proposedProject < existingProject;
  const proposedOrganization = organizationRank[proposed.level];
  const existingOrganization = organizationRank[existing.level];
  return proposedOrganization !== undefined
    && existingOrganization !== undefined
    && proposedOrganization < existingOrganization;
}

function targetVersion(asset: KnowledgeAsset): EvolutionTargetVersion {
  return { id: asset.id, version: asset.version };
}

function stableTargets(targets: readonly KnowledgeAsset[]): readonly KnowledgeAsset[] {
  const unique = new Map<string, KnowledgeAsset>();
  for (const target of targets) {
    if (target.id.trim().length === 0 || !Number.isSafeInteger(target.version) || target.version < 1) {
      throw new Error("EVOLUTION_TARGET_INVALID");
    }
    const existing = unique.get(target.id);
    if (existing !== undefined && canonical(existing) !== canonical(target)) {
      throw new Error("EVOLUTION_TARGET_COLLISION");
    }
    unique.set(target.id, target);
  }
  return [...unique.values()].sort((left, right) =>
    left.id.localeCompare(right.id) || left.version - right.version);
}

function decision(
  input: EvolutionMatchInput,
  action: EvolutionAction,
  targets: readonly KnowledgeAsset[],
  reasons: readonly string[],
  confidence: number,
  requiresConfirmation: boolean,
  semanticReason?: string,
): DecidedEvolutionDecision {
  return deepFreeze({
    schemaVersion: 1,
    status: "DECIDED",
    candidateId: input.candidate.candidateId,
    action,
    targetKnowledgeVersions: targets.map(targetVersion),
    proposedScope: clone(input.proposedScope),
    deterministicReasons: [...new Set(reasons)].sort(),
    confidence,
    requiresConfirmation,
    ...(semanticReason === undefined ? {} : { semanticReason }),
  });
}

function pending(
  input: EvolutionMatchInput,
  targets: readonly KnowledgeAsset[],
  reasons: readonly string[],
  semanticReason?: string,
): PendingEvolutionDecision {
  return deepFreeze({
    schemaVersion: 1,
    status: "PENDING",
    candidateId: input.candidate.candidateId,
    targetKnowledgeVersions: targets.map(targetVersion),
    proposedScope: clone(input.proposedScope),
    deterministicReasons: [...new Set(reasons)].sort(),
    confidence: 0,
    requiresConfirmation: true,
    ...(semanticReason === undefined ? {} : { semanticReason }),
  });
}

function candidateSymbols(candidate: KnowledgeCandidate): ReadonlySet<string> {
  return new Set(candidate.assertions.flatMap((assertion) => {
    if (assertion.kind === "SYMBOL_EXISTS") return [normalized(assertion.parameters.symbol)];
    if (assertion.kind === "CALL_PATH_EXISTS") return [normalized(assertion.parameters.from), normalized(assertion.parameters.to)];
    if (assertion.kind === "IMPACT_CONTAINS") {
      return [normalized(assertion.parameters.symbol), normalized(assertion.parameters.impactedSymbol)];
    }
    return [];
  }));
}

function sameContent(candidate: KnowledgeCandidate, target: KnowledgeAsset): boolean {
  return normalized(candidate.title) === normalized(target.title)
    && normalized(candidate.summary) === normalized(target.summary)
    && normalized(candidate.body) === normalized(target.body);
}

function supplement(candidate: KnowledgeCandidate, target: KnowledgeAsset): boolean {
  const candidateBody = normalized(candidate.body);
  const targetBody = normalized(target.body);
  const candidateSummary = normalized(candidate.summary);
  const targetSummary = normalized(target.summary);
  return (candidateBody.length > targetBody.length && candidateBody.includes(targetBody))
    || (candidateSummary.length > targetSummary.length && candidateSummary.includes(targetSummary));
}

function accepted(candidate: KnowledgeCandidate): boolean {
  return candidate.assertions.some((assertion) => assertion.kind === "USER_ACCEPTED");
}

function rejected(candidate: KnowledgeCandidate): boolean {
  return candidate.assertions.some((assertion) => assertion.kind === "USER_REJECTED");
}

function related(candidate: KnowledgeCandidate, target: KnowledgeAsset): boolean {
  if (candidate.kind !== target.kind) return false;
  if (candidate.subjectKey === target.subjectKey) return true;
  const candidateKeys = new Set([normalized(candidate.subjectKey), normalized(candidate.title)]);
  if ([target.subjectKey, target.title, ...target.aliases].some((value) => candidateKeys.has(normalized(value)))) return true;
  const symbols = candidateSymbols(candidate);
  return target.symbols.some((symbol) => symbols.has(normalized(symbol)));
}

function validateInput(input: EvolutionMatchInput): readonly KnowledgeAsset[] {
  if (input.candidate.candidateId.trim().length === 0) throw new Error("EVOLUTION_CANDIDATE_INVALID");
  if (input.retrievedTargets.length > MAX_TARGETS) throw new Error("EVOLUTION_TARGET_LIMIT_EXCEEDED");
  if ((input.correctionRefs ?? []).some((item) =>
    item.candidateId !== input.candidate.candidateId
    || item.relationHint !== "CONTRADICTS"
    || item.originalRef.trim().length === 0
    || item.correctedRef.trim().length === 0)) {
    throw new Error("EVOLUTION_CORRECTION_INVALID");
  }
  const targets = stableTargets([
    ...(input.exactTarget === undefined ? [] : [input.exactTarget]),
    ...input.retrievedTargets,
  ]);
  if (input.exactTarget !== undefined && (
    input.exactTarget.subjectKey !== input.candidate.subjectKey
    || input.exactTarget.kind !== input.candidate.kind
    || scopeIdentity(input.exactTarget.scope) !== scopeIdentity(input.proposedScope)
  )) throw new Error("EVOLUTION_EXACT_TARGET_MISMATCH");
  return targets;
}

function deterministic(input: EvolutionMatchInput): EvolutionDecision {
  const targets = validateInput(input);
  const exact = input.exactTarget;
  const hasCorrection = (input.correctionRefs?.length ?? 0) > 0;
  if (exact !== undefined) {
    if (sameContent(input.candidate, exact)) {
      return decision(input, "SKIP", [exact], ["EXACT_IDENTITY", "NORMALIZED_CONTENT_EQUAL"], 1, false);
    }
    if (hasCorrection || rejected(input.candidate)) {
      return decision(
        input,
        "CONTRADICT",
        [exact],
        ["EXACT_IDENTITY", hasCorrection ? "TRUSTED_CORRECTION" : "USER_REJECTED_TARGET"],
        1,
        true,
      );
    }
    if (supplement(input.candidate, exact)) {
      const authoritative = exact.status === "VERIFIED";
      return decision(
        input,
        "SUPPLEMENT",
        [exact],
        ["EXACT_IDENTITY", "CONTENT_STRICTLY_EXTENDS", ...(authoritative ? ["AUTHORITATIVE_TARGET"] : [])],
        0.99,
        authoritative,
      );
    }
    if (accepted(input.candidate)) {
      const authoritative = AUTHORITATIVE_STATUSES.has(exact.status);
      return decision(
        input,
        "SUPERSEDE",
        [exact],
        ["EXACT_IDENTITY", "USER_ACCEPTED_REPLACEMENT", ...(authoritative ? ["AUTHORITATIVE_TARGET"] : [])],
        0.98,
        authoritative,
      );
    }
    return pending(input, [exact], ["EXACT_IDENTITY", "CONTENT_RELATION_UNRESOLVED"]);
  }

  const relatedTargets = targets.filter((target) => related(input.candidate, target));
  if (relatedTargets.length === 0) {
    return decision(input, "STORE", [], ["NO_DETERMINISTIC_TARGET"], 1, false);
  }
  const sameScope = relatedTargets.filter((target) => scopeIdentity(target.scope) === scopeIdentity(input.proposedScope));
  const duplicates = sameScope.filter((target) => sameContent(input.candidate, target));
  if (duplicates.length > 0) {
    return decision(input, "SKIP", duplicates, ["DETERMINISTIC_RELATED_TARGET", "NORMALIZED_CONTENT_EQUAL"], 0.99, false);
  }
  const otherScopes = relatedTargets.filter((target) => scopeIdentity(target.scope) !== scopeIdentity(input.proposedScope));
  if (sameScope.length === 0 && otherScopes.length > 0) {
    const allowed = otherScopes.every((target) => scopeCanSplit(input.proposedScope, target.scope));
    return allowed
      ? decision(input, "SCOPE_SPLIT", otherScopes, ["RELATED_CONTENT_DIFFERENT_SCOPE"], 0.97, false)
      : pending(input, otherScopes, ["SCOPE_WIDENING_REQUIRES_CONFIRMATION"]);
  }
  if (hasCorrection || rejected(input.candidate)) {
    return decision(
      input,
      "CONTRADICT",
      sameScope,
      ["DETERMINISTIC_RELATED_TARGET", hasCorrection ? "TRUSTED_CORRECTION" : "USER_REJECTED_TARGET"],
      0.97,
      true,
    );
  }
  return pending(input, relatedTargets, ["DETERMINISTIC_RELATED_TARGET", "CONTENT_RELATION_UNRESOLVED"]);
}

function validSemanticJudgment(
  judgment: EvolutionSemanticJudgment,
  targets: readonly EvolutionTargetVersion[],
): boolean {
  const runtimeAction: unknown = judgment.action;
  if (typeof runtimeAction !== "string"
    || !(EVOLUTION_ACTIONS as readonly string[]).includes(runtimeAction)
    || runtimeAction === "STORE") return false;
  if (!Number.isFinite(judgment.confidence) || judgment.confidence < 0 || judgment.confidence > 1) return false;
  if (judgment.reason.trim().length === 0 || judgment.reason.length > 1_000 || /[\0\r\n]/u.test(judgment.reason)) return false;
  const allowed = new Set(targets.map((target) => `${target.id}@${target.version}`));
  const selected = judgment.targetKnowledgeVersions.map((target) => `${target.id}@${target.version}`);
  return judgment.targetKnowledgeVersions.length > 0
    && selected.length <= MAX_TARGETS
    && new Set(selected).size === selected.length
    && selected.every((target) => allowed.has(target));
}

export function classifyKnowledgeEvolution(input: EvolutionMatchInput): EvolutionDecision {
  return deterministic(input);
}

export async function decideKnowledgeEvolution(
  input: EvolutionMatchInput,
  semantic?: KnowledgeEvolutionSemanticPort,
): Promise<EvolutionDecision> {
  const initial = deterministic(input);
  if (initial.status === "DECIDED" || semantic === undefined) return initial;
  const supplied = stableTargets([
    ...(input.exactTarget === undefined ? [] : [input.exactTarget]),
    ...input.retrievedTargets,
  ]).filter((target) => initial.targetKnowledgeVersions.some((item) => item.id === target.id && item.version === target.version));
  try {
    const judgment = await semantic.arbitrate(deepFreeze({
      candidate: clone(input.candidate),
      proposedScope: clone(input.proposedScope),
      targets: clone(supplied),
      deterministicReasons: [...initial.deterministicReasons],
    }));
    if (!validSemanticJudgment(judgment, initial.targetKnowledgeVersions)) {
      return pending(input, supplied, [...initial.deterministicReasons, "SEMANTIC_JUDGMENT_INVALID"]);
    }
    const chosen = supplied.filter((target) => judgment.targetKnowledgeVersions.some((item) =>
      item.id === target.id && item.version === target.version));
    const requiresConfirmation = judgment.action === "CONTRADICT"
      || (judgment.action === "SUPERSEDE" && chosen.some((target) => AUTHORITATIVE_STATUSES.has(target.status)));
    return decision(
      input,
      judgment.action,
      chosen,
      [...initial.deterministicReasons, "SEMANTIC_ARBITRATION_APPLIED"],
      judgment.confidence,
      requiresConfirmation,
      judgment.reason,
    );
  } catch {
    return pending(input, supplied, [...initial.deterministicReasons, "SEMANTIC_ARBITRATION_FAILED"]);
  }
}
