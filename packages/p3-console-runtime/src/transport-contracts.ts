import { z } from "zod";

import {
  p3AskResponseSchema,
  p3SearchResponseSchema,
  p3SimulationResponseSchema,
} from "./contracts.js";

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

export const p3ConsoleQueryBodySchema = z.strictObject({
  requestId: safeId,
  query: text(20_000),
  projectId: safeId.optional(),
  taskId: safeId.optional(),
  repositoryRoot: z.string().min(1).max(4_096).optional(),
  cwd: z.string().min(1).max(4_096).optional(),
  hints,
  maxResults: z.number().int().min(1).max(100),
  maxContextTokens: z.number().int().min(64).max(128_000),
  timeoutMs: z.number().int().min(1).max(120_000).optional(),
});

const queryFields = p3ConsoleQueryBodySchema.shape;

export const p3ConsoleSearchRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  type: z.literal("p3.knowledge.search"),
  ...queryFields,
});

export const p3ConsoleAskRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  type: z.literal("p3.knowledge.ask"),
  ...queryFields,
});

export const p3ConsoleSimulationRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  type: z.literal("p3.retrieval.simulate"),
  ...queryFields,
});

export const p3ConsoleTraceRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: safeId,
  type: z.literal("p3.retrieval.trace"),
  traceId: safeId,
  projectId: safeId.optional(),
  taskId: safeId.optional(),
});

export const p3ConsoleTransportRequestSchema = z.discriminatedUnion("type", [
  p3ConsoleSearchRequestSchema,
  p3ConsoleAskRequestSchema,
  p3ConsoleSimulationRequestSchema,
  p3ConsoleTraceRequestSchema,
]);

export const p3ConsoleSearchResponseSchema = p3SearchResponseSchema;
export const p3ConsoleAskResponseSchema = p3AskResponseSchema;
export const p3ConsoleSimulationResponseSchema = p3SimulationResponseSchema;

export type P3ConsoleQueryBody = z.infer<typeof p3ConsoleQueryBodySchema>;
export type P3ConsoleTransportRequest = z.infer<typeof p3ConsoleTransportRequestSchema>;
