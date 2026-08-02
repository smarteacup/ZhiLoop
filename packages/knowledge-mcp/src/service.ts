import type { ContextAuthority, KnowledgeAsset, KnowledgeScope } from "@zhiloop/domain";
import type { QueryContext } from "@zhiloop/query-context";

import type {
  KnownKnowledgeItem,
  KnowledgeMcpBackend,
  KnowledgeMcpCheckInput,
  KnowledgeMcpCheckResult,
  KnowledgeMcpCompactItem,
  KnowledgeMcpGetInput,
  KnowledgeMcpGetResult,
  KnowledgeMcpItemsResult,
  KnowledgeMcpRelatedInput,
  KnowledgeMcpSearchInput,
} from "./types.js";

const ELIGIBLE = new Set(["ACCEPTED", "IMPLEMENTED", "VERIFIED"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/u;

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function authority(asset: KnowledgeAsset): ContextAuthority {
  if (asset.kind === "RULE" || asset.kind === "REQUIREMENT") return "BINDING_RULE";
  if (asset.kind === "DECISION") return "ACCEPTED_DECISION";
  if (asset.kind === "FACT" && asset.status === "VERIFIED") return "VERIFIED_FACT";
  return "REFERENCE";
}

function scopeEligible(scope: KnowledgeScope, context: QueryContext): boolean {
  const boundary = context.retrievalBoundary;
  switch (scope.level) {
    case "GLOBAL": return boundary.allowGlobalKnowledge;
    case "PROJECT": case "MODULE": case "SYMBOL": return boundary.allowProjectKnowledge
      && boundary.projectId !== undefined && scope.projectId === boundary.projectId;
    case "TASK": return boundary.taskId !== undefined && scope.taskId === boundary.taskId
      && (scope.projectId === undefined || scope.projectId === boundary.projectId);
    case "USER": case "TEAM": return false;
  }
}

function eligible(asset: KnowledgeAsset, context: QueryContext): boolean {
  return ELIGIBLE.has(asset.status) && scopeEligible(asset.scope, context);
}

function compact(asset: KnowledgeAsset): KnowledgeMcpCompactItem {
  return {
    id: asset.id, version: asset.version, subjectKey: asset.subjectKey, kind: asset.kind,
    status: asset.status, scope: structuredClone(asset.scope), authority: authority(asset),
    detailLevel: "L2_COMPACT", title: asset.title, summary: asset.summary,
    applicability: [...asset.applicability], failurePaths: [...asset.nonApplicability],
    symbols: [...asset.symbols], evidencePointers: [...new Set(asset.evidence.map((item) => item.evidenceId))],
  };
}

function validateTraceId(value: string): void {
  if (!SAFE_ID.test(value)) throw new Error("backend traceId is invalid");
}

function validateKnown(items: readonly KnownKnowledgeItem[] | undefined): Set<string> {
  if (items === undefined) return new Set();
  if (items.length > 100 || items.some((item) => !SAFE_ID.test(item.id)
    || !Number.isSafeInteger(item.version) || item.version < 1
    || !(["L1_POINTER", "L2_COMPACT", "L3_EVIDENCED"] as const).includes(item.detailLevel))) {
    throw new Error("knownItems are invalid");
  }
  return new Set(items.map((item) => `${item.id}@${item.version}`));
}

function limit(value: number | undefined): number {
  const result = value ?? 8;
  if (!Number.isSafeInteger(result) || result < 1 || result > 8) throw new Error("limit must be within 1..8");
  return result;
}

function validateQuery(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 20_000 || /[\0]/u.test(value)) {
    throw new Error("query is invalid");
  }
}

function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("MCP request was aborted");
}

function currentMap(assets: readonly KnowledgeAsset[]): Map<string, KnowledgeAsset> {
  const map = new Map<string, KnowledgeAsset>();
  for (const asset of assets) {
    const existing = map.get(asset.id);
    if (existing !== undefined && (existing.version !== asset.version || existing.contentHash !== asset.contentHash)) {
      throw new Error(`backend returned conflicting current asset ${asset.id}`);
    }
    map.set(asset.id, asset);
  }
  return map;
}

export class KnowledgeMcpService {
  constructor(private readonly backend: KnowledgeMcpBackend) {}

  private async eligibleCurrent(
    assets: readonly KnowledgeAsset[],
    context: QueryContext,
    signal: AbortSignal,
  ): Promise<{ readonly assets: readonly KnowledgeAsset[]; readonly diagnostics: readonly string[] }> {
    const diagnostics: string[] = [];
    const ids = [...new Set(assets.map((asset) => asset.id))];
    if (ids.length === 0) return { assets: [], diagnostics };
    const current = await this.backend.current({ context, assetIds: ids, signal });
    validateTraceId(current.traceId);
    const currentById = currentMap(current.assets);
    const output: KnowledgeAsset[] = [];
    for (const asset of assets) {
      const verified = currentById.get(asset.id);
      if (verified === undefined || verified.version !== asset.version || verified.contentHash !== asset.contentHash) {
        diagnostics.push(`STALE_OR_NON_CURRENT:${asset.id}`);
      } else if (!eligible(verified, context)) {
        diagnostics.push(`INELIGIBLE:${asset.id}`);
      } else if (!output.some((item) => item.id === verified.id)) {
        output.push(verified);
      }
    }
    return { assets: output, diagnostics };
  }

