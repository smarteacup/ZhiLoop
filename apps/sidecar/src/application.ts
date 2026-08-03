import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  RealCodexAcceptanceCoordinator,
  SqliteRealCodexAcceptanceEvidenceStore,
  type PersistedRealCodexAcceptance,
  type RealCodexAcceptanceRequest,
  type RealCodexAcceptanceStage,
} from "@zhiloop/automatic-ingestion";
import {
  CodexSessionCaptureService,
  type CaptureSessionReport,
  type CaptureSessionRequest,
  type TranscriptCursor,
} from "@zhiloop/codex-session-capture";
import type { CapabilitySnapshot, ControlRequest, ControlResponse } from "@zhiloop/control-api";
import { SqliteConfigurationService, type ConsoleConfiguration } from "@zhiloop/configuration-service";
import { SqliteEventLedger } from "@zhiloop/conversation-ledger";
import { ZhiLoopDaemonRuntime, type DaemonHealthSnapshot, type DaemonWorkerCycle } from "@zhiloop/daemon";
import { CodexHookHandler, LocalEventSpool, type HookCaptureResult, type HookEventSink } from "@zhiloop/hook-runtime";

import type { SidecarConfig } from "./config.js";
import { SidecarControlPlane, type CaptureExecutionPort } from "./control-plane.js";
import { SafeDiagnosticLog } from "./diagnostic-log.js";
import { SIDECAR_COMPATIBILITY, SIDECAR_VERSION } from "./metadata.js";
import { P1SidecarRuntime, type P1RuntimeConfiguration } from "./p1-runtime.js";

export interface SidecarHealthReport extends DaemonHealthSnapshot {
  readonly rolloutMode: "SHADOW";
  readonly socketStatus: "READY";
}

const MAX_PENDING_ACCEPTANCE_EVIDENCE = 10_000;

interface PendingAcceptanceEvidence {
  readonly stage: Extract<RealCodexAcceptanceStage, "HOOK" | "SPOOL" | "LEDGER">;
  readonly sessionId: string;
  readonly identity: string;
  readonly observedAt: string;
}

function captureCode(result: HookCaptureResult): string {
  if (result.status === "dropped-invalid") return result.diagnostic.code;
  if (result.status === "spooled" || result.status === "dropped-spool-failed") return `${result.status}:${result.reason}`;
  return result.status;
}

function p1Configuration(configuration: ConsoleConfiguration): P1RuntimeConfiguration {
  return Object.freeze({
    sessionScanIntervalMs: configuration.runtime.sessionScanIntervalMs,
    followDebounceMs: configuration.runtime.followDebounceMs,
    workerPollIntervalMs: configuration.runtime.workerPollIntervalMs,
    workerConcurrency: configuration.runtime.workerConcurrency,
    scanBatchSize: configuration.runtime.scanBatchSize,
    captureBatchSize: configuration.runtime.captureBatchSize,
    captureRetry: configuration.runtime.captureRetry,
  });
}

export class SidecarApplication {
  readonly #runtime: ZhiLoopDaemonRuntime;
  readonly #ledger: SqliteEventLedger;
  readonly #capture: CodexSessionCaptureService;
  readonly #log: SafeDiagnosticLog;
  readonly #configuration: SqliteConfigurationService;
  readonly #acceptanceEvidence: SqliteRealCodexAcceptanceEvidenceStore;
  #acceptanceCoordinator: RealCodexAcceptanceCoordinator | undefined;
  #controlPlane: SidecarControlPlane | undefined;
  #p1Runtime: P1SidecarRuntime | undefined;
  #closed = false;
  #captureTail: Promise<void> = Promise.resolve();
  #workerTail: Promise<void> = Promise.resolve();
  #acceptanceTail: Promise<void> = Promise.resolve();
  readonly #pendingAcceptanceEvidence: PendingAcceptanceEvidence[] = [];

