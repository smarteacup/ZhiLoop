import {
  codexKnowledgeAnswerSchema,
  retrievalPolicyReferenceSchema,
  retrievalTraceSchema,
  type CodexKnowledgeAnswerContract,
  type RetrievalTraceContract,
} from "@zhiloop/control-api";
import { z } from "zod";

const safeId = z.string().min(3).max(500).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u);
const text = (maximum: number): z.ZodString => z.string().min(1).max(maximum).refine(
  (value) => !value.includes("\0"),
  { message: "text cannot contain NUL" },
);
const hints = z.strictObject({
  paths: z.array(text(1_000)).max(100).optional(),
  symbols: z.array(text(1_000)).max(100).optional(),
  errorCodes: z.array(text(1_000)).max(100).optional(),
  configKeys: z.array(text(1_000)).max(100).optional(),
}).optional();

const queryBase = {
  schemaVersion: z.literal(1),
  requestId: safeId,
  query: text(20_000),
  projectId: safeId.optional(),
  taskId: safeId.optional(),
  repositoryRoot: z.string().min(1).max(4_096).optional(),
  cwd: z.string().min(1).max(4_096).optional(),
  hints,
  maxResults: z.number().int().min(1).max(100),
  maxContextTokens: z.number().int().min(64).max(128_000),
  timeoutMs: z.number().int().min(1).max(120_000),
} as const;

export const p3SearchRequestSchema = z.strictObject({
  ...queryBase,
  type: z.literal("knowledge.search"),
  mode: z.literal("SEARCH_ONLY"),
  policy: retrievalPolicyReferenceSchema,
});

export const p3AskRequestSchema = z.strictObject({
  ...queryBase,
  type: z.literal("knowledge.ask"),
  mode: z.literal("CODEX_ASSISTED"),
  policy: retrievalPolicyReferenceSchema,
});

export const p3SimulationRequestSchema = z.strictObject({
  ...queryBase,
  type: z.literal("retrieval.simulate"),
  currentPolicy: retrievalPolicyReferenceSchema,
  draftPolicy: retrievalPolicyReferenceSchema.optional(),
  fixedInputTraceId: safeId.optional(),
});

export const p3TraceRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  type: z.literal("retrieval.trace"),
  traceId: safeId,
  projectId: safeId.optional(),
  taskId: safeId.optional(),
});

export const p3PolicyComparisonSchema = z.strictObject({
  currentTraceId: safeId,
  draftTraceId: safeId,
  selectedOnlyByCurrent: z.array(text(1_000)).max(100),
  selectedOnlyByDraft: z.array(text(1_000)).max(100),
  currentEstimatedTokens: z.number().int().nonnegative(),
  draftEstimatedTokens: z.number().int().nonnegative(),
  tokenDelta: z.number().int(),
  currentTruncated: z.boolean(),
  draftTruncated: z.boolean(),
});

export const p3SearchResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("SEARCH"),
  trace: retrievalTraceSchema,
});

export const p3SimulationResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("SIMULATION"),
  current: retrievalTraceSchema,
  draft: retrievalTraceSchema.optional(),
  comparison: p3PolicyComparisonSchema.optional(),
}).superRefine((value, context) => {
  if ((value.draft === undefined) !== (value.comparison === undefined)) {
    context.addIssue({ code: "custom", path: ["comparison"], message: "draft and comparison must be present together" });
  }
});

export const p3AskResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("ASK"),
  trace: retrievalTraceSchema,
  answer: codexKnowledgeAnswerSchema,
});

export type P3SearchRequest = z.infer<typeof p3SearchRequestSchema>;
export type P3AskRequest = z.infer<typeof p3AskRequestSchema>;
export type P3SimulationRequest = z.infer<typeof p3SimulationRequestSchema>;
export type P3TraceRequest = z.infer<typeof p3TraceRequestSchema>;
export type P3SearchResponse = z.infer<typeof p3SearchResponseSchema>;
export type P3SimulationResponse = z.infer<typeof p3SimulationResponseSchema>;
export type P3AskResponse = z.infer<typeof p3AskResponseSchema>;
export type P3RuntimeResponse = P3SearchResponse | P3SimulationResponse | P3AskResponse;
export type { CodexKnowledgeAnswerContract, RetrievalTraceContract };
