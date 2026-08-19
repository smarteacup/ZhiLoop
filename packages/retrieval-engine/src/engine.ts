import type { KnowledgeAsset, KnowledgeStatus } from "@zhiloop/domain";
import type { ProjectedKnowledgeAsset } from "@zhiloop/knowledge-registry";

import type {
  KnowledgeRetrievalSource,
  RetrievedKnowledge,
  RetrievalChannel,
  RetrievalChannelContribution,
  RetrievalDiagnostic,
  RetrievalEngineOptions,
  RetrievalRequest,
  RetrievalResult,
  RetrievalSourceHit,
  ScenarioDirectoryItem,
  VectorRetrievalDependencies,
} from "./types.js";

interface RankedHit extends RetrievalSourceHit {
  readonly channel: RetrievalChannel;
}

const ELIGIBLE_STATUSES = new Set<KnowledgeStatus>(["ACCEPTED", "IMPLEMENTED", "VERIFIED"]);
const MAX_VECTOR_QUERY_CHARS = 20_000;

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function errorMessage(error: unknown): string {
  const value = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return value.replace(/[\0\r\n]/gu, " ").slice(0, 500);
}

function scopeEligible(asset: KnowledgeAsset, request: RetrievalRequest): boolean {
  const boundary = request.context.retrievalBoundary;
  switch (asset.scope.level) {
    case "GLOBAL": return boundary.allowGlobalKnowledge;
    case "PROJECT":
    case "MODULE":
    case "SYMBOL": return boundary.allowProjectKnowledge && asset.scope.projectId === boundary.projectId;
    case "TASK": return boundary.taskId !== undefined && asset.scope.taskId === boundary.taskId
      && (asset.scope.projectId === undefined || asset.scope.projectId === boundary.projectId);
    case "USER":
    case "TEAM": return false;
  }
}

