import type { KnowledgeAsset, KnowledgeCandidate, KnowledgeStatus } from "@zhiloop/domain";
import type { VerificationResult } from "@zhiloop/evidence-engine";
import type { FingerprintTarget, KnowledgeChangeSet, KnowledgeFingerprint } from "@zhiloop/invalidation-engine";

export type FreshnessStatus = "FRESH" | "REVALIDATE" | "CONFLICT" | "UNKNOWN";

export interface KnowledgeFreshnessRecord {
  readonly schemaVersion: 1;
  readonly assetId: string;
  readonly assetVersion: number;
  readonly assetContentHash: string;
  readonly projectId: string;
  readonly lifecycleStatus: KnowledgeStatus;
  readonly freshnessStatus: FreshnessStatus;
  /** Present on live reads; absent in legacy stored projections until state is joined. */
  readonly freshnessRevision?: number;
  /** Exact code/graph identity proven by the current Freshness state. */
  readonly codeRevision?: string;
  readonly graphRevision?: string;
  readonly candidate: KnowledgeCandidate;
  readonly fingerprint: KnowledgeFingerprint;
  readonly anchors: readonly FingerprintTarget[];
  readonly updatedAt: string;
}

export interface FreshnessProjectionInput {
  readonly asset: KnowledgeAsset;
  readonly candidate: KnowledgeCandidate;
  readonly verificationResults: readonly VerificationResult[];
  readonly projectId: string;
  readonly observedAt: string;
}

export interface FreshnessProjectionWriteResult {
  readonly status: "PROJECTED" | "IDEMPOTENT";
  readonly assetId: string;
  readonly assetVersion: number;
  readonly anchorCount: number;
}

export interface MigrationFreshnessProjectionInput extends FreshnessProjectionInput {
  readonly migrationId: string;
  readonly status: "FRESH" | "CONFLICT" | "UNKNOWN";
  readonly codeRevision: string;
  readonly graphRevision?: string;
  readonly verificationRunId: string;
  readonly reasonCodes: readonly string[];
}

export interface MigrationFreshnessWriteResult {
  readonly status: "PROJECTED" | "IDEMPOTENT" | "PREEXISTING";
  readonly assetId: string;
  readonly assetVersion: number;
  readonly anchorCount: number;
  readonly freshnessStatus: "FRESH" | "CONFLICT" | "UNKNOWN";
}

export interface MigrationFreshnessRollbackResult {
  readonly status: "ROLLED_BACK" | "IDEMPOTENT" | "NOT_OWNED" | "CONFLICT";
  readonly reasonCode?: "FRESHNESS_CHANGED" | "ACTIVE_VERSION_CHANGED" | "PROJECTION_CHANGED";
}

export interface MigrationFreshnessOwner {
  readonly migrationId: string;
  readonly payloadHash: string;
  readonly status: "OWNED" | "ROLLED_BACK";
}

export interface AffectedKnowledgeVersion {
  readonly assetId: string;
  readonly assetVersion: number;
}

export interface AffectedKnowledgeResult {
  readonly items: readonly AffectedKnowledgeVersion[];
  readonly bounded: boolean;
}

export interface FrozenAffectedKnowledgeSnapshot {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly projectId: string;
  readonly sourceRef: string;
  readonly changeSetHash: string;
  readonly recipeSelectionHash: string;
  readonly targetHash: string;
  readonly targetCount: number;
  readonly createdAt: string;
}

export interface FrozenAffectedKnowledgePage {
  readonly snapshot: FrozenAffectedKnowledgeSnapshot;
  readonly items: readonly AffectedKnowledgeVersion[];
  readonly nextCursor?: AffectedKnowledgeVersion;
}

export interface FreshnessPlan {
  readonly schemaVersion: 1;
  readonly assetId: string;
  readonly expectedAssetVersion: number;
  readonly freshnessStatus: FreshnessStatus;
  readonly currentLifecycleStatus: KnowledgeStatus;
  readonly targetLifecycleStatus: KnowledgeStatus;
  readonly action: "NONE" | "REFRESH_FINGERPRINT" | "REQUEST_REVALIDATION" | "MARK_STALE";
  readonly affectedAssertionIds: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly preserveBody: true;
}

export interface FreshnessPlanningInput {
  readonly record: KnowledgeFreshnessRecord;
  readonly changes: KnowledgeChangeSet;
  readonly revalidationResults?: readonly VerificationResult[];
}

export interface KnowledgeFreshnessState {
  readonly schemaVersion: 1;
  readonly assetId: string;
  readonly assetVersion: number;
  readonly projectId: string;
  readonly status: FreshnessStatus;
  readonly revision: number;
  readonly codeRevision: string;
  readonly graphRevision?: string;
  readonly reasonCodes: readonly string[];
  readonly affectedAssertionIds: readonly string[];
  readonly updatedAt: string;
}

export interface FreshnessStateTransitionInput {
  readonly assetId: string;
  readonly assetVersion: number;
  readonly expectedRevision: number;
  readonly projectId: string;
  readonly status: FreshnessStatus;
  readonly codeRevision: string;
  readonly graphRevision?: string;
  readonly reasonCodes: readonly string[];
  readonly affectedAssertionIds: readonly string[];
  readonly updatedAt: string;
}

export interface FreshnessStateTransitionResult {
  readonly status: "TRANSITIONED" | "IDEMPOTENT";
  readonly state: KnowledgeFreshnessState;
}

export interface FreshnessStateEvent extends KnowledgeFreshnessState {
  readonly eventId: string;
  readonly previousStatus: FreshnessStatus;
}
