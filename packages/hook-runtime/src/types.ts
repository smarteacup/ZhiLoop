import type { EventEnvelope } from "@zhiloop/domain";
import type { CodexHookAdapterOptions, CodexHookDiagnostic } from "@zhiloop/ingestion-codex";

export interface HookEventSink {
  enqueue(event: EventEnvelope, signal: AbortSignal): Promise<void>;
}

export type SpoolStoreResult =
  | { readonly status: "stored"; readonly fileName: string; readonly redactionCount: number }
  | { readonly status: "duplicate"; readonly fileName: string };

export interface HookEventSpool {
  store(event: EventEnvelope, priorRedactionCount: number): Promise<SpoolStoreResult>;
}

export interface CodexHookHandlerOptions {
  readonly sink: HookEventSink;
  readonly spool: HookEventSpool;
  readonly enqueueDeadlineMs?: number;
  readonly adapterOptions?: CodexHookAdapterOptions;
  readonly monotonicClock?: () => number;
}

export type HookFallbackReason = "enqueue-timeout" | "sink-unavailable";

interface HookCaptureTiming {
  readonly durationMs: number;
}

export type HookCaptureResult =
  | (HookCaptureTiming & { readonly status: "enqueued" })
  | (HookCaptureTiming & {
      readonly status: "spooled";
      readonly reason: HookFallbackReason;
      readonly spoolStatus: SpoolStoreResult["status"];
    })
  | (HookCaptureTiming & {
      readonly status: "dropped-invalid";
      readonly diagnostic: CodexHookDiagnostic;
    })
  | (HookCaptureTiming & {
      readonly status: "dropped-spool-failed";
      readonly reason: HookFallbackReason;
      readonly errorName: string;
    });

export interface SpoolDiagnostic {
  readonly fileName: string;
  readonly code: "filename-mismatch" | "invalid-record" | "oversized-record" | "read-failed";
  readonly quarantined: boolean;
}

export interface SpoolDrainOptions {
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface SpoolDrainResult {
  readonly delivered: number;
  readonly remaining: number;
  readonly diagnostics: readonly SpoolDiagnostic[];
  readonly stopReason: "aborted" | "cleanup-error" | "sink-error" | null;
  readonly scanTruncated: boolean;
}

export interface LocalEventSpoolOptions {
  readonly clock?: () => Date;
  readonly randomId?: () => string;
  readonly maxRecordBytes?: number;
  readonly maxScanFiles?: number;
}

export interface HookCommandOptions {
  readonly maxInputBytes?: number;
}

export interface HookCommandResult {
  readonly exitCode: 0;
  readonly capture: HookCaptureResult;
}
