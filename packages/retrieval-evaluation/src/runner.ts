import type { ContextComplexityLevel, KnowledgeScope } from "@zhiloop/domain";

import { fingerprintRetrievalConfiguration } from "./fingerprint.js";
import type {
  ComplexityAudit,
  GoldenCaseResult,
  GoldenDataset,
  GoldenDatasetExecutor,
  GoldenDatasetReport,
  GoldenDatasetRunnerOptions,
  RetrievalTrace,
} from "./types.js";

const LEVELS: readonly ContextComplexityLevel[] = [
  "L0_NONE", "L1_POINTER", "L2_COMPACT", "L3_EVIDENCED", "L4_EPISODE",
];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/u;

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function finiteRatio(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be within [0,1]`);
  return value;
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\0\r\n]/gu, " ").slice(0, 500);
}

function scopeMatches(scope: KnowledgeScope, trace: RetrievalTrace): boolean {
  const projectId = trace.query.projectId;
  switch (scope.level) {
    case "GLOBAL": return trace.query.allowGlobalKnowledge;
    case "TASK": return trace.query.taskId !== undefined && scope.taskId === trace.query.taskId
      && (scope.projectId === undefined || scope.projectId === projectId);
    case "PROJECT": case "MODULE": case "SYMBOL": return trace.query.allowProjectKnowledge
      && projectId !== undefined && scope.projectId === projectId;
    case "USER": case "TEAM": return false;
  }
}

function isTraceable(trace: RetrievalTrace["results"][number]): boolean {
  return trace.contributions.length > 0 && trace.rerank.reasonCodes.length > 0
    && trace.sourceEpisodes.length > 0;
}

function complexityAudit(traces: readonly RetrievalTrace[]): ComplexityAudit {
  const levelCounts = Object.fromEntries(LEVELS.map((level) => [level, 0])) as Record<ContextComplexityLevel, number>;
  const tokens: number[] = [];
  let truncatedCount = 0;
  let overBudgetCount = 0;
  let automaticL4Count = 0;
  let missingReasonAxisCount = 0;
  for (const trace of traces) {
    levelCounts[trace.complexity.level] += 1;
    tokens.push(trace.complexity.estimatedTokens);
    if (trace.complexity.truncated) truncatedCount += 1;
    if (trace.complexity.estimatedTokens > trace.complexity.maxTokens) overBudgetCount += 1;
    if (trace.complexity.automatic && trace.complexity.level === "L4_EPISODE") automaticL4Count += 1;
    const reasons = trace.complexity.reasonCodes;
    if (!["RISK_", "AMBIGUITY_", "CONFLICT_", "BUDGET_"].every((prefix) => (
      reasons.some((reason) => reason.startsWith(prefix))
    ))) missingReasonAxisCount += 1;
  }
  tokens.sort((left, right) => left - right);
  const total = tokens.reduce((sum, value) => sum + value, 0);
  return {
    levelCounts,
    averageTokens: tokens.length === 0 ? 0 : total / tokens.length,
    p95Tokens: tokens.length === 0 ? 0 : tokens[Math.max(0, Math.ceil(tokens.length * 0.95) - 1)]!,
    maximumTokens: tokens.at(-1) ?? 0,
    truncatedCount,
    overBudgetCount,
    automaticL4Count,
    missingReasonAxisCount,
  };
}

function validateDataset(dataset: GoldenDataset, configFingerprint: string): void {
  if (dataset.schemaVersion !== 1 || !SAFE_ID.test(dataset.datasetId)
    || !Number.isSafeInteger(dataset.version) || dataset.version < 1
    || dataset.cases.length < 1 || dataset.cases.length > 10_000
    || !SAFE_ID.test(configFingerprint)) throw new Error("Golden Dataset metadata is invalid");
  const caseIds = dataset.cases.map((item) => item.caseId);
  if (new Set(caseIds).size !== caseIds.length || !caseIds.every((item) => SAFE_ID.test(item))) {
    throw new Error("Golden Dataset case IDs are invalid or duplicated");
  }
  for (const testCase of dataset.cases) {
    const forbidden = testCase.forbiddenAssetIds ?? [];
    if (testCase.expectedRelevantAssetIds.length < 1
      || new Set(testCase.expectedRelevantAssetIds).size !== testCase.expectedRelevantAssetIds.length
      || testCase.expectedRelevantAssetIds.some((item) => !SAFE_ID.test(item))
      || new Set(forbidden).size !== forbidden.length
      || forbidden.some((item) => !SAFE_ID.test(item) || testCase.expectedRelevantAssetIds.includes(item))
      || typeof testCase.query.prompt !== "string" || testCase.query.prompt.trim().length === 0) {
      throw new Error(`Golden Dataset case ${testCase.caseId} has invalid expectations`);
    }
  }
}

export class GoldenDatasetRunner {
  private readonly k: number;
  private readonly recallThreshold: number;
  private readonly precisionThreshold: number;

  constructor(private readonly executor: GoldenDatasetExecutor, options: GoldenDatasetRunnerOptions = {}) {
    this.k = options.k ?? 5;
    this.recallThreshold = finiteRatio(options.recallThreshold ?? 0.9, "recallThreshold");
    this.precisionThreshold = finiteRatio(options.precisionThreshold ?? 0.8, "precisionThreshold");
    if (!Number.isSafeInteger(this.k) || this.k < 1 || this.k > 100) throw new Error("k is invalid");
  }

  async run(dataset: GoldenDataset, algorithmConfiguration: unknown): Promise<GoldenDatasetReport> {
    const configFingerprint = fingerprintRetrievalConfiguration(algorithmConfiguration);
    validateDataset(dataset, configFingerprint);
    const cases: GoldenCaseResult[] = [];
    const traces: RetrievalTrace[] = [];
    let relevant = 0;
    let returned = 0;
    let hits = 0;
    let traceable = 0;
    let tracedResults = 0;
    let scopeLeakCount = 0;
    let forbiddenHitCount = 0;
    const traceIds = new Set<string>();

    for (const testCase of dataset.cases) {
      relevant += testCase.expectedRelevantAssetIds.length;
      try {
        const trace = await this.executor.execute(structuredClone(testCase));
        if (trace.query.promptFingerprint !== fingerprintRetrievalConfiguration(testCase.query.prompt)
          || trace.query.projectId !== testCase.query.project?.projectId
          || trace.query.taskId !== testCase.query.taskId) {
          throw new Error("executor returned a trace for a different Golden Dataset query");
        }
        if (traceIds.has(trace.traceId)) throw new Error(`executor returned duplicate traceId ${trace.traceId}`);
        traceIds.add(trace.traceId);
        traces.push(trace);
        const top = [...trace.results].sort((left, right) => left.finalRank - right.finalRank).slice(0, this.k);
        const topIds = top.map((item) => item.assetId);
        const expected = new Set(testCase.expectedRelevantAssetIds);
        const relevantHits = topIds.filter((item) => expected.has(item));
        const missing = testCase.expectedRelevantAssetIds.filter((item) => !topIds.includes(item));
        const forbidden = new Set(testCase.forbiddenAssetIds ?? []);
        const forbiddenHits = topIds.filter((item) => forbidden.has(item));
        returned += top.length;
        hits += relevantHits.length;
        forbiddenHitCount += forbiddenHits.length;
        tracedResults += top.length;
        traceable += top.filter(isTraceable).length;
        scopeLeakCount += trace.injection.items.filter((item) => !scopeMatches(item.scope, trace)).length;
        cases.push({
          caseId: testCase.caseId,
          status: missing.length === 0 && forbiddenHits.length === 0 ? "PASS" : "FAIL",
          traceId: trace.traceId,
          retrievedAssetIds: topIds,
          relevantHits,
          missingRelevantAssetIds: missing,
          forbiddenHits,
        });
      } catch (error) {
        cases.push({
          caseId: testCase.caseId,
          status: "ERROR",
          retrievedAssetIds: [], relevantHits: [],
          missingRelevantAssetIds: [...testCase.expectedRelevantAssetIds], forbiddenHits: [],
          error: safeError(error),
        });
      }
    }

    const recallAtK = relevant === 0 ? 0 : hits / relevant;
    const precisionAtK = returned === 0 ? 0 : hits / returned;
    const traceabilityRate = tracedResults === 0 ? 0 : traceable / tracedResults;
    const complexity = complexityAudit(traces);
    const errors = cases.filter((item) => item.status === "ERROR").length;
    const qualityThresholdsMet = recallAtK >= this.recallThreshold && precisionAtK >= this.precisionThreshold;
    const gatePassed = qualityThresholdsMet && errors === 0 && forbiddenHitCount === 0
      && traceabilityRate === 1 && scopeLeakCount === 0
      && complexity.overBudgetCount === 0 && complexity.automaticL4Count === 0
      && complexity.missingReasonAxisCount === 0;
    return freeze({
      schemaVersion: 1,
      datasetId: dataset.datasetId,
      datasetVersion: dataset.version,
      configFingerprint,
      k: this.k,
      totals: { cases: dataset.cases.length, errors, relevant, returned, hits, forbiddenHits: forbiddenHitCount },
      metrics: { recallAtK, precisionAtK, traceabilityRate, scopeLeakCount },
      thresholds: { recallAtK: this.recallThreshold, precisionAtK: this.precisionThreshold },
      complexity,
      qualityThresholdsMet,
      defaultInjectionAllowed: gatePassed,
      gatePassed,
      cases,
    } satisfies GoldenDatasetReport);
  }
}
