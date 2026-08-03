import { z } from "zod";

import { CONTROL_API_SCHEMA_VERSION } from "./constants.js";
import { requestIdSchema } from "./schemas.js";

const boundedText = (maximum: number) => z.string().min(1).max(maximum).refine(
  (value) => !value.includes("\0"),
  { message: "text cannot contain NUL" },
);
const safeIdSchema = z.string().min(3).max(500).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const positiveRevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const canonicalTimestampSchema = z.string().min(20).max(40).refine(
  (value) => {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
  },
  { message: "expected a canonical ISO timestamp" },
);

export const RETRIEVAL_CHANNELS = ["EXACT", "FTS", "VECTOR", "RELATION"] as const;
export const RETRIEVAL_RUN_OUTCOMES = ["SUCCEEDED", "PARTIAL", "NO_CONTEXT", "TIMEOUT", "ERROR"] as const;
export const INJECTION_ATTEMPT_RESULTS = ["SHADOWED", "INJECTED", "NO_CONTEXT", "TIMEOUT", "ERROR"] as const;
export const KNOWLEDGE_QUERY_MODES = ["SEARCH_ONLY", "CODEX_ASSISTED"] as const;
export const CODEX_QUERY_OUTCOMES = ["SUCCEEDED", "FALLBACK_SEARCH", "CANCELLED", "FAILED"] as const;
export const RETRIEVAL_OMISSION_REASONS = [
  "SCOPE_FILTERED",
  "STATUS_FILTERED",
  "SUPPRESSED",
  "STALE_VERSION",
  "DUPLICATE_SUBJECT",
  "LOW_AUTHORITY",
  "TOKEN_BUDGET",
  "CHANNEL_TIMEOUT",
  "POLICY_FILTERED",
] as const;

export const retrievalQueryContextSchema = z.strictObject({
  prompt: boundedText(20_000),
  promptFingerprint: sha256Schema,
  projectId: safeIdSchema.optional(),
  taskId: safeIdSchema.optional(),
  repositoryRoot: z.string().min(1).max(4_096).optional(),
  paths: z.array(boundedText(4_096)).max(100),
  symbols: z.array(boundedText(500)).max(100),
  errorCodes: z.array(boundedText(500)).max(100),
  configKeys: z.array(boundedText(500)).max(100),
  allowProjectKnowledge: z.boolean(),
  allowGlobalKnowledge: z.boolean(),
  reasonCodes: z.array(z.string().min(1).max(100).regex(/^[A-Z][A-Z0-9_]*$/u)).max(100),
}).superRefine((value, context) => {
  if (value.allowProjectKnowledge && value.projectId === undefined) {
    context.addIssue({ code: "custom", path: ["projectId"], message: "project knowledge requires project identity" });
  }
  if (value.allowGlobalKnowledge && value.projectId === undefined) {
    context.addIssue({ code: "custom", path: ["projectId"], message: "global knowledge requires an anchored project query" });
  }
  for (const field of ["paths", "symbols", "errorCodes", "configKeys", "reasonCodes"] as const) {
    if (new Set(value[field]).size !== value[field].length) {
      context.addIssue({ code: "custom", path: [field], message: `${field} must be unique` });
    }
  }
});

export const retrievalPolicyReferenceSchema = z.strictObject({
  policyId: safeIdSchema,
  revision: positiveRevisionSchema,
  fingerprint: sha256Schema,
  source: z.enum(["CURRENT", "DRAFT", "REPLAY"]),
});

export const naturalLanguageSearchRequestSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  requestId: requestIdSchema,
  type: z.literal("knowledge.search"),
  mode: z.enum(KNOWLEDGE_QUERY_MODES),
  query: boundedText(20_000),
  projectId: safeIdSchema.optional(),
  taskId: safeIdSchema.optional(),
  policy: retrievalPolicyReferenceSchema,
  maxResults: z.number().int().min(1).max(100),
  maxContextTokens: z.number().int().min(64).max(128_000),
  timeoutMs: z.number().int().min(1).max(120_000),
});

export const retrievalContributionSchema = z.strictObject({
  channel: z.enum(RETRIEVAL_CHANNELS),
  rank: positiveRevisionSchema,
  rawScore: z.number().finite(),
  contribution: z.number().finite().nonnegative(),
  reason: boundedText(1_000),
});

export const retrievalFilterDecisionSchema = z.strictObject({
  assetId: safeIdSchema.optional(),
  channel: z.enum(RETRIEVAL_CHANNELS).optional(),
  decision: z.enum(["INCLUDED", "EXCLUDED", "DEGRADED"]),
  reasonCode: z.string().min(1).max(100).regex(/^[A-Z][A-Z0-9_]*$/u),
  safeMessage: boundedText(500),
});

