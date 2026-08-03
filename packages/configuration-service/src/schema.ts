import { consoleConfigurationSchema, type ConsoleConfiguration } from "@zhiloop/control-api";

export { consoleConfigurationSchema, type ConsoleConfiguration };
export const runtimeConfigurationSchema = consoleConfigurationSchema.shape.runtime;
export const futureConsumerConfigurationSchema = consoleConfigurationSchema.shape.future;

export const DEFAULT_CONSOLE_CONFIGURATION: ConsoleConfiguration = Object.freeze({
  schemaVersion: 1,
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
});
