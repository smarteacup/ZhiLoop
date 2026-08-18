import { consoleConfigurationSchema, type ConsoleConfiguration } from "@zhiloop/control-api";

export { consoleConfigurationSchema, type ConsoleConfiguration };
export const runtimeConfigurationSchema = consoleConfigurationSchema.shape.runtime;
export const futureConsumerConfigurationSchema = consoleConfigurationSchema.shape.future;

export const DEFAULT_CONSOLE_CONFIGURATION: ConsoleConfiguration = Object.freeze({
  schemaVersion: 2,
  runtime: Object.freeze({
    sessionScanIntervalMs: 60_000,
    followDebounceMs: 1_000,
    workerPollIntervalMs: 1_000,
    extractionDelayMs: 300_000,
    workerConcurrency: 2,
    scanBatchSize: 100,
    captureBatchSize: 100,
    captureRetry: Object.freeze({ maxAttempts: 5, baseDelayMs: 1_000, maximumDelayMs: 60_000, jitterRatio: 0.2 }),
    alerts: Object.freeze({
      enabled: true,
      notify: false,
      minimumSeverity: "WARNING",
      spoolDepth: Object.freeze({ warning: 100, error: 1_000 }),
      spoolOldestAgeMs: Object.freeze({ warning: 60_000, error: 600_000 }),
      cursorLagEvents: Object.freeze({ warning: 1_000, error: 10_000 }),
      failedJobs: Object.freeze({ warning: 1, error: 10 }),
      hookSilenceMs: Object.freeze({ warning: 3_600_000, error: 21_600_000 }),
      quietHours: Object.freeze({ enabled: false, startMinute: 1_320, endMinute: 480, daysOfWeek: Object.freeze([0, 1, 2, 3, 4, 5, 6]), utcOffsetMinutes: 480 }),
    }),
  }),
  future: Object.freeze({
    injectionMaxTokens: 800,
    compilerBatchSize: 50,
    codexQueryTimeoutMs: 30_000,
    codexQueryConcurrency: 2,
  }),
  compilation: Object.freeze({
    enabled: true,
    mode: "PREVIEW_ONLY",
    minNewTurns: 3,
    minNewEvents: 2,
    idleMs: 120_000,
    maximumWaitMs: 1_800_000,
    onSessionEnd: true,
    scanIntervalMs: 1_000,
    maxSessionsPerRun: 100,
    maxDispatchesPerRun: 20,
    publication: Object.freeze({
      enabled: false,
      allowedKindsCsv: "",
      allowedProjectIdsCsv: "",
      requireFreshCodeEvidence: true,
      goldenDatasetId: "",
      goldenDatasetVersion: 0,
      goldenConfigFingerprint: "",
    }),
  }),
  evolution: Object.freeze({ maxMatchCandidates: 5, semanticJudgeEnabled: false, failClosed: true }),
  codeIntelligence: Object.freeze({
    provider: "codegraph", initializeAutomatically: false, queryTimeoutMs: 250,
    circuitBreakerFailures: 3, circuitBreakerResetMs: 30_000,
  }),
  freshness: Object.freeze({
    enabled: true, changeDebounceMs: 1_000, fallbackScanIntervalMs: 3_600_000,
    preInjectionGate: true, gateTimeoutMs: 200, maxAffectedPerJob: 500,
  }),
  prewarm: Object.freeze({ enabled: true, onSessionStart: true, ttlMs: 1_800_000, maxItems: 8, maxTokens: 800 }),
  evolutionAlerts: Object.freeze({
    enabled: false, onPermanentJobFailure: true, onCodeGraphUnavailable: false, onStaleKnowledgeDetected: false,
  }),
});

/** Deterministically upgrades persisted Console schema v1 values without weakening strict v2 validation. */
export function migrateConsoleConfiguration(value: unknown): ConsoleConfiguration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("console configuration must be an object");
  const record = value as Record<string, unknown>;
  if (record["schemaVersion"] === 2) return consoleConfigurationSchema.parse(value);
  if (record["schemaVersion"] !== 1) throw new Error(`unsupported console configuration schemaVersion: ${String(record["schemaVersion"])}`);
  const legacyKeys = new Set(["schemaVersion", "runtime", "future"]);
  if (Object.keys(record).some((key) => !legacyKeys.has(key))) throw new Error("legacy console configuration contains unknown fields");
  return consoleConfigurationSchema.parse({
    ...structuredClone(DEFAULT_CONSOLE_CONFIGURATION),
    ...structuredClone(record),
    schemaVersion: 2,
  });
}
