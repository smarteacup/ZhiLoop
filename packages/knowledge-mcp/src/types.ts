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

export interface KnowledgeMcpCompactItem {
  readonly id: string;
  readonly version: number;
  readonly subjectKey: string;
  readonly kind: KnowledgeAsset["kind"];
  readonly status: KnowledgeAsset["status"];
  readonly scope: KnowledgeScope;
  readonly authority: ContextAuthority;
  readonly detailLevel: "L2_COMPACT";
  readonly title: string;
  readonly summary: string;
  readonly applicability: readonly string[];
  readonly failurePaths: readonly string[];
  readonly symbols: readonly string[];
  readonly evidencePointers: readonly string[];
}

export interface KnowledgeMcpExpansionDelta {
  readonly id: string;
  readonly version: number;
  readonly fromDetailLevel: "L1_POINTER" | "L2_COMPACT";
  readonly toDetailLevel: "L3_EVIDENCED";
  readonly content: string;
  readonly evidenceSummary: readonly ContextEvidenceSummary[];
}

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
  readonly items: readonly KnowledgeMcpCompactItem[];
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
