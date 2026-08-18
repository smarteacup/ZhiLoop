import type { ContextAuthority, KnowledgeAsset, KnowledgeKind, KnowledgeScope, KnowledgeStatus } from "@zhiloop/domain";

export interface ContextPrewarmInput {
  readonly sessionId: string;
  readonly projectId: string;
  readonly worktree: string;
  readonly branch: string;
  readonly knowledgeRegistryRevision: string;
  readonly retrievalPolicyHash: string;
  readonly injectionPolicyHash: string;
  readonly scopeHash: string;
  readonly observedAt: string;
}

export interface ContextPrewarmPolicy {
  readonly ttlMs: number;
  readonly maxItems: number;
  readonly maxTokens: number;
}

export interface StableContextPointer {
  readonly assetId: string;
  readonly assetVersion: number;
  readonly subjectKey: string;
  readonly kind: KnowledgeKind;
  readonly status: KnowledgeStatus;
  readonly scope: KnowledgeScope;
  readonly authority: ContextAuthority;
  readonly title: string;
  readonly summary: string;
  readonly estimatedTokens: number;
  readonly expansion: { readonly tool: "ckl.get"; readonly assetId: string; readonly version: number };
}

export interface StableContextCatalog {
  readonly schemaVersion: 1;
  readonly cacheKey: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly dependencyHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly estimatedTokens: number;
  readonly truncated: boolean;
  readonly items: readonly StableContextPointer[];
}

export interface ContextPrewarmResult {
  readonly source: "HIT" | "MISS";
  readonly catalog: StableContextCatalog;
}

export interface ContextPrewarmStorePort {
  get(cacheKey: string, now: string): StableContextCatalog | undefined;
  put(catalog: StableContextCatalog): "STORED" | "IDEMPOTENT";
  invalidateSession(sessionId: string): number;
}

export type ContextAssetLoader = () => readonly KnowledgeAsset[] | Promise<readonly KnowledgeAsset[]>;
