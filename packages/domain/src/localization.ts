export const KNOWLEDGE_CLAIM_MODES = ["CURRENT_STATE", "USER_DECISION", "FUTURE_REQUIREMENT"] as const;
export type KnowledgeClaimMode = (typeof KNOWLEDGE_CLAIM_MODES)[number];

export const BRANCH_APPLICABILITY_MODES = ["EXACT_BRANCH", "BRANCH_LINEAGE", "ALL_BRANCHES"] as const;
export type BranchApplicabilityMode = (typeof BRANCH_APPLICABILITY_MODES)[number];

export type BranchApplicability =
  | { readonly mode: "EXACT_BRANCH"; readonly branch: string }
  | { readonly mode: "BRANCH_LINEAGE"; readonly baseCommit: string; readonly observedBranch?: string }
  | { readonly mode: "ALL_BRANCHES"; readonly reason: string };

export interface ObservedCodeRevision {
  readonly branch?: string;
  readonly commit?: string;
  readonly dirty: boolean;
  readonly codegraphRevision?: string;
}

export interface ScenarioHint {
  readonly scenarioKey: string;
  readonly title: string;
  readonly summary: string;
  readonly taskIntents: readonly string[];
  readonly entryPoints: readonly string[];
  readonly applicability: readonly string[];
  readonly nonApplicability: readonly string[];
}

export interface KnowledgeLocator {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly repositoryRemote?: string;
  readonly observedRevision: ObservedCodeRevision;
  readonly branchApplicability: BranchApplicability;
  readonly scenarioId: string;
  readonly scenarioKey: string;
  readonly scenarioTitle: string;
  readonly scenarioSummary: string;
  readonly modulePaths: readonly string[];
  readonly symbols: readonly string[];
  readonly entryPoints: readonly string[];
  readonly taskIntents: readonly string[];
  readonly applicability: readonly string[];
  readonly nonApplicability: readonly string[];
}

export const SCENARIO_RELATION_TYPES = [
  "CHILD_OF",
  "OVERLAPS",
  "ALIAS_OF",
  "MERGED_INTO",
  "SPLIT_FROM",
] as const;
export type ScenarioRelationType = (typeof SCENARIO_RELATION_TYPES)[number];

export interface ScenarioRelation {
  readonly type: ScenarioRelationType;
  readonly targetScenarioId: string;
  readonly reasonCodes: readonly string[];
}

export interface ScenarioDefinition {
  readonly schemaVersion: 1;
  readonly scenarioId: string;
  readonly projectId: string;
  readonly scenarioKey: string;
  readonly version: number;
  readonly title: string;
  readonly summary: string;
  readonly taskIntents: readonly string[];
  readonly entryPoints: readonly string[];
  readonly applicability: readonly string[];
  readonly nonApplicability: readonly string[];
  readonly aliases: readonly string[];
  readonly relations: readonly ScenarioRelation[];
  readonly sourceKnowledgeVersions: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const SCENARIO_EVOLUTION_ACTIONS = [
  "CREATE",
  "UPDATE_VERSION",
  "MERGE_VERSION",
  "KEEP_SEPARATE",
  "SUPERSEDE",
  "CONTRADICT",
  "SKIP",
] as const;
export type ScenarioEvolutionAction = (typeof SCENARIO_EVOLUTION_ACTIONS)[number];

export type ScenarioEvolutionDecision =
  | {
      readonly status: "DECIDED";
      readonly action: ScenarioEvolutionAction;
      readonly scenarioId: string;
      readonly targetScenarioIds: readonly string[];
      readonly reasonCodes: readonly string[];
    }
  | {
      readonly status: "PENDING";
      readonly scenarioId: string;
      readonly targetScenarioIds: readonly string[];
      readonly reasonCodes: readonly string[];
    };

const SCENARIO_KEY = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,}$/u;
const GIT_COMMIT = /^[0-9a-f]{7,64}$/u;
const SAFE_TEXT = /^[^\0\r\n]+$/u;

