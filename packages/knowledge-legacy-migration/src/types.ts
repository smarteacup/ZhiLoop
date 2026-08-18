import type { KnowledgeAssertion, KnowledgeCandidate } from "@zhiloop/domain";

export const LEGACY_MIGRATION_VERSION = "legacy-code-knowledge-v1";
export const LEGACY_RECIPE_VERSION = "evidence-recipe-v1";
export const LEGACY_MIGRATION_STATUSES = [
  "READY", "COMMITTING", "COMPLETED", "FAILED", "ROLLING_BACK", "ROLLED_BACK", "ROLLBACK_CONFLICT",
] as const;
export type LegacyMigrationStatus = (typeof LEGACY_MIGRATION_STATUSES)[number];
export type LegacyMigrationClassification = "MIGRATABLE" | "ALREADY_CURRENT" | "SKIPPED";
export type LegacyMigrationSource = "FRESHNESS" | "RECIPE" | "SYMBOL_ANCHOR" | "NONE";
export type LegacyMigrationItemStatus = "PENDING" | "MIGRATED" | "SKIPPED" | "FAILED" | "ROLLED_BACK" | "ROLLBACK_CONFLICT";

export interface LegacyMigrationItemSnapshot {
  readonly schemaVersion: 1;
  readonly ordinal: number;
  readonly assetId: string;
  readonly assetVersion: number;
  readonly assetContentHash: string;
  readonly assetIndexVersion: number;
  readonly classification: LegacyMigrationClassification;
  readonly source: LegacyMigrationSource;
  readonly candidateId?: string;
  readonly assertionsHash?: string;
  readonly assertionKinds: readonly KnowledgeAssertion["kind"][];
  readonly reasonCodes: readonly string[];
}

export interface LegacyMigrationItemRecord extends LegacyMigrationItemSnapshot {
  readonly migrationId: string;
  readonly status: LegacyMigrationItemStatus;
  readonly verificationRunId?: string;
  readonly freshnessStatus?: "FRESH" | "CONFLICT" | "UNKNOWN";
  readonly createdRecipe?: boolean;
  readonly createdFreshness?: boolean;
  readonly updatedAt: string;
}

export interface LegacyMigrationPreview {
  readonly schemaVersion: 1;
  readonly migrationId: string;
  readonly migrationVersion: string;
  readonly projectId: string;
  readonly sourceRegistryRevision: number;
  readonly status: LegacyMigrationStatus;
  readonly revision: number;
  readonly scannedCount: number;
  readonly migratableCount: number;
  readonly alreadyCurrentCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly rollbackConflictCount: number;
  readonly summaryHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly jobId?: string;
  readonly failureCode?: string;
}

export interface CreateLegacyMigrationPreviewInput {
  readonly migrationVersion: string;
  readonly projectId: string;
  readonly sourceRegistryRevision: number;
  readonly items: readonly LegacyMigrationItemSnapshot[];
  readonly createdAt: string;
}

export interface LegacyMigrationPage {
  readonly items: readonly LegacyMigrationItemRecord[];
  readonly nextOrdinal?: number;
}

export interface LegacyMigrationCandidateResolution {
  readonly classification: LegacyMigrationClassification;
  readonly source: LegacyMigrationSource;
  readonly reasonCodes: readonly string[];
  readonly candidate?: KnowledgeCandidate;
  readonly assertions?: readonly KnowledgeAssertion[];
}
