import type { ContextComplexityLevel } from "@zhiloop/domain";

export type KnowledgeFeedbackAction = "RELEVANT" | "IRRELEVANT" | "PIN" | "SUPPRESS";

export interface KnowledgeFeedbackEvent {
  readonly eventId: string;
  readonly assetId: string;
  readonly scopeKey: string;
  readonly action: KnowledgeFeedbackAction;
  readonly traceId: string;
  readonly actor: string;
  readonly occurredAt: string;
}

export interface McpExpansionEvent {
  readonly expansionId: string;
  readonly assetId: string;
  readonly scopeKey: string;
  readonly traceId: string;
  readonly occurredAt: string;
}

export interface McpUsageEvent {
  readonly usageEventId: string;
  readonly expansionId: string;
  readonly traceId: string;
  readonly occurredAt: string;
}

export interface AssetFeedbackScore {
  readonly assetId: string;
  readonly relevant: number;
  readonly irrelevant: number;
  readonly score: number;
  readonly pinned: boolean;
  readonly suppressed: boolean;
}

export interface FeedbackProfile {
  readonly scopeKey: string;
  readonly assets: readonly AssetFeedbackScore[];
  readonly pinnedAssetIds: readonly string[];
  readonly suppressedAssetIds: readonly string[];
  readonly preferredLevel: Exclude<ContextComplexityLevel, "L0_NONE" | "L4_EPISODE">;
  readonly sampleCount: number;
  readonly mcpExpanded: number;
  readonly mcpUsed: number;
  readonly reasonCodes: readonly string[];
}