  async search(
    input: KnowledgeMcpSearchInput,
    context: QueryContext,
    signal: AbortSignal,
  ): Promise<KnowledgeMcpItemsResult> {
    requireActive(signal);
    validateQuery(input.query);
    const maxItems = limit(input.limit);
    const known = validateKnown(input.knownItems);
    const result = await this.backend.search({ context, query: input.query.trim(), limit: maxItems, signal });
    validateTraceId(result.traceId);
    const checked = await this.eligibleCurrent(result.assets, context, signal);
    const unseen = checked.assets.filter((asset) => !known.has(`${asset.id}@${asset.version}`));
    return freeze({
      traceId: result.traceId, tool: "ckl.search", items: unseen.slice(0, maxItems).map(compact),
      omittedKnown: checked.assets.length - unseen.length,
      diagnostics: checked.diagnostics,
    });
  }

  async related(
    input: KnowledgeMcpRelatedInput,
    context: QueryContext,
    signal: AbortSignal,
  ): Promise<KnowledgeMcpItemsResult> {
    requireActive(signal);
    const maxItems = limit(input.limit);
    if (input.seedAssetIds.length < 1 || input.seedAssetIds.length > 20
      || new Set(input.seedAssetIds).size !== input.seedAssetIds.length
      || input.seedAssetIds.some((id) => !SAFE_ID.test(id))) throw new Error("seedAssetIds are invalid");
    const known = validateKnown(input.knownItems);
    const seeds = await this.backend.current({ context, assetIds: input.seedAssetIds, signal });
    validateTraceId(seeds.traceId);
    const seedById = currentMap(seeds.assets);
    if (!input.seedAssetIds.every((id) => {
      const asset = seedById.get(id);
      return asset !== undefined && eligible(asset, context);
    })) throw new Error("related seed is missing or outside QueryContext Scope");
    const result = await this.backend.related({ context, seedAssetIds: input.seedAssetIds, limit: maxItems, signal });
    validateTraceId(result.traceId);
    const checked = await this.eligibleCurrent(result.assets, context, signal);
    const seedSet = new Set(input.seedAssetIds);
    const unseen = checked.assets.filter((asset) => !seedSet.has(asset.id) && !known.has(`${asset.id}@${asset.version}`));
    return freeze({
      traceId: result.traceId, tool: "ckl.related", items: unseen.slice(0, maxItems).map(compact),
      omittedKnown: checked.assets.length - unseen.length,
      diagnostics: checked.diagnostics,
    });
  }

  async get(
    input: KnowledgeMcpGetInput,
    context: QueryContext,
    signal: AbortSignal,
  ): Promise<KnowledgeMcpGetResult> {
    requireActive(signal);
    if (!SAFE_ID.test(input.id) || !Number.isSafeInteger(input.version) || input.version < 1
      || !(["L1_POINTER", "L2_COMPACT"] as const).includes(input.fromDetailLevel)) {
      throw new Error("get input is invalid");
    }
    const result = await this.backend.current({ context, assetIds: [input.id], signal });
    validateTraceId(result.traceId);
    const asset = currentMap(result.assets).get(input.id);
    if (asset === undefined) return freeze({ traceId: result.traceId, tool: "ckl.get", items: [], diagnostics: ["NOT_FOUND"] });
    if (asset.version !== input.version) return freeze({ traceId: result.traceId, tool: "ckl.get", items: [], diagnostics: ["VERSION_MISMATCH"] });
    if (!eligible(asset, context)) return freeze({ traceId: result.traceId, tool: "ckl.get", items: [], diagnostics: ["INELIGIBLE"] });
    return freeze({
      traceId: result.traceId, tool: "ckl.get",
      items: [{
        id: asset.id, version: asset.version, fromDetailLevel: input.fromDetailLevel,
        toDetailLevel: "L3_EVIDENCED", content: asset.body,
        evidenceSummary: asset.evidence.map((item) => ({ ...item })),
      }],
      diagnostics: [],
    });
  }

  async check(
    input: KnowledgeMcpCheckInput,
    context: QueryContext,
    signal: AbortSignal,
  ): Promise<KnowledgeMcpCheckResult> {
    requireActive(signal);
    if (input.items.length < 1 || input.items.length > 100
      || new Set(input.items.map((item) => item.id)).size !== input.items.length
      || input.items.some((item) => !SAFE_ID.test(item.id)
        || (item.version !== undefined && (!Number.isSafeInteger(item.version) || item.version < 1)))) {
      throw new Error("check items are invalid");
    }
    const result = await this.backend.current({ context, assetIds: input.items.map((item) => item.id), signal });
    validateTraceId(result.traceId);
    const current = currentMap(result.assets);
    const checks = input.items.map((requested) => {
      const asset = current.get(requested.id);
      if (asset === undefined) return { id: requested.id, ...(requested.version === undefined ? {} : { requestedVersion: requested.version }), eligible: false, reasonCodes: ["NOT_FOUND"] };
      const reasons = [
        requested.version === undefined || requested.version === asset.version ? "CURRENT_VERSION" : "VERSION_MISMATCH",
        ELIGIBLE.has(asset.status) ? "STATUS_ELIGIBLE" : "STATUS_INELIGIBLE",
        scopeEligible(asset.scope, context) ? "SCOPE_MATCHED" : "SCOPE_MISMATCH",
      ];
      return {
        id: requested.id,
        ...(requested.version === undefined ? {} : { requestedVersion: requested.version }),
        currentVersion: asset.version,
        eligible: reasons.every((reason) => !reason.endsWith("MISMATCH") && reason !== "STATUS_INELIGIBLE"),
        reasonCodes: reasons,
      };
    });
    return freeze({ traceId: result.traceId, tool: "ckl.check", checks });
  }
}
