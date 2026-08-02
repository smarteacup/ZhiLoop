import type { ContextEnvelopeItem } from "@zhiloop/domain";

import { fingerprintRetrievalConfiguration } from "./fingerprint.js";
import type { RetrievalTrace, RetrievalTraceInput } from "./types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/u;

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate IDs`);
}

function complexityReasons(input: RetrievalTraceInput): string[] {
  return unique([
    `RISK_${input.signals?.risk ?? "UNSPECIFIED"}`,
    input.signals?.ambiguous === true ? "AMBIGUITY_PRESENT" : "AMBIGUITY_ABSENT",
    input.signals?.conflicting === true ? "CONFLICT_PRESENT" : "CONFLICT_ABSENT",
    input.envelope.budget.truncated ? "BUDGET_TRUNCATED" : "BUDGET_WITHIN_LIMIT",
    ...input.envelope.complexity.reasonCodes,
  ]);
}

export function buildRetrievalTrace(input: RetrievalTraceInput): RetrievalTrace {
  if (!SAFE_ID.test(input.traceId) || !SAFE_ID.test(input.runId)) throw new Error("traceId or runId is invalid");
  if (input.envelope.runId !== input.runId) throw new Error("ContextEnvelope runId does not match trace runId");
  if (input.envelope.projectId !== input.queryContext.project?.projectId
    || input.envelope.taskId !== input.queryContext.taskId) {
    throw new Error("ContextEnvelope query identity does not match QueryContext");
  }
  if (input.envelope.complexity.breadth !== input.envelope.items.length) {
    throw new Error("ContextEnvelope breadth does not match injected items");
  }

  const retrievalById = new Map(input.retrieval.items.map((item) => [item.asset.id, item]));
  requireUnique(input.retrieval.items.map((item) => item.asset.id), "retrieval");
  requireUnique(input.rerank.items.map((item) => item.asset.id), "rerank");
  requireUnique(input.envelope.items.map((item) => item.id), "injection");
  const finalRanks = input.rerank.items.map((item) => item.rank);
  if (new Set(finalRanks).size !== finalRanks.length
    || finalRanks.some((rank) => !Number.isSafeInteger(rank) || rank < 1 || rank > finalRanks.length)) {
    throw new Error("rerank final ranks are invalid");
  }
  const injectionById = new Map(input.envelope.items.map((item) => [item.id, item]));

  const results = input.rerank.items.map((item) => {
    const retrieved = retrievalById.get(item.asset.id);
    if (retrieved === undefined || retrieved.asset.version !== item.asset.version) {
      throw new Error(`rerank result ${item.asset.id} is not a current retrieval candidate`);
    }
    if (item.rerank.originalRank !== retrieved.rank) {
      throw new Error(`rerank original rank for ${item.asset.id} does not match retrieval rank`);
    }
    const injected = injectionById.get(item.asset.id);
    if (injected !== undefined && injected.version !== item.asset.version) {
      throw new Error(`injected version for ${item.asset.id} does not match rerank result`);
    }
    return {
      assetId: retrieved.asset.id,
      version: retrieved.asset.version,
      subjectKey: retrieved.asset.subjectKey,
      scope: structuredClone(retrieved.asset.scope),
      retrievalRank: item.rerank.originalRank,
      finalRank: item.rank,
      rrfScore: retrieved.score,
      contributions: structuredClone(retrieved.contributions),
      rerank: structuredClone(item.rerank),
      evidenceIds: unique(retrieved.asset.evidence.map((evidence) => evidence.evidenceId)),
      sourceEpisodes: unique(retrieved.asset.sourceEpisodes),
      injected: injected !== undefined,
      ...(injected === undefined ? {} : { detailLevel: injected.detailLevel }),
    };
  });

  const resultIds = new Set(results.map((item) => item.assetId));
  for (const item of input.envelope.items) {
    if (!resultIds.has(item.id)) throw new Error(`injected item ${item.id} is not a rerank result`);
  }

  const trace: RetrievalTrace = {
    schemaVersion: 1,
    traceId: input.traceId,
    runId: input.runId,
    query: {
      ...(input.queryContext.project === undefined ? {} : { projectId: input.queryContext.project.projectId }),
      ...(input.queryContext.taskId === undefined ? {} : { taskId: input.queryContext.taskId }),
      allowProjectKnowledge: input.queryContext.retrievalBoundary.allowProjectKnowledge,
      allowGlobalKnowledge: input.queryContext.retrievalBoundary.allowGlobalKnowledge,
      promptFingerprint: fingerprintRetrievalConfiguration(input.queryContext.prompt),
      reasonCodes: [...input.queryContext.reasonCodes],
    },
    filters: structuredClone(input.retrieval.diagnostics),
    rerankDiagnostics: structuredClone(input.rerank.diagnostics),
    results,
    injection: {
      items: input.envelope.items.map((item): Pick<ContextEnvelopeItem, "id" | "version" | "scope" | "authority" | "detailLevel"> => ({
        id: item.id, version: item.version, scope: structuredClone(item.scope),
        authority: item.authority, detailLevel: item.detailLevel,
      })),
    },
    complexity: {
      level: input.envelope.complexity.level,
      automatic: input.automatic ?? true,
      estimatedTokens: input.envelope.budget.estimatedTokens,
      maxTokens: input.envelope.budget.maxTokens,
      truncated: input.envelope.budget.truncated,
      reasonCodes: complexityReasons(input),
    },
  };
  return freeze(structuredClone(trace));
}
