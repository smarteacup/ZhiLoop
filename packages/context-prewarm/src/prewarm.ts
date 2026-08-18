import { createHash } from "node:crypto";

import type { ContextAuthority, KnowledgeAsset } from "@zhiloop/domain";

import type {
  ContextAssetLoader,
  ContextPrewarmInput,
  ContextPrewarmPolicy,
  ContextPrewarmResult,
  ContextPrewarmStorePort,
  StableContextCatalog,
  StableContextPointer,
} from "./types.js";

const SAFE_TEXT = /^[^\0\r\n]{1,4096}$/u;
const ELIGIBLE = new Set(["ACCEPTED", "IMPLEMENTED", "VERIFIED"]);

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function validateInput(input: ContextPrewarmInput): void {
  const values = [input.sessionId, input.projectId, input.worktree, input.branch, input.knowledgeRegistryRevision,
    input.retrievalPolicyHash, input.injectionPolicyHash, input.scopeHash];
  if (!values.every((value) => SAFE_TEXT.test(value)) || !Number.isFinite(Date.parse(input.observedAt))) {
    throw new Error("CONTEXT_PREWARM_INPUT_INVALID");
  }
}

function validatePolicy(policy: ContextPrewarmPolicy): void {
  if (!Number.isSafeInteger(policy.ttlMs) || policy.ttlMs < 1_000 || policy.ttlMs > 86_400_000
    || !Number.isSafeInteger(policy.maxItems) || policy.maxItems < 1 || policy.maxItems > 100
    || !Number.isSafeInteger(policy.maxTokens) || policy.maxTokens < 64 || policy.maxTokens > 4_000) {
    throw new Error("CONTEXT_PREWARM_POLICY_INVALID");
  }
}

function authority(asset: KnowledgeAsset): ContextAuthority {
  if (asset.kind === "RULE") return "BINDING_RULE";
  if (asset.status === "VERIFIED") return "VERIFIED_FACT";
  if (asset.kind === "DECISION" && asset.status === "ACCEPTED") return "ACCEPTED_DECISION";
  return "REFERENCE";
}

function visible(asset: KnowledgeAsset, projectId: string): boolean {
  if (!ELIGIBLE.has(asset.status)) return false;
  if (asset.scope.level === "GLOBAL") return true;
  if (asset.scope.level === "PROJECT" || asset.scope.level === "MODULE" || asset.scope.level === "SYMBOL") {
    return asset.scope.projectId === projectId;
  }
  return false;
}

function tokenEstimate(asset: KnowledgeAsset): number {
  return Math.max(12, Math.ceil((asset.title.length + asset.summary.length + asset.subjectKey.length + 48) / 4));
}

function pointer(asset: KnowledgeAsset): StableContextPointer {
  return Object.freeze({
    assetId: asset.id, assetVersion: asset.version, subjectKey: asset.subjectKey, kind: asset.kind,
    status: asset.status, scope: structuredClone(asset.scope), authority: authority(asset),
    title: asset.title, summary: asset.summary, estimatedTokens: tokenEstimate(asset),
    expansion: Object.freeze({ tool: "ckl.get" as const, assetId: asset.id, version: asset.version }),
  });
}

export function contextPrewarmIdentity(input: ContextPrewarmInput): { cacheKey: string; dependencyHash: string } {
  validateInput(input);
  const dependencyHash = digest({
    projectId: input.projectId,
    worktree: digest(input.worktree),
    branch: digest(input.branch),
    knowledgeRegistryRevision: input.knowledgeRegistryRevision,
    retrievalPolicyHash: input.retrievalPolicyHash,
    injectionPolicyHash: input.injectionPolicyHash,
    scopeHash: input.scopeHash,
  });
  return Object.freeze({ cacheKey: digest({ sessionId: input.sessionId, dependencyHash }), dependencyHash });
}

export function buildStableContextCatalog(
  input: ContextPrewarmInput,
  policy: ContextPrewarmPolicy,
  assets: readonly KnowledgeAsset[],
): StableContextCatalog {
  validateInput(input);
  validatePolicy(policy);
  if (assets.length > 100_000) throw new Error("CONTEXT_PREWARM_ASSET_LIMIT_EXCEEDED");
  const identity = contextPrewarmIdentity(input);
  const unique = new Map<string, KnowledgeAsset>();
  for (const asset of assets) if (visible(asset, input.projectId)) unique.set(`${asset.id}@${asset.version}`, asset);
  const ranked = [...unique.values()].map(pointer).sort((left, right) => {
    const priority = ["BINDING_RULE", "ACCEPTED_DECISION", "VERIFIED_FACT", "REFERENCE"];
    return priority.indexOf(left.authority) - priority.indexOf(right.authority)
      || left.subjectKey.localeCompare(right.subjectKey) || left.assetId.localeCompare(right.assetId);
  });
  const selected: StableContextPointer[] = [];
  let estimatedTokens = 0;
  for (const item of ranked) {
    if (selected.length >= policy.maxItems) break;
    if (estimatedTokens + item.estimatedTokens > policy.maxTokens) continue;
    selected.push(item);
    estimatedTokens += item.estimatedTokens;
  }
  const created = Date.parse(input.observedAt);
  return Object.freeze({
    schemaVersion: 1, cacheKey: identity.cacheKey, sessionId: input.sessionId, projectId: input.projectId,
    dependencyHash: identity.dependencyHash, createdAt: input.observedAt,
    expiresAt: new Date(created + policy.ttlMs).toISOString(), estimatedTokens,
    truncated: selected.length < ranked.length, items: Object.freeze(selected),
  });
}

export class ContextPrewarmService {
  constructor(private readonly store: ContextPrewarmStorePort, private readonly policy: ContextPrewarmPolicy) {
    validatePolicy(policy);
  }

  async prepare(input: ContextPrewarmInput, load: ContextAssetLoader): Promise<ContextPrewarmResult> {
    const identity = contextPrewarmIdentity(input);
    const cached = this.store.get(identity.cacheKey, input.observedAt);
    if (cached !== undefined) return Object.freeze({ source: "HIT", catalog: cached });
    const catalog = buildStableContextCatalog(input, this.policy, await load());
    try {
      this.store.put(catalog);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "CONTEXT_PREWARM_KEY_CONFLICT") throw error;
      const concurrent = this.store.get(identity.cacheKey, input.observedAt);
      if (concurrent === undefined) throw error;
      return Object.freeze({ source: "HIT", catalog: concurrent });
    }
    return Object.freeze({ source: "MISS", catalog });
  }

  refresh(sessionId: string): number {
    if (!SAFE_TEXT.test(sessionId)) throw new Error("CONTEXT_PREWARM_SESSION_INVALID");
    return this.store.invalidateSession(sessionId);
  }
}
