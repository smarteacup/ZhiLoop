import type {
  EvidenceRef,
  KnowledgeAsset,
  KnowledgeKind,
  KnowledgeRelation,
  KnowledgeScope,
  KnowledgeStatus,
} from "@zhiloop/domain";
import type { IncrementalIndexResult } from "@zhiloop/knowledge-indexer";
import type {
  ProjectedEvidence,
  ProjectedKnowledgeAsset,
  ProjectedKnowledgeVersion,
  ProjectedRelations,
  ProjectionWriteResult,
} from "@zhiloop/knowledge-registry";
import type {
  MarkdownPublishOptions,
  MarkdownPublishResult,
  MarkdownReadResult,
  MarkdownTombstoneOptions,
  StoredKnowledgeVersion,
} from "@zhiloop/markdown-repository";

export interface KnowledgeRegistryPort {
  getAsset(assetId: string, includeTombstone?: boolean): ProjectedKnowledgeAsset | undefined;
  listAssets(options?: { readonly includeTombstones?: boolean; readonly limit?: number; readonly offset?: number }):
    readonly ProjectedKnowledgeAsset[];
  getVersion(assetId: string, version: number): ProjectedKnowledgeVersion | undefined;
  listVersions(assetId: string): readonly ProjectedKnowledgeVersion[];
  getEvidence(assetId: string, version: number): ProjectedEvidence;
  getRelations(assetId: string, version: number): ProjectedRelations;
  projectCurrent(record: StoredKnowledgeVersion): ProjectionWriteResult | Promise<ProjectionWriteResult>;
}

export interface GovernanceMarkdownPort {
  readCurrent(assetId: string): MarkdownReadResult | Promise<MarkdownReadResult>;
  readVersion(assetId: string, version: number): MarkdownReadResult | Promise<MarkdownReadResult>;
  publish(asset: KnowledgeAsset, options?: MarkdownPublishOptions): MarkdownPublishResult | Promise<MarkdownPublishResult>;
  tombstone(assetId: string, options: MarkdownTombstoneOptions): MarkdownPublishResult | Promise<MarkdownPublishResult>;
}

export interface GovernanceIndexPort {
  syncAsset(assetId: string): IncrementalIndexResult | Promise<IncrementalIndexResult>;
}

export interface EligibilityGatePort {
  exclude(assetId: string, operationId: string): void | Promise<void>;
  include(assetId: string, operationId: string): void | Promise<void>;
  isExcluded(assetId: string): boolean | Promise<boolean>;
}

export interface KnowledgeProvenanceRecord {
  readonly snapshotIds: readonly string[];
  readonly episodeIds: readonly string[];
  readonly sessionIds: readonly string[];
  readonly turnIds: readonly string[];
  readonly eventIds: readonly string[];
}

export interface KnowledgeUsageRecord {
  readonly usageId: string;
  readonly kind: "RETRIEVED" | "INJECTED" | "EXPANDED" | "FEEDBACK";
  readonly occurredAt: string;
  readonly runId?: string;
  readonly traceId?: string;
  readonly detail: string;
}

export interface KnowledgeLifecycleRecord {
  readonly version: number;
  readonly status: KnowledgeStatus;
  readonly occurredAt: string;
  readonly reasonCodes: readonly string[];
}

export interface KnowledgeMetadataPort {
  getProvenance(assetId: string, version: number, limit: number): KnowledgeProvenanceRecord | Promise<KnowledgeProvenanceRecord>;
  getUsage(assetId: string, version: number, limit: number): readonly KnowledgeUsageRecord[] | Promise<readonly KnowledgeUsageRecord[]>;
  getAssertions(assetId: string, version: number, limit: number): readonly string[] | Promise<readonly string[]>;
  getScopeReasonCodes(assetId: string, version: number): readonly string[] | Promise<readonly string[]>;
  getLifecycle(assetId: string, limit: number): readonly KnowledgeLifecycleRecord[] | Promise<readonly KnowledgeLifecycleRecord[]>;
  getLastVerifiedAt(assetId: string, version: number): string | undefined | Promise<string | undefined>;
}

export interface RevalidationResult {
  readonly scopeValid: boolean;
  readonly evidenceSupported: boolean;
  readonly evidence: readonly EvidenceRef[];
  readonly reasonCodes: readonly string[];
}

export interface KnowledgeRevalidationPort {
  revalidate(current: KnowledgeAsset, draft: KnowledgeAsset): RevalidationResult | Promise<RevalidationResult>;
}

export interface KnowledgeListFilter {
  readonly scopeLevels?: readonly KnowledgeScope["level"][];
  readonly projectId?: string;
  readonly kinds?: readonly KnowledgeKind[];
  readonly statuses?: readonly KnowledgeStatus[];
  readonly subject?: string;
  readonly symbol?: string;
  readonly keyword?: string;
  readonly evidenceVerdict?: EvidenceRef["verdict"];
  readonly version?: number;
  readonly eligibleOnly?: boolean;
  readonly includeSuppressed?: boolean;
}

