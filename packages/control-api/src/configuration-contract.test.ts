import { describe, expect, it } from "vitest";

import {
  CONTROL_API_SCHEMA_VERSION,
  configurationMutationResultSchema,
  configurationValidationResultSchema,
  consoleConfigurationSchema,
  controlRequestSchema,
} from "./index.js";

const configuration = {
  schemaVersion: 1,
  runtime: {
    sessionScanIntervalMs: 60_000,
    followDebounceMs: 1_000,
    workerPollIntervalMs: 1_000,
    extractionDelayMs: 300_000,
    workerConcurrency: 2,
    scanBatchSize: 100,
    captureBatchSize: 100,
    captureRetry: { maxAttempts: 5, baseDelayMs: 1_000, maximumDelayMs: 60_000, jitterRatio: 0.2 },
    alerts: {
      enabled: true,
      notify: false,
      minimumSeverity: "WARNING",
      spoolDepth: { warning: 100, error: 1_000 },
      spoolOldestAgeMs: { warning: 60_000, error: 600_000 },
      cursorLagEvents: { warning: 1_000, error: 10_000 },
      failedJobs: { warning: 1, error: 10 },
      hookSilenceMs: { warning: 3_600_000, error: 21_600_000 },
      quietHours: { enabled: false, startMinute: 1_320, endMinute: 480, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], utcOffsetMinutes: 480 },
    },
  },
  future: { injectionMaxTokens: 800, compilerBatchSize: 50, codexQueryTimeoutMs: 30_000, codexQueryConcurrency: 2 },
} as const;

describe("configuration Control API contract", () => {
  it("accepts the bounded baseline and rejects unknown fields or call-storm settings", () => {
    expect(consoleConfigurationSchema.parse(configuration)).toEqual(configuration);
    expect(consoleConfigurationSchema.safeParse({ ...configuration, unknown: true }).success).toBe(false);
    expect(consoleConfigurationSchema.safeParse({
      ...configuration,
      runtime: { ...configuration.runtime, sessionScanIntervalMs: 0 },
    }).success).toBe(false);
    expect(consoleConfigurationSchema.safeParse({
      ...configuration,
      runtime: { ...configuration.runtime, captureRetry: { ...configuration.runtime.captureRetry, baseDelayMs: 2_000, maximumDelayMs: 1_000 } },
    }).success).toBe(false);
  });

  it("binds project identity to PROJECT scope and rejects extra request fields", () => {
    const base = { schemaVersion: CONTROL_API_SCHEMA_VERSION, requestId: "configuration-request", type: "config.validate" as const, baseRevision: 0, draft: {} };
    expect(controlRequestSchema.safeParse({ ...base, scope: "PROJECT", projectId: "project-a" }).success).toBe(true);
    expect(controlRequestSchema.safeParse({ ...base, scope: "PROJECT" }).success).toBe(false);
    expect(controlRequestSchema.safeParse({ ...base, scope: "GLOBAL", projectId: "project-a" }).success).toBe(false);
    expect(controlRequestSchema.safeParse({ ...base, scope: "GLOBAL", secret: "must-not-pass" }).success).toBe(false);
  });

  it("keeps validation and activation diagnostics structured and bounded", () => {
    expect(configurationValidationResultSchema.safeParse({
      ok: false,
      diagnostics: [{ code: "CONSUMER_DISABLED", path: "future.injectionMaxTokens", retryable: false }],
    }).success).toBe(true);
    expect(configurationMutationResultSchema.safeParse({
      ok: false,
      diagnostic: { code: "COMPONENT_ROLLBACK_FAILED", retryable: true },
    }).success).toBe(true);
    expect(configurationMutationResultSchema.safeParse({ ok: false, diagnostic: { code: "UNKNOWN", retryable: false } }).success).toBe(false);
  });
});
