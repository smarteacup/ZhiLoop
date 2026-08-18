import type { KnowledgeAsset } from "@zhiloop/domain";

import type { KnowledgeFreshnessRecord } from "./types.js";

export type FreshnessGateReason =
  | "FRESHNESS_NOT_REQUIRED"
  | "FRESHNESS_CONFIRMED"
  | "FRESHNESS_PROJECTION_MISSING"
  | "FRESHNESS_PROJECTION_MISMATCH"
  | "FRESHNESS_REVALIDATION_REQUIRED"
  | "FRESHNESS_CONFLICT"
  | "FRESHNESS_UNKNOWN";

export interface FreshnessRecordReadPort {
  get(assetId: string): KnowledgeFreshnessRecord | undefined;
}

export interface FreshnessGateDecision {
  readonly assetId: string;
  readonly assetVersion: number;
  readonly eligible: boolean;
  readonly freshness: KnowledgeFreshnessRecord["freshnessStatus"] | "NOT_REQUIRED";
  readonly reasonCode: FreshnessGateReason;
}

export interface FreshnessGateResult {
  readonly eligibleAssetIds: readonly string[];
  readonly eligibleAssetVersions: readonly string[];
  readonly decisions: readonly FreshnessGateDecision[];
}

function requiresFreshness(asset: KnowledgeAsset): boolean {
  return asset.kind === "IMPLEMENTATION" || asset.symbols.length > 0;
}

function reason(record: KnowledgeFreshnessRecord): FreshnessGateReason {
  switch (record.freshnessStatus) {
    case "FRESH": return "FRESHNESS_CONFIRMED";
    case "REVALIDATE": return "FRESHNESS_REVALIDATION_REQUIRED";
    case "CONFLICT": return "FRESHNESS_CONFLICT";
    case "UNKNOWN": return "FRESHNESS_UNKNOWN";
  }
}

export class ProjectionFreshnessGate {
  constructor(private readonly records: FreshnessRecordReadPort) {}

  inspect(projectId: string, assets: readonly KnowledgeAsset[]): FreshnessGateResult {
    if (projectId.trim().length === 0 || projectId.length > 1_000 || assets.length > 1_000) {
      throw new Error("FRESHNESS_GATE_INPUT_INVALID");
    }
    const decisions = assets.map((asset): FreshnessGateDecision => {
      if (!requiresFreshness(asset)) {
        return Object.freeze({
          assetId: asset.id, assetVersion: asset.version, eligible: true,
          freshness: "NOT_REQUIRED", reasonCode: "FRESHNESS_NOT_REQUIRED",
        });
      }
      const record = this.records.get(asset.id);
      if (record === undefined) {
        return Object.freeze({
          assetId: asset.id, assetVersion: asset.version, eligible: false,
          freshness: "UNKNOWN", reasonCode: "FRESHNESS_PROJECTION_MISSING",
        });
      }
      if (record.assetVersion !== asset.version || record.assetContentHash !== asset.contentHash || record.projectId !== projectId) {
        return Object.freeze({
          assetId: asset.id, assetVersion: asset.version, eligible: false,
          freshness: "UNKNOWN", reasonCode: "FRESHNESS_PROJECTION_MISMATCH",
        });
      }
      return Object.freeze({
        assetId: asset.id,
        assetVersion: asset.version,
        eligible: record.freshnessStatus === "FRESH",
        freshness: record.freshnessStatus,
        reasonCode: reason(record),
      });
    });
    return Object.freeze({
      eligibleAssetIds: Object.freeze(decisions.filter((item) => item.eligible).map((item) => item.assetId)),
      eligibleAssetVersions: Object.freeze(decisions.filter((item) => item.eligible)
        .map((item) => `${item.assetId}@${item.assetVersion}`)),
      decisions: Object.freeze(decisions),
    });
  }
}