  private constructor(
    config: SidecarConfig,
    ledger: SqliteEventLedger,
    spool: LocalEventSpool,
    log: SafeDiagnosticLog,
    configuration: SqliteConfigurationService,
    acceptanceEvidence: SqliteRealCodexAcceptanceEvidenceStore,
  ) {
    this.#ledger = ledger;
    this.#log = log;
    this.#configuration = configuration;
    this.#acceptanceEvidence = acceptanceEvidence;
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
        const appended = ledger.append(event);
        this.#stageAcceptanceEvidence("LEDGER", event.sessionId, `${event.eventId}:${appended.sequence}`, new Date().toISOString());
      },
    };
    const evidenceSpool = {
      store: async (event: Parameters<LocalEventSpool["store"]>[0], priorRedactionCount: number) => {
        const hookObservedAt = new Date().toISOString();
        const stored = await spool.store(event, priorRedactionCount);
        const spoolObservedAt = new Date().toISOString();
        this.#stageAcceptanceEvidence("HOOK", event.sessionId, event.eventId, hookObservedAt);
        this.#stageAcceptanceEvidence("SPOOL", event.sessionId, stored.fileName, spoolObservedAt);
        return stored;
      },
    };
    const captureSink: HookEventSink = {
      enqueue: async (event, signal) => {
        if (signal.aborted) throw signal.reason;
        await evidenceSpool.store(event, 0);
      },
    };
    const handler = new CodexHookHandler({ sink: captureSink, spool: evidenceSpool });
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
          this.#flushAcceptanceEvidence();
          const cycle = {
            consumed: drained.delivered,
            produced: drained.delivered,
            cursor: ledger.count(),
            retryableFailures: drained.stopReason === null ? 0 : 1,
          };
          await this.#controlPlane?.scheduleLedgerProjection();
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

  #stageAcceptanceEvidence(
    stage: Extract<RealCodexAcceptanceStage, "HOOK" | "SPOOL" | "LEDGER">,
    sessionId: string,
    identity: string,
    observedAt: string,
  ): void {
    if (this.#pendingAcceptanceEvidence.length >= MAX_PENDING_ACCEPTANCE_EVIDENCE) return;
    this.#pendingAcceptanceEvidence.push(Object.freeze({ stage, sessionId, identity, observedAt }));
  }

  #flushAcceptanceEvidence(): void {
    if (this.#pendingAcceptanceEvidence.length === 0) return;
    const pending = this.#pendingAcceptanceEvidence.splice(0);
    const operation = this.#acceptanceTail
      .then(async () => await new Promise<void>((resolvePromise) => setImmediate(resolvePromise)))
      .then(() => {
        this.#acceptanceEvidence.recordMany(pending);
      });
    // Evidence is deliberately best-effort and off the Hook path. A write
    // failure leaves acceptance NOT_VERIFIED instead of affecting Codex.
    this.#acceptanceTail = operation.catch(() => undefined);
  }

  #projectAcceptanceCapability(acceptance: PersistedRealCodexAcceptance): void {
    const verified = acceptance.result.status === "VERIFIED";
    const snapshot: CapabilitySnapshot = {
      schemaVersion: 1,
      capabilityId: "codex.live-hook",
      status: verified ? "READY" : "NOT_VERIFIED",
      reasonCode: verified ? "COMPONENT_READY" : "CAPABILITY_NOT_VERIFIED",
      observedAt: acceptance.verifiedAt,
      lastTransitionAt: acceptance.verifiedAt,
      retryable: false,
      evidenceRefs: [acceptance.evidenceRef],
      ...(!verified ? { nextAction: "Validate a newly created Codex task" } : {}),
    };
    this.#controlPlane?.projectCapabilitySnapshot(snapshot);
  }

  static async create(config: SidecarConfig): Promise<SidecarApplication> {
    await Promise.all([
      mkdir(dirname(config.ledgerPath), { recursive: true, mode: 0o700 }),
      mkdir(config.spoolPath, { recursive: true, mode: 0o700 }),
      mkdir(dirname(config.logPath), { recursive: true, mode: 0o700 }),
    ]);
    const ledger = new SqliteEventLedger(config.ledgerPath);
    let acceptanceEvidence: SqliteRealCodexAcceptanceEvidenceStore | undefined;
    let configuration: SqliteConfigurationService | undefined;
    let application: SidecarApplication | undefined;
    let p1Runtime: P1SidecarRuntime | undefined;
    try {
      acceptanceEvidence = new SqliteRealCodexAcceptanceEvidenceStore(join(dirname(config.ledgerPath), "real-codex-acceptance.sqlite"));
      configuration = new SqliteConfigurationService(join(dirname(config.ledgerPath), "configuration.sqlite"), {
        capabilities: () => ({
          "context.injection": "DISABLED",
          "knowledge.compile": "DISABLED",
          "codex.query": "DISABLED",
        }),
        components: [{
          componentId: "p1-background-runtime",
          prepare: async () => {
            if (p1Runtime === undefined) throw new Error("P1 runtime is not composed");
          },
          apply: async (next) => {
            if (p1Runtime === undefined) throw new Error("P1 runtime is not composed");
            return await p1Runtime.applyConfiguration(p1Configuration(next));
          },
        }],
      });
      const composedApplication = new SidecarApplication(
        config,
        ledger,
        new LocalEventSpool(config.spoolPath),
        new SafeDiagnosticLog(config.logPath, config.logMaxBytes, config.logRetainFiles),
        configuration,
        acceptanceEvidence,
      );
      application = composedApplication;
      const capture: CaptureExecutionPort = {
        capture: async (request) => await composedApplication.captureSession(request),
        transaction: async (operation) => await composedApplication.#captureTransaction(operation),
      };
      composedApplication.#controlPlane = await SidecarControlPlane.create({
        config,
        ledger,
        capture,
        health: async () => await composedApplication.health(),
        configuration,
        jobCommands: {
          cancelJob: async (request) => {
            if (p1Runtime === undefined) throw new Error("P1 runtime is not composed");
            return await p1Runtime.cancelJob(request);
          },
          retryJob: async (request) => {
            if (p1Runtime === undefined) throw new Error("P1 runtime is not composed");
            return await p1Runtime.retryJob(request);
          },
        },
      });
      composedApplication.#acceptanceCoordinator = new RealCodexAcceptanceCoordinator({
        evidence: acceptanceEvidence,
        catalog: composedApplication.#controlPlane.sessionCatalog(),
        cursor: {
          load: async (sessionId) => {
            const cursor = ledger.loadIngestionCursor<TranscriptCursor>(`codex-transcript:${sessionId}`);
            if (cursor === undefined) return undefined;
            return Object.freeze({
              updatedAt: cursor.updatedAt,
              identity: JSON.stringify([cursor.cursor.byteOffset, cursor.cursor.lineNumber]),
            });
          },
        },
      });
      const restoredAcceptance = acceptanceEvidence.latestVerified();
      if (restoredAcceptance !== undefined) composedApplication.#projectAcceptanceCapability(restoredAcceptance);
      p1Runtime = await P1SidecarRuntime.create({
        stateDirectory: dirname(config.ledgerPath),
        catalog: composedApplication.#controlPlane.sessionCatalog(),
        capture: { capture: async (request) => await composedApplication.captureSession(request) },
        projectJob: (snapshot) => { composedApplication.#controlPlane?.projectJob(snapshot); },
        recovery: {
          recover: async (request) => {
            ledger.rebaseIngestionCursor(`codex-transcript:${request.session.sessionId}`);
            return Object.freeze({ report: { status: "COMPLETED" as const }, sourceCheckpoint: "REBASED" as const });
          },
        },
        configuration: p1Configuration(configuration.get().effective),
        onIngestionReport: async (report) => {
          const code = report.diagnosticCodes[0] ?? report.catalogCoverage;
          await composedApplication.#log.write({ component: "worker", code: `automatic-ingestion:${code}`, count: report.capturedSessions }).catch(() => undefined);
        },
      });
      composedApplication.#p1Runtime = p1Runtime;
      return composedApplication;
    } catch (error) {
      await p1Runtime?.close().catch(() => undefined);
      if (application !== undefined) await application.#controlPlane?.close().catch(() => undefined);
      await configuration?.close().catch(() => undefined);
      acceptanceEvidence?.close();
      try { ledger.close(); } catch { /* Preserve the original composition failure. */ }
      throw error;
    }
  }

  async start(): Promise<void> {
    await this.#runtime.start();
    try {
      if (await this.#p1Runtime?.start()) this.#controlPlane?.setAutomaticIngestionReady();
    } catch (error) {
      await this.#runtime.stop();
      throw error;
    }
  }

  async handleHook(input: unknown): Promise<string> {
    const output = await this.#runtime.handleHook(input);
    // Start evidence persistence only after the Hook runtime has completed;
    // the returned Hook value never waits for SQLite acceptance writes.
    this.#flushAcceptanceEvidence();
    this.#workerTail = this.#workerTail
      .then(async () => { await this.#runtime.runWorkerOnce(); })
      .catch(() => undefined);
    return output;
  }

  async runWorkerOnce(): Promise<DaemonWorkerCycle> {
    return this.#runtime.runWorkerOnce();
  }

  async captureSession(request: CaptureSessionRequest): Promise<CaptureSessionReport> {
    const report = await this.#serializeCapture(async () => await this.#captureAndLog(request));
    await this.#controlPlane?.noteLegacyCapture(report);
    return report;
  }

  async #serializeCapture<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#captureTail.then(operation);
    this.#captureTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #captureTransaction<T>(
    operation: (capture: (request: CaptureSessionRequest) => Promise<CaptureSessionReport>) => Promise<T>,
  ): Promise<T> {
    return this.#serializeCapture(async () => await operation(async (request) => await this.#captureAndLog(request)));
  }

  async #captureAndLog(request: CaptureSessionRequest): Promise<CaptureSessionReport> {
    const startedAt = Date.now();
    try {
      const report = await this.#capture.capture(request);
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

  async handleControl(request: ControlRequest): Promise<ControlResponse> {
    if (!this.#controlPlane) throw new Error("control plane is not initialized");
    return this.#controlPlane.handle(request);
  }

  async verifyRealCodexIngestion(request: RealCodexAcceptanceRequest): Promise<PersistedRealCodexAcceptance> {
    this.#flushAcceptanceEvidence();
    await this.#acceptanceTail;
    if (this.#acceptanceCoordinator === undefined) throw new Error("real Codex acceptance is not initialized");
    const acceptance = await this.#acceptanceCoordinator.verify(request);
    this.#projectAcceptanceCapability(acceptance);
    return acceptance;
  }

  async health(): Promise<SidecarHealthReport> {
    return Object.freeze({ ...(await this.#runtime.health()), rolloutMode: "SHADOW", socketStatus: "READY" });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#captureTail;
    await this.#workerTail;
    await this.#p1Runtime?.close();
    await this.#runtime.stop();
    this.#flushAcceptanceEvidence();
    await this.#acceptanceTail;
    await this.#controlPlane?.close();
    await this.#configuration.close();
    this.#acceptanceEvidence.close();
    this.#ledger.close();
    this.#closed = true;
  }
}