export const retrievalResultItemSchema = z.strictObject({
  knowledgeId: safeIdSchema,
  version: positiveRevisionSchema,
  title: boundedText(300),
  summary: boundedText(2_000),
  scope: z.enum(["TASK", "SYMBOL", "MODULE", "PROJECT", "GLOBAL"]),
  status: z.enum(["ACCEPTED", "IMPLEMENTED", "VERIFIED"]),
  authority: z.enum(["ADVISORY", "INFORMATIVE", "NORMATIVE"]),
  evidenceIds: z.array(safeIdSchema).max(500),
  sourceEpisodeIds: z.array(safeIdSchema).min(1).max(500),
  retrievalRank: positiveRevisionSchema,
  finalRank: positiveRevisionSchema,
  rrfScore: z.number().finite().nonnegative(),
  contributions: z.array(retrievalContributionSchema).min(1).max(RETRIEVAL_CHANNELS.length),
  rerankReasonCodes: z.array(z.string().min(1).max(100).regex(/^[A-Z][A-Z0-9_]*$/u)).min(1).max(20),
}).superRefine((value, context) => {
  for (const field of ["evidenceIds", "sourceEpisodeIds", "rerankReasonCodes"] as const) {
    if (new Set(value[field]).size !== value[field].length) {
      context.addIssue({ code: "custom", path: [field], message: `${field} must be unique` });
    }
  }
  const channels = value.contributions.map((item) => item.channel);
  if (new Set(channels).size !== channels.length) {
    context.addIssue({ code: "custom", path: ["contributions"], message: "channel contributions must be unique" });
  }
});

export const contextEnvelopeSimulationSchema = z.strictObject({
  detailLevel: z.enum(["L0_NONE", "L1_POINTER", "L2_COMPACT", "L3_EVIDENCED"]),
  maxTokens: z.number().int().nonnegative().max(128_000),
  estimatedTokens: z.number().int().nonnegative().max(128_000),
  truncated: z.boolean(),
  selected: z.array(z.strictObject({
    knowledgeId: safeIdSchema,
    version: positiveRevisionSchema,
    estimatedTokens: nonnegativeSafeIntegerSchema,
  })).max(100),
  omitted: z.array(z.strictObject({
    knowledgeId: safeIdSchema,
    version: positiveRevisionSchema,
    reason: z.enum(RETRIEVAL_OMISSION_REASONS),
  })).max(1_000),
  reasonCodes: z.array(z.string().min(1).max(100).regex(/^[A-Z][A-Z0-9_]*$/u)).min(4).max(100),
}).superRefine((value, context) => {
  if (value.estimatedTokens > value.maxTokens) {
    context.addIssue({ code: "custom", path: ["estimatedTokens"], message: "context envelope exceeds token budget" });
  }
  const selectedKeys = value.selected.map((item) => `${item.knowledgeId}@${item.version}`);
  const omittedKeys = value.omitted.map((item) => `${item.knowledgeId}@${item.version}`);
  if (new Set(selectedKeys).size !== selectedKeys.length || new Set(omittedKeys).size !== omittedKeys.length) {
    context.addIssue({ code: "custom", path: ["selected"], message: "envelope entries must be unique" });
  }
  if (selectedKeys.some((key) => omittedKeys.includes(key))) {
    context.addIssue({ code: "custom", path: ["omitted"], message: "an item cannot be selected and omitted" });
  }
  for (const prefix of ["RISK_", "AMBIGUITY_", "CONFLICT_", "BUDGET_"]) {
    if (!value.reasonCodes.some((reason) => reason.startsWith(prefix))) {
      context.addIssue({ code: "custom", path: ["reasonCodes"], message: `missing ${prefix} explanation` });
    }
  }
});

export const retrievalTraceSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  traceId: safeIdSchema,
  runId: safeIdSchema,
  replayOfTraceId: safeIdSchema.optional(),
  queryContext: retrievalQueryContextSchema,
  policy: retrievalPolicyReferenceSchema,
  outcome: z.enum(RETRIEVAL_RUN_OUTCOMES),
  filters: z.array(retrievalFilterDecisionSchema).max(5_000),
  results: z.array(retrievalResultItemSchema).max(100),
  envelope: contextEnvelopeSimulationSchema,
  injectionResult: z.enum(INJECTION_ATTEMPT_RESULTS),
  durationMs: nonnegativeSafeIntegerSchema,
  createdAt: canonicalTimestampSchema,
}).superRefine((value, context) => {
  const ids = value.results.map((item) => `${item.knowledgeId}@${item.version}`);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["results"], message: "trace results must be unique" });
  }
  const ranks = value.results.map((item) => item.finalRank).sort((left, right) => left - right);
  if (ranks.some((rank, index) => rank !== index + 1)) {
    context.addIssue({ code: "custom", path: ["results"], message: "final ranks must be contiguous" });
  }
  if (value.injectionResult === "INJECTED") {
    context.addIssue({ code: "custom", path: ["injectionResult"], message: "P3 retrieval is SHADOW/read-only" });
  }
});

