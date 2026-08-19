import type {
  KnowledgeAsset,
  KnowledgeCandidate,
  KnowledgeLocator,
  KnowledgeScope,
  ScenarioDefinition,
  ScenarioEvolutionDecision,
} from "@zhiloop/domain";

export const EVOLUTION_ACTIONS = [
  "STORE",
  "SUPPLEMENT",
  "SUPERSEDE",
  "CONTRADICT",
  "SCOPE_SPLIT",
  "SKIP",
] as const;

export type EvolutionAction = (typeof EVOLUTION_ACTIONS)[number];

export interface EvolutionTargetVersion {
  readonly id: string;
  readonly version: number;
}

interface EvolutionDecisionBase {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly targetKnowledgeVersions: readonly EvolutionTargetVersion[];
  readonly proposedScope: KnowledgeScope;
  readonly deterministicReasons: readonly string[];
  readonly confidence: number;
  readonly requiresConfirmation: boolean;
  readonly semanticReason?: string;
}

export interface DecidedEvolutionDecision extends EvolutionDecisionBase {
  readonly status: "DECIDED";
  readonly action: EvolutionAction;
}

export interface PendingEvolutionDecision extends EvolutionDecisionBase {
  readonly status: "PENDING";
  readonly action?: never;
}

export type EvolutionDecision = DecidedEvolutionDecision | PendingEvolutionDecision;

export interface EvolutionCorrectionRef {
  readonly candidateId: string;
  readonly relationHint: "CONTRADICTS";
  readonly originalRef: string;
  readonly correctedRef: string;
}

export interface EvolutionMatchInput {
  readonly candidate: KnowledgeCandidate;
  readonly proposedScope: KnowledgeScope;
  readonly exactTarget?: KnowledgeAsset;
  readonly retrievedTargets: readonly KnowledgeAsset[];
  readonly correctionRefs?: readonly EvolutionCorrectionRef[];
}

export interface EvolutionSemanticRequest {
  readonly candidate: KnowledgeCandidate;
  readonly proposedScope: KnowledgeScope;
  readonly targets: readonly KnowledgeAsset[];
  readonly deterministicReasons: readonly string[];
}

export interface EvolutionSemanticJudgment {
  readonly action: Exclude<EvolutionAction, "STORE">;
  readonly targetKnowledgeVersions: readonly EvolutionTargetVersion[];
  readonly confidence: number;
  readonly reason: string;
}

export interface KnowledgeEvolutionSemanticPort {
  arbitrate(request: EvolutionSemanticRequest): Promise<EvolutionSemanticJudgment>;
}

export interface ScenarioReconciliationTarget {
  readonly definition: ScenarioDefinition;
  readonly locators: readonly KnowledgeLocator[];
}

export interface ScenarioReconciliationInput {
  readonly candidate: KnowledgeCandidate;
  readonly knowledgeVersion: string;
  readonly current?: ScenarioReconciliationTarget;
  readonly related: readonly ScenarioReconciliationTarget[];
  readonly now: string;
}

export interface ScenarioReconciliationResult {
  readonly decision: ScenarioEvolutionDecision;
  readonly next?: ScenarioDefinition;
}
