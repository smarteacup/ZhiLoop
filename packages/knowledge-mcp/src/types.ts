import type { ContextAuthority, ContextEvidenceSummary, KnowledgeAsset, KnowledgeScope } from "@zhiloop/domain";
import type { QueryContext } from "@zhiloop/query-context";

export type KnowledgeMcpToolName = "ckl.search" | "ckl.get" | "ckl.related" | "ckl.check";

export interface KnownKnowledgeItem {
  readonly id: string;
  readonly version: number;
  readonly detailLevel: "L1_POINTER" | "L2_COMPACT" | "L3_EVIDENCED";
}

export interface KnowledgeMcpBackendRequest {
  readonly context: QueryContext;
  readonly signal: AbortSignal;
}

export interface KnowledgeMcpBackendResult {
  readonly traceId: string;
  readonly assets: readonly KnowledgeAsset[];
}

export interface KnowledgeMcpBackend {
  search(request: KnowledgeMcpBackendRequest & { readonly query: string; readonly limit: number }): Promise<KnowledgeMcpBackendResult>;
  related(request: KnowledgeMcpBackendRequest & { readonly seedAssetIds: readonly string[]; readonly limit: number }): Promise<KnowledgeMcpBackendResult>;
  current(request: KnowledgeMcpBackendRequest & { readonly assetIds: readonly string[] }): Promise<KnowledgeMcpBackendResult>;
}

export interface KnowledgeMcpPointerItem {
  readonly id: string;
  readonly version: number;
  readonly subjectKey: string;
  readonly kind: KnowledgeAsset["kind"];
  readonly status: KnowledgeAsset["status"];
  readonly scope: KnowledgeScope;
  readonly authority: ContextAuthority;
  readonly detailLevel: "L1_POINTER";
  readonly title: string;
  readonly summary: string;
}

/** @deprecated Use KnowledgeMcpPointerItem. Runtime discovery now returns L1 pointers. */
export type KnowledgeMcpCompactItem = KnowledgeMcpPointerItem;

interface KnowledgeMcpExpansionBase {
  readonly id: string;
  readonly version: number;
}

interface KnowledgeMcpCompactFields {
  readonly applicability: readonly string[];
  readonly failurePaths: readonly string[];
  readonly symbols: readonly string[];
  readonly evidencePointers: readonly string[];
}

export type KnowledgeMcpCompactExpansionDelta = KnowledgeMcpExpansionBase & KnowledgeMcpCompactFields & {
    readonly fromDetailLevel: "L1_POINTER";
    readonly toDetailLevel: "L2_COMPACT";
  };

export type KnowledgeMcpEvidencedExpansionDelta =
  | (KnowledgeMcpExpansionBase & KnowledgeMcpCompactFields & {
    readonly fromDetailLevel: "L1_POINTER";
    readonly toDetailLevel: "L3_EVIDENCED";
    readonly content: string;
    readonly evidenceSummary: readonly ContextEvidenceSummary[];
  })
  | (KnowledgeMcpExpansionBase & {
    readonly fromDetailLevel: "L2_COMPACT";
    readonly toDetailLevel: "L3_EVIDENCED";
    readonly content: string;
    readonly evidenceSummary: readonly ContextEvidenceSummary[];
  });

export type KnowledgeMcpExpansionDelta = KnowledgeMcpCompactExpansionDelta | KnowledgeMcpEvidencedExpansionDelta;

export interface KnowledgeMcpCheck {
  readonly id: string;
  readonly requestedVersion?: number;
  readonly currentVersion?: number;
  readonly eligible: boolean;
  readonly reasonCodes: readonly string[];
}

export interface KnowledgeMcpSearchInput {
  readonly query: string;
  readonly limit?: number;
  readonly knownItems?: readonly KnownKnowledgeItem[];
}

export interface KnowledgeMcpGetInput {
  readonly id: string;
  readonly version: number;
  readonly fromDetailLevel: "L1_POINTER" | "L2_COMPACT";
  readonly targetDetailLevel?: "L2_COMPACT" | "L3_EVIDENCED";
}

export interface KnowledgeMcpRelatedInput {
  readonly seedAssetIds: readonly string[];
  readonly limit?: number;
  readonly knownItems?: readonly KnownKnowledgeItem[];
}

export interface KnowledgeMcpCheckInput {
  readonly items: readonly { readonly id: string; readonly version?: number }[];
}

export interface KnowledgeMcpItemsResult {
  readonly traceId: string;
  readonly tool: "ckl.search" | "ckl.related";
  readonly items: readonly KnowledgeMcpPointerItem[];
  readonly omittedKnown: number;
  readonly diagnostics: readonly string[];
}

export interface KnowledgeMcpGetResult {
  readonly traceId: string;
  readonly tool: "ckl.get";
  readonly items: readonly KnowledgeMcpExpansionDelta[];
  readonly diagnostics: readonly string[];
}

export interface KnowledgeMcpCheckResult {
  readonly traceId: string;
  readonly tool: "ckl.check";
  readonly checks: readonly KnowledgeMcpCheck[];
}
