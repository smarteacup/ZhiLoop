import {
  capabilitySnapshotSchema,
  diagnosticsSchema,
  eventMetadataSchema,
  jobSnapshotSchema,
  sessionSummarySchema,
  stageSnapshotSchema,
} from "@zhiloop/control-api";
import { z } from "zod";

import type { OperatorDiagnostic, SessionProjectionInput, StageRunProjection } from "./types.js";

const safeIdentifier = z.string().min(1).max(500).regex(/^[A-Za-z0-9._:/@#-]+$/u);
const isoTimestamp = z.string().min(20).max(40).refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "expected an ISO timestamp",
});

const latestCursorSchema = z.strictObject({
  byteOffset: z.number().int().nonnegative(),
  lineNumber: z.number().int().nonnegative(),
  observedAt: isoTimestamp,
});

const sessionProjectionSchema = z.strictObject({
  summary: sessionSummarySchema,
  latestCursor: latestCursorSchema.optional(),
});

const stageRunProjectionSchema = z.strictObject({
  runId: safeIdentifier,
  snapshot: stageSnapshotSchema,
});

const operatorDiagnosticSchema = z.strictObject({
  diagnosticId: safeIdentifier,
  component: z.string().min(1).max(120).regex(/^[a-z][a-z0-9.-]*$/u),
  code: z.string().min(1).max(120).regex(/^[A-Z][A-Z0-9_]*$/u),
  severity: z.enum(["INFO", "WARNING", "ERROR"]),
  observedAt: isoTimestamp,
  retryable: z.boolean(),
  evidenceRefs: z.array(safeIdentifier.max(200)).max(64),
});

export const parseCapability = (value: Parameters<typeof capabilitySnapshotSchema.parse>[0]) => capabilitySnapshotSchema.parse(value);
export const parseSession = (value: SessionProjectionInput): SessionProjectionInput => sessionProjectionSchema.parse(value);
export const parseStageRun = (value: StageRunProjection): StageRunProjection => stageRunProjectionSchema.parse(value);
export const parseJob = (value: Parameters<typeof jobSnapshotSchema.parse>[0]) => jobSnapshotSchema.parse(value);
export const parseEvent = (value: Parameters<typeof eventMetadataSchema.parse>[0]) => eventMetadataSchema.parse(value);
export const parseOperatorDiagnostic = (value: OperatorDiagnostic): OperatorDiagnostic => operatorDiagnosticSchema.parse(value);
export const parseHealth = (value: Parameters<typeof diagnosticsSchema.parse>[0]) => diagnosticsSchema.parse(value);