const answerSpanSchema = z.strictObject({
  start: nonnegativeSafeIntegerSchema,
  end: positiveRevisionSchema,
}).superRefine((value, context) => {
  if (value.start >= value.end) context.addIssue({ code: "custom", path: ["end"], message: "span must be non-empty" });
});

export const knowledgeAnswerCitationSchema = z.strictObject({
  knowledgeId: safeIdSchema,
  version: positiveRevisionSchema,
  answerSpans: z.array(answerSpanSchema).min(1).max(100),
  evidenceIds: z.array(safeIdSchema).max(100),
});

export const codexKnowledgeAnswerSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  queryId: safeIdSchema,
  retrievalTraceId: safeIdSchema,
  modelRunId: safeIdSchema.optional(),
  outcome: z.enum(CODEX_QUERY_OUTCOMES),
  model: boundedText(200).optional(),
  answer: z.string().max(100_000),
  factualSpans: z.array(answerSpanSchema).max(500),
  citations: z.array(knowledgeAnswerCitationSchema).max(500),
  unknowns: z.array(boundedText(2_000)).max(100),
  conflicts: z.array(z.strictObject({
    summary: boundedText(2_000),
    knowledgeVersions: z.array(z.strictObject({ knowledgeId: safeIdSchema, version: positiveRevisionSchema })).min(2).max(20),
  })).max(100),
  latencyMs: nonnegativeSafeIntegerSchema,
  usage: z.strictObject({
    inputTokens: nonnegativeSafeIntegerSchema.optional(),
    cachedInputTokens: nonnegativeSafeIntegerSchema.optional(),
    outputTokens: nonnegativeSafeIntegerSchema.optional(),
    reasoningOutputTokens: nonnegativeSafeIntegerSchema.optional(),
  }),
}).superRefine((value, context) => {
  const inBounds = (span: { readonly start: number; readonly end: number }) => span.end <= value.answer.length;
  value.factualSpans.forEach((span, index) => {
    if (!inBounds(span)) {
      context.addIssue({ code: "custom", path: ["factualSpans", index], message: "factual span exceeds answer length" });
      return;
    }
    const covered = value.citations.some((citation) => citation.answerSpans.some(
      (citationSpan) => citationSpan.start <= span.start && citationSpan.end >= span.end,
    ));
    if (!covered) context.addIssue({ code: "custom", path: ["factualSpans", index], message: "factual span lacks a knowledge version citation" });
  });
  value.citations.forEach((citation, citationIndex) => citation.answerSpans.forEach((span, spanIndex) => {
    if (!inBounds(span)) {
      context.addIssue({ code: "custom", path: ["citations", citationIndex, "answerSpans", spanIndex], message: "citation span exceeds answer length" });
    }
  }));
  const references = value.citations.map((item) => `${item.knowledgeId}@${item.version}`);
  if (new Set(references).size !== references.length) {
    context.addIssue({ code: "custom", path: ["citations"], message: "citation knowledge versions must be unique" });
  }
  if (value.outcome === "SUCCEEDED" && value.modelRunId === undefined) {
    context.addIssue({ code: "custom", path: ["modelRunId"], message: "successful Codex answer requires a model run" });
  }
  if (value.outcome !== "SUCCEEDED" && value.factualSpans.length > 0) {
    context.addIssue({ code: "custom", path: ["factualSpans"], message: "fallback and failed answers cannot contain model factual spans" });
  }
});

export const retrievalSimulationRequestSchema = z.strictObject({
  schemaVersion: z.literal(CONTROL_API_SCHEMA_VERSION),
  requestId: requestIdSchema,
  type: z.literal("retrieval.simulate"),
  query: boundedText(20_000),
  projectId: safeIdSchema.optional(),
  taskId: safeIdSchema.optional(),
  currentPolicy: retrievalPolicyReferenceSchema,
  draftPolicy: retrievalPolicyReferenceSchema.optional(),
  fixedInputTraceId: safeIdSchema.optional(),
  maxContextTokens: z.number().int().min(64).max(128_000),
}).superRefine((value, context) => {
  if (value.draftPolicy?.source !== "DRAFT") {
    if (value.draftPolicy !== undefined) context.addIssue({ code: "custom", path: ["draftPolicy", "source"], message: "comparison policy must be a draft" });
  }
  if (value.fixedInputTraceId !== undefined && value.currentPolicy.source !== "REPLAY") {
    context.addIssue({ code: "custom", path: ["currentPolicy", "source"], message: "fixed input replay requires replay policy source" });
  }
});

export type NaturalLanguageSearchRequest = z.infer<typeof naturalLanguageSearchRequestSchema>;
export type RetrievalTraceContract = z.infer<typeof retrievalTraceSchema>;
export type CodexKnowledgeAnswerContract = z.infer<typeof codexKnowledgeAnswerSchema>;
export type RetrievalSimulationRequest = z.infer<typeof retrievalSimulationRequestSchema>;
