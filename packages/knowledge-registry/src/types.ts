import type {
  CodeGraphArtifact,
  EvidenceRef,
  KnowledgeAsset,
  KnowledgeRelation,
  ScenarioDefinition,
} from "@zhiloop/domain";

export interface ProjectionWriteResult {
  readonly status: "PROJECTED" | "IDEMPOTENT";
  readonly indexVersion: number;
  readonly assetId: string;
  readonly assetVersion: number;
}

export interface KnowledgeProjectionOptions {
  readonly faultInjector?: (phase: "AFTER_ASSET_UPSERT") => void;
}

export interface ProjectionRebuildDiagnostic {
  readonly assetId: string;
  readonly code: "NO_VALID_VERSION" | "CURRENT_FALLBACK";
  readonly message: string;
}

export interface ProjectionRebuildResult {
  readonly indexVersion: number;
  readonly assets: number;
  readonly versions: number;
  readonly diagnostics: readonly ProjectionRebuildDiagnostic[];
}

export interface ProjectedKnowledgeAsset {
  readonly asset: KnowledgeAsset;
  readonly tombstone: boolean;
  readonly tombstoneReason?: string;
  readonly indexVersion: number;
}

export interface ProjectedKnowledgeVersion extends ProjectedKnowledgeAsset {
  readonly documentPath: string;
}

export interface KnowledgeSearchOptions {
  readonly limit?: number;
  readonly includeInactive?: boolean;
}

export interface KnowledgeListOptions {
  readonly includeTombstones?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export interface KnowledgeSearchResult {
  readonly asset: KnowledgeAsset;
  readonly rank: number;
  readonly score: number;
  readonly indexVersion: number;
}

export interface ProjectedRelations {
  readonly assetId: string;
  readonly assetVersion: number;
  readonly relations: readonly KnowledgeRelation[];
}

export interface ProjectedEvidence {
  readonly assetId: string;
  readonly assetVersion: number;
  readonly evidence: readonly EvidenceRef[];
}

export class KnowledgeProjectionConflictError extends Error {
  override readonly name = "KnowledgeProjectionConflictError";
}

export class KnowledgeProjectionRebuildError extends Error {
  override readonly name = "KnowledgeProjectionRebuildError";
}

export interface ScenarioProjectionWriteResult {
  readonly status: "PROJECTED" | "IDEMPOTENT";
  readonly scenarioId: string;
  readonly version: number;
}

export interface ScenarioProjectionRebuildResult {
  readonly scenarios: number;
  readonly versions: number;
  readonly bindings: number;
  readonly relations: number;
}

export interface ProjectedScenario {
  readonly definition: ScenarioDefinition;
  readonly knowledgeVersions: readonly string[];
}

export interface CodeGraphArtifactWriteResult {
  readonly status: "PROJECTED" | "IDEMPOTENT";
  readonly artifactId: string;
}

export interface ProjectedCodeGraphArtifact {
  readonly artifact: CodeGraphArtifact;
  readonly knowledgeVersions: readonly string[];
}
