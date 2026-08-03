import {
  p2KnowledgeDetailViewSchema,
  p2KnowledgeEditImpactSchema,
  p2KnowledgeListViewSchema,
  p2SessionExtractionViewSchema,
  type P2KnowledgeDetailView,
  type P2KnowledgeEditImpact,
  type P2KnowledgeFilter,
  type P2KnowledgeListView,
  type P2SessionExtractionView,
} from "@zhiloop/control-api";

export type CapabilityStatus = "READY" | "DEGRADED" | "NOT_VERIFIED" | "NOT_CONFIGURED" | "DISABLED" | "FAILED";
export type KnowledgeScopeLevel = "TASK" | "SYMBOL" | "MODULE" | "PROJECT" | "GLOBAL";
export type KnowledgeStatus = "PROPOSED" | "ACCEPTED" | "IMPLEMENTED" | "VERIFIED" | "STALE" | "SUPERSEDED" | "REJECTED";
export type EvidenceVerdict = "SUPPORTS" | "CONTRADICTS" | "INCONCLUSIVE";

export type SessionExtractionView = P2SessionExtractionView;
export type KnowledgeFilter = P2KnowledgeFilter;
export type KnowledgeListView = P2KnowledgeListView;
export type KnowledgeDetailView = P2KnowledgeDetailView;
export type KnowledgeEditImpact = P2KnowledgeEditImpact;
export type ActionGate = SessionExtractionView["extractAction"];
export type ExtractionStageView = SessionExtractionView["stages"][number];
export type ExtractionSnapshotView = NonNullable<SessionExtractionView["snapshot"]>;
export type ProvenanceView = SessionExtractionView["reverseProvenance"][number];
export type ExtractionCandidateView = SessionExtractionView["candidates"][number];
export type KnowledgeSummaryView = KnowledgeListView["items"][number];
export type KnowledgeVersionView = KnowledgeDetailView["versions"][number];

export interface StartSessionExtractionCommand {
  readonly sessionId: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
}

export interface KnowledgeEditDraft {
  readonly title: string;
  readonly summary: string;
  readonly markdown: string;
}

export interface KnowledgeEditCommand {
  readonly knowledgeId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly draft: KnowledgeEditDraft;
}

export interface KnowledgeLifecycleCommand {
  readonly knowledgeId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly reason: string;
}

export const sessionExtractionViewSchema = p2SessionExtractionViewSchema;
export const knowledgeListViewSchema = p2KnowledgeListViewSchema;
export const knowledgeDetailViewSchema = p2KnowledgeDetailViewSchema;
export const knowledgeEditImpactSchema = p2KnowledgeEditImpactSchema;
