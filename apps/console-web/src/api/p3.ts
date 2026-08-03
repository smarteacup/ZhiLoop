export interface RetrievalPolicyRefView {
  readonly policyId: string;
  readonly revision: number;
  readonly fingerprint: string;
  readonly source: "CURRENT" | "DRAFT" | "REPLAY";
}

export interface RetrievalResultView {
  readonly knowledgeId: string;
  readonly version: number;
  readonly title: string;
  readonly summary: string;
  readonly scope: string;
  readonly status: string;
  readonly retrievalRank: number;
  readonly finalRank: number;
  readonly rrfScore: number;
  readonly contributions: readonly {
    readonly channel: "EXACT" | "FTS" | "VECTOR" | "RELATION";
    readonly rank: number;
    readonly reason: string;
  }[];
  readonly evidenceIds: readonly string[];
  readonly injected: false;
}

export interface RetrievalTraceView {
  readonly traceId: string;
  readonly outcome: "SUCCEEDED" | "PARTIAL" | "NO_CONTEXT" | "TIMEOUT" | "ERROR";
  readonly injectionResult: "SHADOWED" | "NO_CONTEXT" | "TIMEOUT" | "ERROR";
  readonly reasonCodes: readonly string[];
  readonly results: readonly RetrievalResultView[];
  readonly filters: readonly { readonly decision: string; readonly reasonCode: string; readonly safeMessage: string }[];
  readonly envelope: {
    readonly detailLevel: "L0_NONE" | "L1_POINTER" | "L2_COMPACT" | "L3_EVIDENCED";
    readonly maxTokens: number;
    readonly estimatedTokens: number;
    readonly truncated: boolean;
    readonly omitted: readonly { readonly knowledgeId: string; readonly version: number; readonly reason: string }[];
  };
}

export interface KnowledgeSearchCommand {
  readonly requestId: string;
  readonly query: string;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly repositoryRoot?: string;
  readonly cwd?: string;
  readonly hints?: {
    readonly paths?: readonly string[];
    readonly symbols?: readonly string[];
    readonly errorCodes?: readonly string[];
    readonly configKeys?: readonly string[];
  };
  readonly maxResults: number;
  readonly maxContextTokens: number;
}

export interface KnowledgeAskView {
  readonly outcome: "SUCCEEDED" | "FALLBACK_SEARCH" | "CANCELLED" | "FAILED";
  readonly answer: string;
  readonly citations: readonly { readonly knowledgeId: string; readonly version: number; readonly answerSpans: readonly { readonly start: number; readonly end: number }[] }[];
  readonly unknowns: readonly string[];
  readonly conflicts: readonly { readonly summary: string; readonly knowledgeVersions: readonly { readonly knowledgeId: string; readonly version: number }[] }[];
  readonly retrieval: RetrievalTraceView;
  readonly latencyMs: number;
}

export interface RetrievalSimulationView {
  readonly current: RetrievalTraceView;
  readonly draft?: RetrievalTraceView;
  readonly comparison?: {
    readonly selectedOnlyByCurrent: readonly string[];
    readonly selectedOnlyByDraft: readonly string[];
    readonly tokenDelta: number;
  };
}

export function toRetrievalTraceView(value: RetrievalTraceContract): RetrievalTraceView {
  if (value.injectionResult === "INJECTED") throw new Error("P3 retrieval trace cannot contain an actual injection");
  return Object.freeze({
    traceId: value.traceId,
    outcome: value.outcome,
    injectionResult: value.injectionResult,
    reasonCodes: Object.freeze([...new Set([...value.queryContext.reasonCodes, ...value.envelope.reasonCodes])]),
    results: Object.freeze(value.results.map((item) => Object.freeze({
      knowledgeId: item.knowledgeId,
      version: item.version,
      title: item.title,
      summary: item.summary,
      scope: item.scope,
      status: item.status,
      retrievalRank: item.retrievalRank,
      finalRank: item.finalRank,
      rrfScore: item.rrfScore,
      contributions: Object.freeze(item.contributions.map((entry) => Object.freeze({
        channel: entry.channel,
        rank: entry.rank,
        reason: entry.reason,
      }))),
      evidenceIds: Object.freeze([...item.evidenceIds]),
      injected: false as const,
    }))),
    filters: Object.freeze(value.filters.map((item) => Object.freeze({
      decision: item.decision,
      reasonCode: item.reasonCode,
      safeMessage: item.safeMessage,
    }))),
    envelope: Object.freeze({
      detailLevel: value.envelope.detailLevel,
      maxTokens: value.envelope.maxTokens,
      estimatedTokens: value.envelope.estimatedTokens,
      truncated: value.envelope.truncated,
      omitted: Object.freeze(value.envelope.omitted.map((item) => Object.freeze({ ...item }))),
    }),
  });
}
import {
  codexKnowledgeAnswerSchema,
  retrievalTraceSchema,
  type RetrievalTraceContract,
} from "@zhiloop/control-api";
import { z } from "zod";

const safeId = z.string().min(3).max(500).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u);
const boundedText = z.string().min(1).max(1_000).refine((value) => !value.includes("\0"));

export const p3ConsoleSearchResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("SEARCH"),
  trace: retrievalTraceSchema,
});

const policyComparisonSchema = z.strictObject({
  currentTraceId: safeId,
  draftTraceId: safeId,
  selectedOnlyByCurrent: z.array(boundedText).max(100),
  selectedOnlyByDraft: z.array(boundedText).max(100),
  currentEstimatedTokens: z.number().int().nonnegative(),
  draftEstimatedTokens: z.number().int().nonnegative(),
  tokenDelta: z.number().int(),
  currentTruncated: z.boolean(),
  draftTruncated: z.boolean(),
});

export const p3ConsoleSimulationResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("SIMULATION"),
  current: retrievalTraceSchema,
  draft: retrievalTraceSchema.optional(),
  comparison: policyComparisonSchema.optional(),
}).superRefine((value, context) => {
  if ((value.draft === undefined) !== (value.comparison === undefined)) {
    context.addIssue({ code: "custom", path: ["comparison"], message: "draft and comparison must be present together" });
  }
});

export const p3ConsoleAskResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("ASK"),
  trace: retrievalTraceSchema,
  answer: codexKnowledgeAnswerSchema,
});
