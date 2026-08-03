import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
  CodexSessionCaptureService,
  type CaptureSessionReport,
  type CaptureSessionRequest,
  type TranscriptCursor,
} from "@zhiloop/codex-session-capture";
import { SqliteEventLedger } from "@zhiloop/conversation-ledger";
import { ZhiLoopDaemonRuntime, type DaemonHealthSnapshot, type DaemonWorkerCycle } from "@zhiloop/daemon";
import { CodexHookHandler, LocalEventSpool, type HookCaptureResult, type HookEventSink } from "@zhiloop/hook-runtime";

import type { SidecarConfig } from "./config.js";
import { SafeDiagnosticLog } from "./diagnostic-log.js";
import { SIDECAR_COMPATIBILITY, SIDECAR_VERSION } from "./metadata.js";

export interface SidecarHealthReport extends DaemonHealthSnapshot {
  readonly rolloutMode: "SHADOW";
  readonly socketStatus: "READY";
}

function captureCode(result: HookCaptureResult): string {
  if (result.status === "dropped-invalid") return result.diagnostic.code;
  if (result.status === "spooled" || result.status === "dropped-spool-failed") return `${result.status}:${result.reason}`;
  return result.status;
}

export class SidecarApplication {
  readonly #runtime: ZhiLoopDaemonRuntime;
  readonly #ledger: SqliteEventLedger;
  readonly #capture: CodexSessionCaptureService;
  readonly #log: SafeDiagnosticLog;
  #closed = false;
  #captureTail: Promise<void> = Promise.resolve();
  #workerTail: Promise<void> = Promise.resolve();

  private constructor(config: SidecarConfig, ledger: SqliteEventLedger, spool: LocalEventSpool, log: SafeDiagnosticLog) {
    this.#ledger = ledger;
    this.#log = log;
    this.#capture = new CodexSessionCaptureService(
      config.codexSessionsRoot,
      { appendBatch: (events) => ledger.appendBatch(events) },
      {
        load: (ingestionId) => ledger.loadIngestionCursor<TranscriptCursor>(ingestionId)?.cursor,
        commit: (ingestionId, cursor) => ledger.commitIngestionCursor(ingestionId, cursor),
      },
    );
    const ledgerSink: HookEventSink = {
      enqueue: async (event, signal) => {
        if (signal.aborted) throw signal.reason;
        ledger.append(event);
      },
    };
    const captureSink: HookEventSink = {
      enqueue: async (event, signal) => {
        if (signal.aborted) throw signal.reason;
        await spool.store(event, 0);
      },
    };
    const handler = new CodexHookHandler({ sink: captureSink, spool });
    this.#runtime = new ZhiLoopDaemonRuntime({
      components: [{
        name: "conversation-ledger",
        start: async () => undefined,
        stop: async () => undefined,
        health: async () => ({ healthy: true }),
      }],
      hook: {
        handle: async (input) => {
          const capture = await handler.handle(input);
          await log.write({ component: "hook", code: captureCode(capture), durationMs: capture.durationMs }).catch(() => undefined);
          return "";
        },
      },
      mcp: { handle: async () => { throw new Error("MCP transport is not enabled in the local SHADOW release"); } },
      worker: {
        runOnce: async (signal): Promise<DaemonWorkerCycle> => {
          const drained = await spool.drain(ledgerSink, { signal });
          const cycle = {
            consumed: drained.delivered,
            produced: drained.delivered,
            cursor: ledger.count(),
            retryableFailures: drained.stopReason === null ? 0 : 1,
          };
          await log.write({ component: "worker", code: drained.stopReason ?? "completed", count: drained.delivered }).catch(() => undefined);
          return cycle;
        },
      },
    }, {
      compatibility: SIDECAR_COMPATIBILITY,
      sidecarVersion: SIDECAR_VERSION,
      hookDeadlinesMs: { UserPromptSubmit: config.hookTimeoutMs },
    });
  }

  static async create(config: SidecarConfig): Promise<SidecarApplication> {
    await Promise.all([
      mkdir(dirname(config.ledgerPath), { recursive: true, mode: 0o700 }),
      mkdir(config.spoolPath, { recursive: true, mode: 0o700 }),
      mkdir(dirname(config.logPath), { recursive: true, mode: 0o700 }),
    ]);
    const ledger = new SqliteEventLedger(config.ledgerPath);
    return new SidecarApplication(
      config,
      ledger,
      new LocalEventSpool(config.spoolPath),
      new SafeDiagnosticLog(config.logPath, config.logMaxBytes, config.logRetainFiles),
    );
  }

  async start(): Promise<void> {
    await this.#runtime.start();
  }

  async handleHook(input: unknown): Promise<string> {
    const output = await this.#runtime.handleHook(input);
    this.#workerTail = this.#workerTail
      .then(async () => { await this.#runtime.runWorkerOnce(); })
      .catch(() => undefined);
    return output;
  }

  async runWorkerOnce(): Promise<DaemonWorkerCycle> {
    return this.#runtime.runWorkerOnce();
  }

  async captureSession(request: CaptureSessionRequest): Promise<CaptureSessionReport> {
    const startedAt = Date.now();
    const operation = this.#captureTail.then(async () => await this.#capture.capture(request));
    this.#captureTail = operation.then(() => undefined, () => undefined);
    try {
      const report = await operation;
      await this.#log.write({
        component: "capture",
        code: report.status,
        durationMs: Date.now() - startedAt,
        count: report.appendedEvents,
      }).catch(() => undefined);
      return report;
    } catch (error) {
      const code = error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "CAPTURE_FAILED";
      await this.#log.write({ component: "capture", code, durationMs: Date.now() - startedAt }).catch(() => undefined);
      throw error;
    }
  }

  async health(): Promise<SidecarHealthReport> {
    return Object.freeze({ ...(await this.#runtime.health()), rolloutMode: "SHADOW", socketStatus: "READY" });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#captureTail;
    await this.#workerTail;
    await this.#runtime.stop();
    this.#ledger.close();
    this.#closed = true;
  }
}