export interface KnowledgeListRequest {
  readonly filter?: KnowledgeListFilter;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface KnowledgeListItem {
  readonly current: ProjectedKnowledgeAsset;
  readonly evidenceCount: number;
  readonly eligible: boolean;
  readonly eligibilityReasonCodes: readonly string[];
  readonly lastVerifiedAt?: string;
}

export interface KnowledgeListResponse {
  readonly items: readonly KnowledgeListItem[];
  readonly nextCursor?: string;
  readonly scanned: number;
  readonly excludedByReason: Readonly<Record<string, number>>;
}

export interface KnowledgeVersionDetail {
  readonly version: ProjectedKnowledgeVersion;
  readonly evidence: readonly EvidenceRef[];
  readonly relations: readonly KnowledgeRelation[];
  readonly provenance: KnowledgeProvenanceRecord;
  readonly usage: readonly KnowledgeUsageRecord[];
  readonly assertions: readonly string[];
  readonly scopeReasonCodes: readonly string[];
}

export interface KnowledgeDetail extends KnowledgeVersionDetail {
  readonly current: ProjectedKnowledgeAsset;
  readonly versions: readonly ProjectedKnowledgeVersion[];
  readonly lifecycle: readonly KnowledgeLifecycleRecord[];
}

export interface KnowledgeFieldChange {
  readonly field: keyof KnowledgeAsset;
  readonly before: unknown;
  readonly after: unknown;
}

export interface KnowledgeEditPatch {
  readonly title?: string;
  readonly summary?: string;
  readonly body?: string;
  readonly aliases?: readonly string[];
  readonly keywords?: readonly string[];
  readonly applicability?: readonly string[];
  readonly nonApplicability?: readonly string[];
  readonly symbols?: readonly string[];
  readonly scope?: KnowledgeScope;
  readonly relations?: readonly KnowledgeRelation[];
}

export interface KnowledgeImpactPreview {
  readonly changes: readonly KnowledgeFieldChange[];
  readonly currentEligible: boolean;
  readonly nextEligible: boolean;
  readonly scopeChanged: boolean;
  readonly evidenceDowngraded: boolean;
  readonly affectedRelationIds: readonly string[];
  readonly affectedSymbols: readonly string[];
  readonly reasonCodes: readonly string[];
}

export interface KnowledgeEditDraft {
  readonly draftId: string;
  readonly idempotencyKey: string;
  readonly assetId: string;
  readonly expectedVersion: number;
  readonly baseContentHash: string;
  readonly proposed: KnowledgeAsset;
  readonly revalidation: RevalidationResult;
  readonly impact: KnowledgeImpactPreview;
  readonly status: "VALIDATED" | "COMMITTED";
  readonly createdAt: string;
  readonly committedOperationId?: string;
}

export interface CreateEditDraftRequest {
  readonly assetId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly patch: KnowledgeEditPatch;
  readonly correlationId: string;
  readonly actor: string;
  readonly now: string;
}

export interface CommitEditDraftRequest {
  readonly draftId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly actor: string;
  readonly now: string;
}

export type GovernanceOperationKind = "EDIT" | "SUPPRESS" | "RESTORE" | "SUPERSEDE";
export type GovernanceOutboxStage = "ELIGIBILITY_EXCLUDE" | "MARKDOWN" | "REGISTRY" | "INDEX" | "ELIGIBILITY_FINALIZE";
export type GovernanceOperationStatus = "PENDING" | "DEGRADED" | "FAILED" | "COMPLETED";

export interface GovernanceStageRecord {
  readonly status: "PENDING" | "SUCCEEDED" | "RETRYABLE" | "FAILED";
  readonly attempts: number;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface GovernanceOperation {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly kind: GovernanceOperationKind;
  readonly assetId: string;
  readonly expectedVersion: number;
  readonly actor: string;
  readonly correlationId: string;
  readonly target: KnowledgeAsset;
  readonly targetTombstone: boolean;
  readonly tombstoneReason?: string;
  readonly status: GovernanceOperationStatus;
  readonly revision: number;
  readonly stages: Readonly<Record<GovernanceOutboxStage, GovernanceStageRecord>>;
  readonly markdown?: StoredKnowledgeVersion;
  readonly projection?: ProjectionWriteResult;
  readonly index?: IncrementalIndexResult;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GovernanceOperationStore {
  getDraft(draftId: string): KnowledgeEditDraft | undefined;
  getDraftByIdempotencyKey(idempotencyKey: string): KnowledgeEditDraft | undefined;
  createDraft(draft: KnowledgeEditDraft): void;
  markDraftCommitted(draftId: string, operationId: string): void;
  getOperation(operationId: string): GovernanceOperation | undefined;
  getOperationByIdempotencyKey(idempotencyKey: string): GovernanceOperation | undefined;
  createOperation(operation: GovernanceOperation): void;
  saveOperation(operation: GovernanceOperation, expectedRevision: number): void;
}

export interface MutationContext {
  readonly assetId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly actor: string;
  readonly now: string;
}

export interface SuppressRequest extends MutationContext {
  readonly reason: string;
}

export interface RestoreRequest extends MutationContext {
  readonly sourceVersion: number;
}

export interface SupersedeRequest extends MutationContext {
  readonly replacementAssetId: string;
  readonly reason: string;
}