function locatorFilter(asset: KnowledgeAsset, request: RetrievalRequest): RetrievalDiagnostic["code"] | undefined {
  const context = request.context;
  const projectBound = asset.scope.level === "PROJECT" || asset.scope.level === "MODULE" || asset.scope.level === "SYMBOL"
    || (asset.scope.level === "TASK" && asset.scope.projectId !== undefined);
  if (asset.schemaVersion === 1 || asset.locator === undefined) {
    return context.commit !== undefined && projectBound && (asset.kind === "IMPLEMENTATION" || asset.kind === "FACT")
      ? "LOCATOR_LEGACY_FILTERED" : undefined;
  }
  const locator = asset.locator;
  if (context.project === undefined || locator.projectId !== context.project.projectId) return "LOCATOR_PROJECT_FILTERED";
  if (asset.claimMode === "CURRENT_STATE" && locator.observedRevision.dirty) return "DIRTY_REVISION_FILTERED";
  if (locator.branchApplicability.mode === "EXACT_BRANCH") {
    return context.branch === locator.branchApplicability.branch ? undefined : "BRANCH_FILTERED";
  }
  if (locator.branchApplicability.mode === "BRANCH_LINEAGE") {
    if (context.commit === undefined) return "COMMIT_FILTERED";
    return context.commit === locator.branchApplicability.baseCommit
      || context.commit === locator.observedRevision.commit ? undefined : "COMMIT_FILTERED";
  }
  return undefined;
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function scenarioDirectory(
  current: readonly ProjectedKnowledgeAsset[],
  request: RetrievalRequest,
): { readonly items: readonly ScenarioDirectoryItem[]; readonly selected: ReadonlySet<string> } {
  const signals = [
    request.context.prompt,
    ...request.context.taskIntents.map((item) => item.canonical),
    ...request.context.entryPoints.map((item) => item.canonical),
    ...request.context.paths.map((item) => item.canonical),
    ...request.context.symbols.map((item) => item.canonical),
  ].map(normalized).filter(Boolean);
  const grouped = new Map<string, { title: string; summary: string; taskIntents: Set<string>;
    entryPoints: Set<string>; knowledge: Set<string>; score: number }>();
  for (const projected of current) {
    const asset = projected.asset;
    if (projected.tombstone || !ELIGIBLE_STATUSES.has(asset.status) || !scopeEligible(asset, request)
      || locatorFilter(asset, request) !== undefined || asset.locator === undefined) continue;
    const locator = asset.locator;
    const values = [locator.scenarioTitle, locator.scenarioSummary, ...locator.taskIntents,
      ...locator.entryPoints, ...locator.symbols, ...locator.modulePaths].map(normalized).filter(Boolean);
    const score = signals.reduce((total, signal) => total + values.reduce((inner, value) =>
      inner + (value === signal ? 4 : value.includes(signal) || signal.includes(value) ? 1 : 0), 0), 0);
    const group = grouped.get(locator.scenarioId) ?? { title: locator.scenarioTitle,
      summary: locator.scenarioSummary, taskIntents: new Set<string>(), entryPoints: new Set<string>(),
      knowledge: new Set<string>(), score: 0 };
    locator.taskIntents.forEach((item) => group.taskIntents.add(item));
    locator.entryPoints.forEach((item) => group.entryPoints.add(item));
    group.knowledge.add(`${asset.id}@${asset.version}`);
    group.score = Math.max(group.score, score);
    grouped.set(locator.scenarioId, group);
  }
  const ranked = [...grouped.entries()].sort((left, right) => right[1].score - left[1].score
    || left[0].localeCompare(right[0])).slice(0, 20);
  const selected = new Set(ranked.filter((item) => item[1].score > 0).slice(0, 3).map(([id]) => id));
  return {
    selected,
    items: Object.freeze(ranked.map(([scenarioId, item]) => Object.freeze({ scenarioId, title: item.title,
      summary: item.summary, score: item.score, selected: selected.has(scenarioId),
      knowledgePointers: Object.freeze([...item.knowledge].sort()),
      taskIntents: Object.freeze([...item.taskIntents].sort()), entryPoints: Object.freeze([...item.entryPoints].sort()) }))),
  };
}

function eligibility(
  hit: RetrievalSourceHit,
  channel: RetrievalChannel,
  request: RetrievalRequest,
  diagnostics: RetrievalDiagnostic[],
  selectedScenarios: ReadonlySet<string>,
): boolean {
  const asset = hit.asset;
  if (asset.tombstone) {
    diagnostics.push({ code: "TOMBSTONE_FILTERED", channel, assetId: asset.asset.id, message: "tombstone is never retrievable" });
    return false;
  }
  if (!(request.policy.eligibility.default as readonly KnowledgeStatus[]).includes(asset.asset.status)) {
    diagnostics.push({ code: "STATUS_FILTERED", channel, assetId: asset.asset.id, message: `status ${asset.asset.status} is not eligible` });
    return false;
  }
  if (!scopeEligible(asset.asset, request)) {
    diagnostics.push({ code: "SCOPE_FILTERED", channel, assetId: asset.asset.id, message: `scope ${asset.asset.scope.level} is outside QueryContext boundary` });
    return false;
  }
  const locatorReason = locatorFilter(asset.asset, request);
  if (locatorReason !== undefined) {
    diagnostics.push({ code: locatorReason, channel, assetId: asset.asset.id,
      message: `locator rejected ${asset.asset.id}: ${locatorReason}` });
    return false;
  }
  if (selectedScenarios.size > 0 && asset.asset.locator !== undefined
    && !selectedScenarios.has(asset.asset.locator.scenarioId)) {
    diagnostics.push({ code: "SCENARIO_FILTERED", channel, assetId: asset.asset.id,
      message: `scenario ${asset.asset.locator.scenarioId} was not selected` });
    return false;
  }
  return true;
}

function rankEligible(
  hits: readonly RetrievalSourceHit[],
  channel: RetrievalChannel,
  request: RetrievalRequest,
  diagnostics: RetrievalDiagnostic[],
  limit: number,
  selectedScenarios: ReadonlySet<string>,
): RankedHit[] {
  const seen = new Set<string>();
  const eligible: RetrievalSourceHit[] = [];
  for (const hit of [...hits].sort((left, right) => left.rank - right.rank || left.asset.asset.id.localeCompare(right.asset.asset.id))) {
    if (!Number.isSafeInteger(hit.rank) || hit.rank < 1 || !Number.isFinite(hit.rawScore)
      || hit.reason.length === 0 || hit.reason.length > 1_000 || /[\0\r\n]/u.test(hit.reason)) {
      throw new Error(`${channel} source returned an invalid ranked hit`);
    }
    if (seen.has(hit.asset.asset.id) || !eligibility(hit, channel, request, diagnostics, selectedScenarios)) continue;
    seen.add(hit.asset.asset.id);
    eligible.push(hit);
    if (eligible.length >= limit) break;
  }
  return eligible.map((hit, index) => ({ ...hit, rank: index + 1, channel }));
}

async function currentHits(
  hits: readonly RetrievalSourceHit[],
  channel: RetrievalChannel,
  source: KnowledgeRetrievalSource,
  diagnostics: RetrievalDiagnostic[],
): Promise<RetrievalSourceHit[]> {
  const current: RetrievalSourceHit[] = [];
  for (const hit of hits) {
    const active = await source.getCurrent(hit.asset.asset.id);
    if (active === undefined || active.asset.version !== hit.asset.asset.version
      || active.asset.contentHash !== hit.asset.asset.contentHash) {
      diagnostics.push({
        code: "STALE_SOURCE_HIT", channel, assetId: hit.asset.asset.id,
        message: "channel hit is not the current asset version",
      });
      continue;
    }
    current.push({ ...hit, asset: active });
  }
  return current;
}

function exactHits(current: readonly ProjectedKnowledgeAsset[], request: RetrievalRequest): RetrievalSourceHit[] {
  const terms = [...request.context.paths, ...request.context.symbols, ...request.context.errorCodes, ...request.context.configKeys]
    .map((term) => term.canonical);
  if (terms.length === 0) return [];
  return current.flatMap((item) => {
    const values = [
      item.asset.id, item.asset.subjectKey, ...item.asset.aliases, ...item.asset.keywords,
      ...item.asset.symbols, ...item.asset.applicability,
    ].map((value) => value.normalize("NFKC"));
    const matched = [...new Set(terms.filter((term) => values.includes(term)))];
    return matched.length === 0 ? [] : [{
      asset: item,
      rank: 0,
      rawScore: matched.length,
      reason: `exact: ${matched.join(", ")}`,
    }];
  }).sort((left, right) => right.rawScore - left.rawScore || left.asset.asset.id.localeCompare(right.asset.asset.id))
    .map((hit, index) => ({ ...hit, rank: index + 1 }));
}

function ftsQueries(request: RetrievalRequest): readonly string[] {
  const exact = [...request.context.errorCodes, ...request.context.configKeys, ...request.context.symbols, ...request.context.paths]
    .map((term) => term.canonical);
  const prompt = request.context.prompt.trim();
  return [...new Set([...exact, ...(prompt.length <= 2_000 ? [prompt] : [])])].slice(0, 30);
}

function fuse(hits: readonly RankedHit[], rrfK: number, limit: number): RetrievedKnowledge[] {
  const combined = new Map<string, {
    asset: KnowledgeAsset;
    score: number;
    contributions: RetrievalChannelContribution[];
  }>();
  for (const hit of hits) {
    const contribution = 1 / (rrfK + hit.rank);
    const existing = combined.get(hit.asset.asset.id) ?? { asset: hit.asset.asset, score: 0, contributions: [] };
    existing.score += contribution;
    existing.contributions.push({ channel: hit.channel, rank: hit.rank, contribution, reason: hit.reason });
    combined.set(hit.asset.asset.id, existing);
  }
  return [...combined.values()]
    .sort((left, right) => right.score - left.score || left.asset.id.localeCompare(right.asset.id))
    .slice(0, limit)
    .map((item, index) => ({
      asset: item.asset,
      rank: index + 1,
      score: item.score,
      scopeMatched: true,
      contributions: item.contributions.sort((left, right) => left.channel.localeCompare(right.channel)),
    }));
}

function applyFeedback(items: readonly RetrievedKnowledge[], request: RetrievalRequest): RetrievedKnowledge[] {
  if (request.feedback === undefined) return [...items];
  const expectedScopeKey = request.context.taskId !== undefined
    ? JSON.stringify({ level: "TASK", ...(request.context.project === undefined ? {} : { projectId: request.context.project.projectId }), taskId: request.context.taskId })
    : request.context.project === undefined
      ? JSON.stringify({ level: "GLOBAL" })
      : JSON.stringify({ level: "PROJECT", projectId: request.context.project.projectId });
  if (request.feedback.scopeKey !== expectedScopeKey
    || request.feedback.assets.length > 10_000
    || new Set(request.feedback.assets.map((item) => item.assetId)).size !== request.feedback.assets.length
    || request.feedback.assets.some((item) => item.assetId.trim().length === 0 || item.assetId.length > 500
      || !Number.isSafeInteger(item.relevant) || item.relevant < 0 || item.relevant > 1_000_000
      || !Number.isSafeInteger(item.irrelevant) || item.irrelevant < 0 || item.irrelevant > 1_000_000
      || item.score !== item.relevant - item.irrelevant || (item.pinned && item.suppressed))) {
    throw new Error("retrieval feedback profile is invalid");
  }
  const feedback = new Map(request.feedback.assets.map((item) => [item.assetId, item]));
  return items.filter((item) => feedback.get(item.asset.id)?.suppressed !== true)
    .sort((left, right) => {
      const leftFeedback = feedback.get(left.asset.id);
      const rightFeedback = feedback.get(right.asset.id);
      return Number(rightFeedback?.pinned === true) - Number(leftFeedback?.pinned === true)
        || (rightFeedback?.score ?? 0) - (leftFeedback?.score ?? 0)
        || left.rank - right.rank || (left.asset.id < right.asset.id ? -1 : left.asset.id > right.asset.id ? 1 : 0);
    }).map((item, index) => ({ ...item, rank: index + 1 }));
}

export class MultiChannelRetrievalEngine {
  readonly #source: KnowledgeRetrievalSource;
  readonly #vector: VectorRetrievalDependencies | undefined;
  readonly #channels: Required<NonNullable<RetrievalEngineOptions["channels"]>>;

  constructor(
    source: KnowledgeRetrievalSource,
    vector?: VectorRetrievalDependencies,
    options: RetrievalEngineOptions = {},
  ) {
    this.#source = source;
    this.#vector = vector;
    this.#channels = {
      exact: options.channels?.exact ?? true,
      fts: options.channels?.fts ?? true,
      vector: options.channels?.vector ?? true,
      relation: options.channels?.relation ?? true,
    };
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    const topK = Object.values(request.policy.topK);
    if (request.policy.fusion.algorithm !== "rrf" || !Number.isSafeInteger(request.policy.fusion.rrfK)
      || request.policy.fusion.rrfK < 1 || !Number.isSafeInteger(request.policy.rerank.candidates)
      || request.policy.rerank.candidates < 1 || request.policy.rerank.candidates > 100
      || topK.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 100)
      || request.policy.eligibility.default.length === 0
      || !request.policy.eligibility.default.every((status) => ELIGIBLE_STATUSES.has(status))) {
      throw new Error("retrieval policy is invalid");
    }
    const boundary = request.context.retrievalBoundary;
    if (request.context.schemaVersion !== 1
      || (boundary.allowProjectKnowledge && (
        request.context.project === undefined || boundary.projectId !== request.context.project.projectId
      ))
      || (boundary.allowGlobalKnowledge && request.context.project === undefined)
      || (boundary.projectId !== undefined && boundary.projectId !== request.context.project?.projectId)
      || boundary.taskId !== request.context.taskId) {
      throw new Error("QueryContext retrieval boundary is inconsistent");
    }
    const diagnostics: RetrievalDiagnostic[] = [];
    const allHits: RankedHit[] = [];
    let directorySource: readonly ProjectedKnowledgeAsset[] = [];
    try {
      directorySource = await this.#source.listCurrent();
    } catch (error) {
      diagnostics.push({ code: "CHANNEL_FAILED", channel: "EXACT", message: errorMessage(error) });
    }
    const directory = scenarioDirectory(directorySource, request);

    if (this.#channels.exact && request.policy.topK.exact > 0) {
      try {
        const current = directorySource;
        const hits = await currentHits(exactHits(current, request), "EXACT", this.#source, diagnostics);
        allHits.push(...rankEligible(hits, "EXACT", request, diagnostics, request.policy.topK.exact, directory.selected));
      } catch (error) {
        diagnostics.push({ code: "CHANNEL_FAILED", channel: "EXACT", message: errorMessage(error) });
      }
    } else diagnostics.push({ code: "CHANNEL_DISABLED", channel: "EXACT", message: "Exact channel is disabled" });

    if (this.#channels.fts && request.policy.topK.fts > 0) {
      try {
        const merged = new Map<string, RetrievalSourceHit>();
        let queryOffset = 0;
        for (const query of ftsQueries(request)) {
          const results = await this.#source.searchFts(query, request.policy.topK.fts);
          for (const hit of results) {
            const rank = queryOffset + hit.rank;
            const existing = merged.get(hit.asset.asset.id);
            if (existing === undefined || rank < existing.rank) merged.set(hit.asset.asset.id, { ...hit, rank });
          }
          queryOffset += request.policy.topK.fts;
        }
        const hits = await currentHits([...merged.values()], "FTS", this.#source, diagnostics);
        allHits.push(...rankEligible(hits, "FTS", request, diagnostics, request.policy.topK.fts, directory.selected));
      } catch (error) {
        diagnostics.push({ code: "CHANNEL_FAILED", channel: "FTS", message: errorMessage(error) });
      }
    } else diagnostics.push({ code: "CHANNEL_DISABLED", channel: "FTS", message: "FTS channel is disabled" });

    if (this.#channels.vector && request.policy.topK.vector > 0 && this.#vector?.index.enabled === true) {
      try {
        if (this.#vector.index.embeddingVersion !== undefined && this.#vector.index.embeddingVersion !== this.#vector.embedding.version) {
          diagnostics.push({ code: "VECTOR_VERSION_MISMATCH", channel: "VECTOR", message: "query and index embedding versions differ" });
        } else {
          if (request.context.prompt.length > MAX_VECTOR_QUERY_CHARS) throw new Error("vector query exceeds 20000 characters");
          const vectors = await this.#vector.embedding.embed([request.context.prompt]);
          if (vectors.length !== 1) throw new Error("query embedding output count must equal one");
          const chunks = await this.#vector.index.search(vectors[0] as readonly number[], request.policy.topK.vector);
          const vectorHits: RetrievalSourceHit[] = [];
          const seen = new Set<string>();
          for (const chunk of chunks) {
            if (seen.has(chunk.chunk.assetId)) continue;
            const asset = await this.#source.getCurrent(chunk.chunk.assetId);
            if (asset === undefined || asset.asset.version !== chunk.chunk.assetVersion || asset.asset.contentHash !== chunk.chunk.assetContentHash) {
              diagnostics.push({ code: "STALE_VECTOR_CHUNK", channel: "VECTOR", assetId: chunk.chunk.assetId, message: "vector chunk is not the current asset version" });
              continue;
            }
            seen.add(asset.asset.id);
            vectorHits.push({ asset, rank: chunk.rank, rawScore: chunk.score, reason: `vector rank ${chunk.rank}` });
          }
          allHits.push(...rankEligible(vectorHits, "VECTOR", request, diagnostics, request.policy.topK.vector, directory.selected));
        }
      } catch (error) {
        diagnostics.push({ code: "CHANNEL_FAILED", channel: "VECTOR", message: errorMessage(error) });
      }
    } else diagnostics.push({ code: "CHANNEL_DISABLED", channel: "VECTOR", message: "Vector channel is disabled or unavailable" });

    if (this.#channels.relation && request.policy.topK.relation > 0) {
      try {
        const seeds = fuse(allHits, request.policy.fusion.rrfK, request.policy.rerank.candidates).map((item) => item.asset.id);
        const related = seeds.length === 0 ? [] : await this.#source.related(seeds, request.policy.topK.relation);
        const hits = await currentHits(related, "RELATION", this.#source, diagnostics);
        allHits.push(...rankEligible(hits, "RELATION", request, diagnostics, request.policy.topK.relation, directory.selected));
      } catch (error) {
        diagnostics.push({ code: "CHANNEL_FAILED", channel: "RELATION", message: errorMessage(error) });
      }
    } else diagnostics.push({ code: "CHANNEL_DISABLED", channel: "RELATION", message: "Relation channel is disabled" });

    return freeze({
      items: applyFeedback(fuse(allHits, request.policy.fusion.rrfK, request.policy.rerank.candidates), request),
      diagnostics,
      scenarioDirectory: directory.items,
    });
  }
}