function hasText(value: string | undefined, max = 4_096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && SAFE_TEXT.test(value);
}

function validItems(values: readonly string[], maximum = 100): boolean {
  return values.length <= maximum && values.every((value) => hasText(value, 4_096));
}

export function isValidScenarioKey(value: string): boolean {
  return value.length <= 500 && SCENARIO_KEY.test(value);
}

export function deriveScenarioId(projectId: string, scenarioKey: string): string {
  if (!hasText(projectId, 500) || !isValidScenarioKey(scenarioKey)) throw new Error("SCENARIO_ID_INPUT_INVALID");
  return `scenario:${projectId}:${scenarioKey}`;
}

export interface LocatorValidationResult {
  readonly valid: boolean;
  readonly reasonCodes: readonly string[];
}

export function validateKnowledgeLocator(locator: KnowledgeLocator): LocatorValidationResult {
  const reasons = new Set<string>();
  if (locator.schemaVersion !== 1) reasons.add("LOCATOR_SCHEMA_UNSUPPORTED");
  if (!hasText(locator.projectId, 500)) reasons.add("LOCATOR_PROJECT_MISSING");
  if (locator.repositoryRemote !== undefined && !hasText(locator.repositoryRemote)) reasons.add("LOCATOR_REMOTE_INVALID");
  if (!hasText(locator.projectId, 500) || !isValidScenarioKey(locator.scenarioKey)
    || locator.scenarioId !== deriveScenarioId(locator.projectId, locator.scenarioKey)) reasons.add("LOCATOR_SCENARIO_INVALID");
  if (!hasText(locator.scenarioTitle, 500) || !hasText(locator.scenarioSummary, 4_000)) reasons.add("LOCATOR_SCENARIO_DESCRIPTION_INVALID");
  if (locator.observedRevision.branch !== undefined && !hasText(locator.observedRevision.branch, 500)) reasons.add("LOCATOR_BRANCH_INVALID");
  if (locator.observedRevision.commit !== undefined && !GIT_COMMIT.test(locator.observedRevision.commit)) reasons.add("LOCATOR_COMMIT_INVALID");
  if (typeof locator.observedRevision.dirty !== "boolean") reasons.add("LOCATOR_DIRTY_INVALID");
  if (locator.observedRevision.codegraphRevision !== undefined
    && !hasText(locator.observedRevision.codegraphRevision, 500)) reasons.add("LOCATOR_CODEGRAPH_REVISION_INVALID");
  if (locator.branchApplicability.mode === "EXACT_BRANCH" && !hasText(locator.branchApplicability.branch, 500)) {
    reasons.add("LOCATOR_EXACT_BRANCH_INVALID");
  }
  if (locator.branchApplicability.mode === "BRANCH_LINEAGE"
    && !GIT_COMMIT.test(locator.branchApplicability.baseCommit)) reasons.add("LOCATOR_LINEAGE_COMMIT_INVALID");
  if (locator.branchApplicability.mode === "ALL_BRANCHES" && !hasText(locator.branchApplicability.reason, 1_000)) {
    reasons.add("LOCATOR_ALL_BRANCHES_REASON_INVALID");
  }
  for (const [name, values] of Object.entries({
    modulePaths: locator.modulePaths,
    symbols: locator.symbols,
    entryPoints: locator.entryPoints,
    taskIntents: locator.taskIntents,
    applicability: locator.applicability,
    nonApplicability: locator.nonApplicability,
  })) if (!validItems(values)) reasons.add(`LOCATOR_${name.replace(/[A-Z]/gu, (value) => `_${value}`).toUpperCase()}_INVALID`);
  return Object.freeze({ valid: reasons.size === 0, reasonCodes: Object.freeze([...reasons].sort()) });
}

export function locatorHasAuthoritativeRevision(locator: KnowledgeLocator): boolean {
  return locator.observedRevision.branch !== undefined && locator.observedRevision.commit !== undefined;
}
