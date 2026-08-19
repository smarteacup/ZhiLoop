import {
  deriveScenarioId,
  type KnowledgeLocator,
  type ScenarioDefinition,
  type ScenarioEvolutionAction,
  type ScenarioEvolutionDecision,
  type ScenarioRelation,
} from "@zhiloop/domain";

import type {
  ScenarioReconciliationInput,
  ScenarioReconciliationResult,
  ScenarioReconciliationTarget,
} from "./types.js";

const MAX_RELATED = 20;

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function normalizedSet(values: readonly string[]): ReadonlySet<string> {
  return new Set(values.map(normalized).filter(Boolean));
}

function equalSet(left: readonly string[], right: readonly string[]): boolean {
  const a = normalizedSet(left);
  const b = normalizedSet(right);
  return a.size === b.size && [...a].every((item) => b.has(item));
}

function overlap(left: readonly string[], right: readonly string[]): number {
  const a = normalizedSet(left);
  const b = normalizedSet(right);
  if (a.size === 0 || b.size === 0) return 0;
  return [...a].filter((item) => b.has(item)).length / Math.max(a.size, b.size);
}

function branchIdentity(locator: KnowledgeLocator): string {
  if (locator.branchApplicability.mode === "EXACT_BRANCH") return `branch:${locator.branchApplicability.branch}`;
  if (locator.branchApplicability.mode === "BRANCH_LINEAGE") return `commit:${locator.branchApplicability.baseCommit}`;
  return `all:${locator.branchApplicability.reason}`;
}

function boundaryConflict(locator: KnowledgeLocator, target: ScenarioReconciliationTarget): boolean {
  const branches = new Set(target.locators.map(branchIdentity));
  return (branches.size > 0 && !branches.has(branchIdentity(locator)))
    || !equalSet(locator.nonApplicability, target.definition.nonApplicability);
}

function relatedScore(locator: KnowledgeLocator, target: ScenarioReconciliationTarget): number {
  return Math.max(
    overlap(locator.entryPoints, target.definition.entryPoints),
    overlap(locator.taskIntents, target.definition.taskIntents),
    normalized(locator.scenarioTitle) === normalized(target.definition.title) ? 1 : 0,
  );
}

function decision(
  status: "DECIDED" | "PENDING",
  action: ScenarioEvolutionAction | undefined,
  scenarioId: string,
  targets: readonly string[],
  reasons: readonly string[],
): ScenarioEvolutionDecision {
  const base = { status, scenarioId, targetScenarioIds: [...new Set(targets)].sort(),
    reasonCodes: [...new Set(reasons)].sort() };
  if (status === "DECIDED" && action === undefined) throw new Error("SCENARIO_EVOLUTION_ACTION_REQUIRED");
  return Object.freeze(status === "PENDING" ? base : { ...base, action }) as ScenarioEvolutionDecision;
}

function relation(type: ScenarioRelation["type"], targetScenarioId: string, reasonCodes: readonly string[]): ScenarioRelation {
  return Object.freeze({ type, targetScenarioId, reasonCodes: Object.freeze([...new Set(reasonCodes)].sort()) });
}

function nextDefinition(input: ScenarioReconciliationInput, current?: ScenarioDefinition,
  relations: readonly ScenarioRelation[] = []): ScenarioDefinition {
  const locator = input.candidate.locator!;
  const createdAt = current?.createdAt ?? input.now;
  return Object.freeze({
    schemaVersion: 1,
    scenarioId: locator.scenarioId,
    projectId: locator.projectId,
    scenarioKey: locator.scenarioKey,
    version: (current?.version ?? 0) + 1,
    title: locator.scenarioTitle,
    summary: locator.scenarioSummary,
    taskIntents: Object.freeze([...new Set([...(current?.taskIntents ?? []), ...locator.taskIntents])].sort()),
    entryPoints: Object.freeze([...new Set([...(current?.entryPoints ?? []), ...locator.entryPoints])].sort()),
    applicability: Object.freeze([...new Set([...(current?.applicability ?? []), ...locator.applicability])].sort()),
    nonApplicability: Object.freeze([...new Set([...(current?.nonApplicability ?? []), ...locator.nonApplicability])].sort()),
    aliases: Object.freeze([...new Set([...(current?.aliases ?? []), locator.scenarioTitle])].sort()),
    relations: Object.freeze([...new Map([...(current?.relations ?? []), ...relations]
      .map((item) => [`${item.type}:${item.targetScenarioId}`, item])).values()]),
    sourceKnowledgeVersions: Object.freeze([...new Set([
      ...(current?.sourceKnowledgeVersions ?? []), input.knowledgeVersion,
    ])].sort()),
    createdAt,
    updatedAt: input.now,
  });
}

