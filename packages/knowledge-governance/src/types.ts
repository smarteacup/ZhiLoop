import type { EvidenceRef, KnowledgeAsset, KnowledgeRelation } from "@zhiloop/domain";
import type { ProjectedKnowledgeAsset, ProjectionRebuildResult } from "@zhiloop/knowledge-registry";

export type GovernanceOperation = "MARK_STALE" | "SUPPRESS" | "REBUILD";
export type GovernanceAuditStatus = "STARTED" | "SUCCEEDED" | "FAILED";

export interface GovernanceAuditEntry {
  readonly auditId: string;
  readonly operation: GovernanceOperation;
  readonly target: string;
  readonly actor: string;
  readonly correlationId: string;
  readonly status: GovernanceAuditStatus;
  readonly reason?: string;
  readonly error?: string;
  readonly startedAt: string;
  readonly completedAt?: string;
}

export interface SuppressionRecord {
  readonly assetId: string;
  readonly scopeKey: string;
  readonly reason: string;
  readonly actor: string;
  readonly correlationId: string;
  readonly createdAt: string;
}

export interface GovernanceMutationContext {
  readonly actor: string;
  readonly correlationId: string;
  readonly now: string;
}

export interface KnowledgeFieldDiff {
  readonly field: keyof KnowledgeAsset;
  readonly before: unknown;
  readonly after: unknown;
}

export interface KnowledgeDiff {
  readonly assetId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly changes: readonly KnowledgeFieldDiff[];
}

export interface KnowledgeTrace {
  readonly assetId: string;
  readonly version: number;
  readonly sourceEpisodes: readonly string[];
  readonly evidence: readonly EvidenceRef[];
  readonly relations: readonly KnowledgeRelation[];
}

export type DoctorDiagnosticCode =
  | "INVALID_MARKDOWN_CURRENT"
  | "MISSING_PROJECTION"
  | "ORPHAN_PROJECTION"
  | "VERSION_MISMATCH"
  | "HASH_MISMATCH"
  | "TOMBSTONE_MISMATCH";

export interface DoctorDiagnostic {
  readonly severity: "ERROR";
  readonly code: DoctorDiagnosticCode;
  readonly assetId: string;
  readonly message: string;
}

export interface DoctorReport {
  readonly healthy: boolean;
  readonly markdownAssets: number;
  readonly projectedAssets: number;
  readonly diagnostics: readonly DoctorDiagnostic[];
}

export interface MutationResult<T> {
  readonly auditId: string;
  readonly value: T;
}

export interface MarkStaleInput extends GovernanceMutationContext {
  readonly assetId: string;
  readonly reason: string;
}

export interface SuppressInput extends GovernanceMutationContext {
  readonly assetId: string;
  readonly reason: string;
  readonly scopeKey?: string;
}

export interface KnowledgeGovernancePort {
  list(includeTombstones?: boolean): readonly ProjectedKnowledgeAsset[];
  show(assetId: string): ProjectedKnowledgeAsset;
  diff(assetId: string, fromVersion: number, toVersion: number): KnowledgeDiff;
  trace(assetId: string, version?: number): KnowledgeTrace;
  markStale(input: MarkStaleInput): Promise<MutationResult<ProjectedKnowledgeAsset>>;
  suppress(input: SuppressInput): MutationResult<SuppressionRecord>;
  rebuild(context: GovernanceMutationContext): Promise<MutationResult<ProjectionRebuildResult>>;
  doctor(): Promise<DoctorReport>;
}
