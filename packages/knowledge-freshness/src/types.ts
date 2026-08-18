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

export interface AffectedKnowledgeVersion {
  readonly assetId: string;
  readonly assetVersion: number;
}

export interface AffectedKnowledgeResult {
  readonly items: readonly AffectedKnowledgeVersion[];
  readonly bounded: boolean;
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