export function reconcileScenario(input: ScenarioReconciliationInput): ScenarioReconciliationResult {
  if (input.candidate.schemaVersion !== 2 || input.candidate.locator === undefined) {
    throw new Error("SCENARIO_RECONCILIATION_REQUIRES_LOCATED_CANDIDATE");
  }
  if (!Number.isFinite(Date.parse(input.now)) || input.related.length > MAX_RELATED
    || input.knowledgeVersion.trim().length === 0 || input.knowledgeVersion.length > 1_000) {
    throw new Error("SCENARIO_RECONCILIATION_INPUT_INVALID");
  }
  const locator = input.candidate.locator;
  if (locator.scenarioId !== deriveScenarioId(locator.projectId, locator.scenarioKey)) {
    throw new Error("SCENARIO_RECONCILIATION_LOCATOR_INVALID");
  }
  if (input.current !== undefined) {
    const current = input.current.definition;
    if (current.scenarioId !== locator.scenarioId || current.projectId !== locator.projectId) {
      throw new Error("SCENARIO_RECONCILIATION_CURRENT_MISMATCH");
    }
    if (current.sourceKnowledgeVersions.includes(input.knowledgeVersion)) {
      return Object.freeze({ decision: decision("DECIDED", "SKIP", locator.scenarioId,
        [current.scenarioId], ["KNOWLEDGE_ALREADY_BOUND"]) });
    }
    if (boundaryConflict(locator, input.current)) {
      return Object.freeze({ decision: decision("PENDING", undefined, locator.scenarioId,
        [current.scenarioId], ["STABLE_KEY_BOUNDARY_CONFLICT", "AUTOMATIC_UPDATE_BLOCKED"]) });
    }
    return Object.freeze({
      decision: decision("DECIDED", "UPDATE_VERSION", locator.scenarioId,
        [current.scenarioId], ["STABLE_SCENARIO_KEY", "KNOWLEDGE_BINDING_ADDED"]),
      next: nextDefinition(input, current),
    });
  }

  const relevant = input.related
    .filter((target) => target.definition.projectId === locator.projectId)
    .map((target) => ({ target, score: relatedScore(locator, target) }))
    .filter((item) => item.score >= 0.5)
    .sort((left, right) => right.score - left.score || left.target.definition.scenarioId.localeCompare(right.target.definition.scenarioId));
  const conflicts = relevant.filter((item) => boundaryConflict(locator, item.target));
  if (conflicts.length > 0) {
    const relations = conflicts.map((item) => relation("OVERLAPS", item.target.definition.scenarioId,
      ["SEMANTIC_OVERLAP", "BOUNDARY_CONFLICT"]));
    return Object.freeze({
      decision: decision("DECIDED", "KEEP_SEPARATE", locator.scenarioId,
        conflicts.map((item) => item.target.definition.scenarioId), ["BOUNDARY_CONFLICT", "OVERLAP_RECORDED"]),
      next: nextDefinition(input, undefined, relations),
    });
  }
  if (relevant.length > 1 && relevant[0]!.score === relevant[1]!.score) {
    return Object.freeze({ decision: decision("PENDING", undefined, locator.scenarioId,
      relevant.map((item) => item.target.definition.scenarioId), ["AMBIGUOUS_SCENARIO_MATCH"]) });
  }
  if (relevant.length === 1 && relevant[0]!.score === 1) {
    return Object.freeze({ decision: decision("PENDING", undefined, locator.scenarioId,
      [relevant[0]!.target.definition.scenarioId], ["POSSIBLE_SCENARIO_ALIAS", "MERGE_REQUIRES_CONFIRMATION"]) });
  }
  return Object.freeze({
    decision: decision("DECIDED", "CREATE", locator.scenarioId, [], ["NO_COMPATIBLE_SCENARIO"]),
    next: nextDefinition(input),
  });
}
