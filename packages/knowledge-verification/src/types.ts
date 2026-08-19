import type { CodeIntelligencePort } from "@zhiloop/code-intelligence";
import type { LedgerEventRecord } from "@zhiloop/conversation-ledger";
import type { KnowledgeAssertion, KnowledgeCandidate, ProjectContext } from "@zhiloop/domain";
import type { VerificationProbe, VerificationResult, CrossProjectAssertion } from "@zhiloop/evidence-engine";
import type { FileProbeOptions } from "@zhiloop/evidence-probes";

export type KnowledgeVerificationPurpose = "CANDIDATE" | "FRESHNESS" | "PRE_INJECTION";

export interface KnowledgeVersionRef {
  readonly assetId: string;
  readonly assetVersion: number;
}

export interface KnowledgeVerificationRequest {
  readonly candidate: KnowledgeCandidate;
  readonly project: ProjectContext;
  readonly requestedAt: string;
  readonly purpose: KnowledgeVerificationPurpose;
  readonly snapshot?: {
    readonly snapshotId: string;
    readonly sourceVersion: string;
    readonly contentHash: string;
    readonly records: readonly LedgerEventRecord[];
  };
  readonly assertionIds?: readonly string[];
  readonly expectedCodeRevision?: string;
  readonly knowledgeVersion?: KnowledgeVersionRef;
}

export type ProjectRevisionCapability = "READY" | "DEGRADED";

export interface ProjectRevisionSnapshot {
  readonly revision: string;
  readonly capability: ProjectRevisionCapability;
  readonly reasonCode: string;
}

export interface ProjectRevisionPort {
  capture(project: ProjectContext): Promise<ProjectRevisionSnapshot>;
}

export interface VerificationResultSummary {
  readonly assertionId: string;
  readonly assertionKind: KnowledgeAssertion["kind"];
  readonly status: VerificationResult["status"];
  readonly reasonCodes: readonly string[];
  readonly evidenceId?: string;
}

export interface KnowledgeVerificationRunSummary {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly requestId: string;
  readonly purpose: KnowledgeVerificationPurpose;
  readonly projectId: string;
  readonly subjectKey: string;
  readonly candidateId: string;
  readonly knowledgeVersion?: KnowledgeVersionRef;
  readonly codeRevision: string;
  readonly codeRevisionCapability: ProjectRevisionCapability;
  readonly graphRevision?: string;
  readonly status: "COMPLETED";
  readonly qualifyingProof: boolean;
  readonly results: readonly VerificationResultSummary[];
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface KnowledgeVerificationBatch {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly requestId: string;
  readonly purpose: KnowledgeVerificationPurpose;
  readonly projectId: string;
  readonly codeRevision: string;
  readonly codeRevisionCapability: ProjectRevisionCapability;
  readonly graphRevision?: string;
  readonly observedAt: string;
  readonly results: readonly VerificationResult[];
}

export interface VerificationRecipe {
  readonly assetId: string;
  readonly assetVersion: number;
  readonly recipeVersion: string;
  readonly assertions: readonly KnowledgeAssertion[];
  readonly createdAt: string;
}

export interface StoredVerificationRecipe extends VerificationRecipe {
  readonly assertionsHash: string;
}

export interface MigrationRecipeWriteResult {
  readonly status: "CREATED" | "IDEMPOTENT" | "PREEXISTING";
  readonly recipe: StoredVerificationRecipe;
}

export interface MigrationRecipeRollbackResult {
  readonly status: "ROLLED_BACK" | "IDEMPOTENT" | "NOT_OWNED";
}

export interface SupportingProofRef {
  readonly runId: string;
  readonly canonicalProjectId: string;
  readonly knowledgeVersion: KnowledgeVersionRef;
  readonly completedAt: string;
}

export interface KnowledgeVerificationStore {
  saveRecipe(recipe: VerificationRecipe): StoredVerificationRecipe;
  getRecipe(assetId: string, assetVersion: number, recipeVersion: string): StoredVerificationRecipe | undefined;
  appendRun(summary: KnowledgeVerificationRunSummary): KnowledgeVerificationRunSummary;
  getRun(runId: string): KnowledgeVerificationRunSummary | undefined;
  listRuns(assetId: string, assetVersion: number, limit: number): readonly KnowledgeVerificationRunSummary[];
  listSupportingProofs(subjectKey: string, limit: number): readonly SupportingProofRef[];
}

export type CurrentProofEligibility = "CURRENT" | "STALE" | "UNKNOWN";

export interface CurrentProofEligibilityPort {
  classify(proof: SupportingProofRef): CurrentProofEligibility | Promise<CurrentProofEligibility>;
}

export interface CrossProjectProbeDependencies {
  readonly store: KnowledgeVerificationStore;
  readonly eligibility: CurrentProofEligibilityPort;
}

export interface KnowledgeVerificationServiceOptions {
  readonly revisions: ProjectRevisionPort;
  readonly store: KnowledgeVerificationStore;
  readonly codeIntelligence?: CodeIntelligencePort;
  readonly crossProject?: CrossProjectProbeDependencies;
  readonly fileProbe?: FileProbeOptions;
  readonly maxAssertions?: number;
  readonly maxSnapshotRecords?: number;
  readonly timeoutMs?: number;
}

export interface VerificationExecutionControls {
  readonly signal?: AbortSignal;
  readonly deadlineAt?: string;
}

export interface CrossProjectProbeFactory {
  create(currentProjectId: string): VerificationProbe<CrossProjectAssertion>;
}
