import { createHash } from "node:crypto";
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
import { DEFAULT_CONFIGURATION } from "@zhiloop/config";
import { CONTROL_API_SCHEMA_VERSION, type CapabilitySnapshot, type ControlRequest, type ControlResponse, type JobSnapshot, type P2ControlRequest } from "@zhiloop/control-api";
import type { EvolutionJobProjection } from "@zhiloop/evolution-job-runtime";
import { SqliteConfigurationService, type ConsoleConfiguration } from "@zhiloop/configuration-service";
import { SqliteEventLedger } from "@zhiloop/conversation-ledger";
import { ZhiLoopDaemonRuntime, type DaemonHealthSnapshot, type DaemonWorkerCycle } from "@zhiloop/daemon";
import { CodexHookHandler, LocalEventSpool, type HookCaptureResult, type HookEventSink } from "@zhiloop/hook-runtime";
import { ExtractionConflictError, ExtractionStaleRevisionError } from "@zhiloop/session-extraction";
import {
  CodexExecKnowledgeQueryModel,
  InMemoryCodexKnowledgeQueryDiagnosticStore,
} from "@zhiloop/model-codex-exec";
import type { P3ConsoleTransportRequest } from "@zhiloop/p3-console-runtime";
import { ActiveRolloutService, FileRolloutStateStore } from "@zhiloop/active-rollout-service";
import type { VersionedMcpRequest } from "@zhiloop/active-knowledge-runtime";
import { ContextOrchestrator } from "@zhiloop/context-orchestrator";

import type { SidecarConfig } from "./config.js";
import { projectCaptureEvent } from "./capture-content.js";
import { SidecarControlPlane, type CaptureExecutionPort } from "./control-plane.js";
import { SafeDiagnosticLog } from "./diagnostic-log.js";
import { SIDECAR_COMPATIBILITY, SIDECAR_VERSION } from "./metadata.js";
import { P1SidecarRuntime, type P1RuntimeConfiguration } from "./p1-runtime.js";
import { P2SidecarRuntime } from "./p2-runtime.js";
import { P2ProductionComposition } from "./p2-production.js";
import { P2ConsoleRuntime, type P2ConsoleRequest } from "./p2-console.js";
import { P2AutomaticCompilationRuntime } from "./p2-automatic-compilation.js";
import { P2EvolutionRuntime, normalizeP2EvolutionRuntimeConfiguration } from "./p2-evolution-runtime.js";
import { P2DurableAutomaticCompilationAdapter, P2CandidatePreviewCoordinator } from "./p2-preview-coordinator.js";
import { P3SidecarConsole } from "./p3-console.js";
import { P4ActiveSidecarRuntime, type P4ActiveHookResult } from "./p4-active-runtime.js";
import { P4SidecarConsole, type P4ConsoleTransportRequest } from "./p4-console.js";
import { createP4RetrievalComposition } from "./p4-retrieval.js";

export interface SidecarHealthReport extends DaemonHealthSnapshot {
  readonly rolloutMode: "SHADOW" | "ACTIVE";
  readonly socketStatus: "READY";
  readonly knowledgeEvolution: ReturnType<P2EvolutionRuntime["state"]> | { readonly status: "NOT_CONFIGURED" };
}

export interface SidecarHookTransportResult {
  readonly schemaVersion: 1;
  readonly hookOutput: string;
  readonly delivery?: {
    readonly attemptId: string;
    readonly expectedRevision: 1;
    readonly alreadyAcknowledged: boolean;
  };
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

function knowledgeCompilationConfiguration(configuration: ConsoleConfiguration) {
  return Object.freeze({
    enabled: configuration.compilation.enabled,
    scanIntervalMs: configuration.compilation.scanIntervalMs,
    minimumNewTurns: configuration.compilation.minNewTurns,
    minimumNewEvents: configuration.compilation.minNewEvents,
    idleAfterMs: configuration.compilation.idleMs,
    maximumWaitMs: configuration.compilation.maximumWaitMs,
    maxSessionsPerRun: configuration.compilation.maxSessionsPerRun,
    maxDispatchesPerRun: configuration.compilation.maxDispatchesPerRun,
  });
}

function freshnessSchedulerConfiguration(configuration: ConsoleConfiguration) {
  return Object.freeze({
    enabled: configuration.freshness.enabled,
    changeDebounceMs: configuration.freshness.changeDebounceMs,
    fallbackScanIntervalMs: configuration.freshness.fallbackScanIntervalMs,
    maxAffectedPerJob: configuration.freshness.maxAffectedPerJob,
  });
}

function verificationTimeoutMs(configuration: ConsoleConfiguration): number {
  return Math.min(60_000, Math.max(1_000, configuration.codeIntelligence.queryTimeoutMs * 5));
}

function consoleConfigurationHash(configuration: ConsoleConfiguration): string {
  return createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
}

function evolutionJobSnapshot(job: EvolutionJobProjection): JobSnapshot {
  const observedAt = job.updatedAt ?? job.createdAt ?? new Date().toISOString();
  const terminal = job.status === "SUCCEEDED" || job.status === "FAILED" || job.status === "CANCELLED";
  const reasonCode = job.status === "QUEUED" ? "JOB_QUEUED" : job.status === "RUNNING" ? "JOB_RUNNING"
    : job.status === "RETRY_WAIT" ? "JOB_RETRY_WAIT" : job.status === "SUCCEEDED" ? "JOB_SUCCEEDED"
      : job.status === "CANCELLED" ? "JOB_CANCELLED" : "JOB_FAILED";
  return Object.freeze({ schemaVersion: CONTROL_API_SCHEMA_VERSION, jobId: job.jobId, jobType: job.jobType,
    revision: job.revision, status: job.status, attempt: job.attempt, maxAttempts: job.maxAttempts, progress: job.progress,
    ...(job.createdAt === undefined ? {} : { createdAt: job.createdAt }),
    ...(job.updatedAt === undefined ? {} : { updatedAt: job.updatedAt }),
    ...(terminal ? { completedAt: observedAt } : {}),
    ...(job.nextAttemptAt === undefined ? {} : { nextAttemptAt: job.nextAttemptAt }),
    ...(job.lastFailure === undefined ? {} : { lastFailure: job.lastFailure }),
    reasonCode, observedAt, lastTransitionAt: observedAt, retryable: job.status === "RETRY_WAIT",
    evidenceRefs: [`evolution:${job.jobType.toLowerCase()}`] });
}

export class SidecarApplication {
  readonly #runtime: ZhiLoopDaemonRuntime;
  readonly #ledger: SqliteEventLedger;
  readonly #capture: CodexSessionCaptureService;
  readonly #hookHandler: CodexHookHandler;
  readonly #log: SafeDiagnosticLog;
  readonly #configuration: SqliteConfigurationService;
  readonly #acceptanceEvidence: SqliteRealCodexAcceptanceEvidenceStore;
  #acceptanceCoordinator: RealCodexAcceptanceCoordinator | undefined;
  #controlPlane: SidecarControlPlane | undefined;
  #p1Runtime: P1SidecarRuntime | undefined;
  #p2Runtime: P2SidecarRuntime | undefined;
  #p2Production: P2ProductionComposition | undefined;
  #p2Console: P2ConsoleRuntime | undefined;
  #p2AutomaticCompilation: P2AutomaticCompilationRuntime | undefined;
  #p2Evolution: P2EvolutionRuntime | undefined;
  #p3Console: P3SidecarConsole | undefined;
  #p4Active: P4ActiveSidecarRuntime | undefined;
  #p4Console: P4SidecarConsole | undefined;
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
      { projectEvent: projectCaptureEvent },
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
    this.#hookHandler = new CodexHookHandler({ sink: captureSink, spool: evidenceSpool });
    this.#runtime = new ZhiLoopDaemonRuntime({
      components: [{
        name: "conversation-ledger",
        start: async () => undefined,
        stop: async () => undefined,
        health: async () => ({ healthy: true }),
      }],
      hook: {
        handle: async (input) => {
          await this.#captureLegacyHook(input);
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
    let p2Runtime: P2SidecarRuntime | undefined;
    let p2Production: P2ProductionComposition | undefined;
    let p2AutomaticCompilation: P2AutomaticCompilationRuntime | undefined;
    let p2Evolution: P2EvolutionRuntime | undefined;
    let p2PreviewCoordinator: P2CandidatePreviewCoordinator | undefined;
    let p3Console: P3SidecarConsole | undefined;
    let p3CodexModelComposed = false;
    let p4Active: P4ActiveSidecarRuntime | undefined;
    let p4Console: P4SidecarConsole | undefined;
    try {
      acceptanceEvidence = new SqliteRealCodexAcceptanceEvidenceStore(join(dirname(config.ledgerPath), "real-codex-acceptance.sqlite"));
      configuration = new SqliteConfigurationService(join(dirname(config.ledgerPath), "configuration.sqlite"), {
        capabilities: () => ({
          "context.injection": p4Active === undefined ? "DISABLED" : "READY",
          "knowledge.retrieval": p3Console === undefined ? "DISABLED" : "READY",
          "knowledge.compile": p2Production === undefined ? "DISABLED" : "READY",
          "knowledge.evolution": (() => {
            const status = p2Evolution?.state().status;
            return status === undefined ? "NOT_CONFIGURED" : status === "STOPPED" ? "DISABLED" : status;
          })(),
          "codex.query": p3CodexModelComposed ? "READY" : "NOT_CONFIGURED",
          "knowledge.auto-publication": "NOT_CONFIGURED",
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
        }, {
          componentId: "p2-automatic-knowledge-compilation",
          prepare: async () => {
            if (p2AutomaticCompilation === undefined || p2PreviewCoordinator === undefined) {
              throw new Error("automatic knowledge compilation runtime is not composed");
            }
          },
          apply: async (next) => {
            if (p2AutomaticCompilation === undefined || p2PreviewCoordinator === undefined) {
              throw new Error("automatic knowledge compilation runtime is not composed");
            }
            return await p2AutomaticCompilation.applyConfiguration(
              knowledgeCompilationConfiguration(next),
              { ...p2PreviewCoordinator.pipelineIdentity(), configurationHash: consoleConfigurationHash(next) },
            ).then((rollback) => {
              composedApplication.#projectAutomaticCompilationCapability();
              return async () => { await rollback(); composedApplication.#projectAutomaticCompilationCapability(); };
            });
          },
        }, {
          componentId: "p2-knowledge-freshness",
          prepare: async () => {
            if (p2Evolution === undefined || p4Active === undefined) throw new Error("knowledge evolution runtime is not composed");
          },
          apply: async (next) => {
            if (p2Evolution === undefined || p2Production === undefined || p4Active === undefined) throw new Error("knowledge evolution runtime is not composed");
            const rollbackVerification = p2Production.applyVerificationConfiguration({
              codeGraphTimeoutMs: next.codeIntelligence.queryTimeoutMs,
              timeoutMs: verificationTimeoutMs(next),
            });
            let rollbackFreshness: (() => Promise<void>) | undefined;
            try {
              rollbackFreshness = await p2Evolution.applyConfiguration(freshnessSchedulerConfiguration(next));
              const rollbackGate = p4Active.applyFreshnessGateConfiguration({
                deadlineMs: Math.min(200, next.freshness.gateTimeoutMs),
                maxItems: config.knowledgeEvolution?.freshnessGateMaxItems ?? 100,
                maxTargetedItems: config.knowledgeEvolution?.freshnessGateMaxTargetedItems ?? 0,
                minimumTargetedBudgetMs: Math.min(config.knowledgeEvolution?.freshnessGateMinimumRemainingMs ?? 20,
                  Math.min(200, next.freshness.gateTimeoutMs)),
              });
              composedApplication.#projectEvolutionCapability();
              const rollbackIntake = rollbackFreshness;
              return async () => { rollbackGate(); await rollbackIntake(); rollbackVerification(); composedApplication.#projectEvolutionCapability(); };
            } catch (error) {
              await rollbackFreshness?.().catch(() => undefined);
              rollbackVerification();
              throw error;
            }
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
        operationalAlerts: () => p2Evolution?.listOperationalAlerts({ limit: 1_000 }).items ?? [],
        jobCommands: {
          cancelJob: async (request) => {
            if (p2Evolution?.getJob(request.jobId) !== undefined) return p2Evolution.cancel(request);
            if (p2Runtime?.hasJob(request.jobId) === true) return await p2Runtime.cancelJob(request);
            if (p1Runtime === undefined) throw new Error("P1 runtime is not composed");
            return await p1Runtime.cancelJob(request);
          },
          retryJob: async (request) => {
            if (p2Evolution?.getJob(request.jobId) !== undefined) return p2Evolution.retry(request);
            if (p2Runtime?.hasJob(request.jobId) === true) return await p2Runtime.retryJob(request);
            if (p1Runtime === undefined) throw new Error("P1 runtime is not composed");
            return await p1Runtime.retryJob(request);
          },
        },
        extraction: {
          handle: async (request) => {
            if (p2Runtime === undefined) throw new Error("P2 runtime is not composed");
            return await p2Runtime.handle(request);
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
      p2Production = await P2ProductionComposition.create({
        stateDirectory: dirname(config.ledgerPath),
        ledger,
        extraction: () => {
          if (p2Runtime === undefined) throw new Error("P2 extraction runtime is not composed");
          return p2Runtime.service();
        },
        compilerTimeoutMs: configuration.get().effective.future.codexQueryTimeoutMs,
        compilerBatchSize: configuration.get().effective.future.compilerBatchSize,
        evolutionMaxCandidates: configuration.get().effective.evolution.maxMatchCandidates,
        semanticJudgeEnabled: configuration.get().effective.evolution.semanticJudgeEnabled,
        codeGraphTimeoutMs: configuration.get().effective.codeIntelligence.queryTimeoutMs,
        verificationTimeoutMs: verificationTimeoutMs(configuration.get().effective),
        ...(config.codexQuery?.executable === undefined ? {} : { compilerExecutable: config.codexQuery.executable }),
        ...(config.codexQuery?.model === undefined ? {} : { compilerModel: config.codexQuery.model }),
        ...(config.codexQuery === undefined ? {} : { compilerIgnoreUserConfig: config.codexQuery.userConfiguration === "IGNORE" }),
      });
      p2Runtime = await P2SidecarRuntime.create({
        stateDirectory: dirname(config.ledgerPath),
        pollIntervalMs: configuration.get().effective.runtime.workerPollIntervalMs,
        projectJob: (snapshot) => {
          composedApplication.#controlPlane?.projectJob(snapshot);
          composedApplication.#projectSemanticEvolutionCapability();
        },
        knowledgeWorker: p2Production.worker,
        snapshotSource: {
          observe: async (request) => {
            const source = await composedApplication.#controlPlane?.inspectTranscriptSource(request.sessionId);
            if (source === undefined
              || source.transcriptIdentityHash !== request.transcriptIdentityHash
              || source.cursor.byteOffset !== request.cursor.byteOffset
              || source.cursor.lineNumber !== request.cursor.lineNumber) {
              throw new ExtractionStaleRevisionError("transcript identity or cursor changed before snapshot creation");
            }
            if (configuration?.get().hash !== request.configurationHash) {
              throw new ExtractionStaleRevisionError("configuration changed before snapshot creation");
            }
            const captureRevision = ledger.latestSequenceForSession(request.sessionId);
            const previousCandidate = p2Runtime?.service().listSnapshots({ sessionId: request.sessionId, limit: 1 }).items[0];
            const previous = previousCandidate !== undefined
              && previousCandidate.transcriptIdentityHash === request.transcriptIdentityHash
              && previousCandidate.compilerVersion === request.compilerVersion
              && previousCandidate.policyHash === request.policyHash
              && previousCandidate.configurationHash === request.configurationHash
              && previousCandidate.sourceSequence.to < request.sourceSequence.from
              ? previousCandidate
              : undefined;
            const sourceReferences: Array<{ eventId: string; turnId?: string; sourceSequence: number }> = [];
            if (!(request.sourceSequence.from === 0 && request.sourceSequence.to === 0)) {
              let after = Math.max(0, request.sourceSequence.from - 1);
              while (after < request.sourceSequence.to) {
                const records = ledger.readAfter(after, Math.min(1_000, request.sourceSequence.to - after));
                if (records.length === 0) break;
                for (const record of records) {
                  if (record.sequence > request.sourceSequence.to) break;
                  if (record.sequence >= request.sourceSequence.from && record.event.sessionId === request.sessionId) {
                    sourceReferences.push({
                      eventId: record.event.eventId,
                      sourceSequence: record.sequence,
                      ...(record.event.turnId === undefined ? {} : { turnId: record.event.turnId }),
                    });
                    if (sourceReferences.length > 10_000) throw new Error("snapshot source reference limit exceeded");
                  }
                }
                const last = records.at(-1);
                if (last === undefined || last.sequence <= after) break;
                after = last.sequence;
              }
            }
            if (!(request.sourceSequence.from === 0 && request.sourceSequence.to === 0)
              && (request.sourceSequence.from < 1 || request.sourceSequence.to > captureRevision)) {
              throw new ExtractionConflictError("snapshot source range is outside the Ledger revision");
            }
            const uncoveredEarlierStart = previous?.sourceSequence.to ?? 0;
            if (captureRevision - uncoveredEarlierStart > 1_000_000) {
              throw new ExtractionConflictError("snapshot validation exceeds the bounded Ledger scan window");
            }
            let uncoveredEarlier = false;
            let laterSessionEvent = false;
            for (let after = uncoveredEarlierStart, pages = 0;
              after < request.sourceSequence.from - 1 && pages < 1_000;
              pages += 1) {
              const records = ledger.readAfter(after, Math.min(1_000, request.sourceSequence.from - 1 - after));
              if (records.length === 0) break;
              if (records.some((record) => record.event.sessionId === request.sessionId)) uncoveredEarlier = true;
              const last = records.at(-1);
              if (last === undefined || last.sequence <= after) break;
              after = last.sequence;
            }
            for (let after = request.sourceSequence.to, pages = 0; after < captureRevision && pages < 1_000; pages += 1) {
              const records = ledger.readAfter(after, Math.min(1_000, captureRevision - after));
              if (records.length === 0) break;
              if (records.some((record) => record.event.sessionId === request.sessionId)) laterSessionEvent = true;
              const last = records.at(-1);
              if (last === undefined || last.sequence <= after) break;
              after = last.sequence;
            }
            const sourceClosed = !uncoveredEarlier && !laterSessionEvent && sourceReferences.length > 0
              && ledger.readAfter(sourceReferences.at(-1)!.sourceSequence - 1, 1)[0]?.event.eventType === "session.ended";
            const unsupportedEventTypes = source.ignoredRecords === 0 ? [] : ["unsupported_transcript_record"];
            if (request.completeness.sourceClosed !== sourceClosed
              || JSON.stringify([...request.completeness.unsupportedEventTypes].sort()) !== JSON.stringify(unsupportedEventTypes)) {
              throw new ExtractionConflictError("snapshot completeness does not match the inspected transcript");
            }
            return Object.freeze({
              captureRevision,
              sourceReferences,
              ...(previous === undefined ? {} : { previousSnapshotId: previous.snapshotId }),
              observedAt: new Date().toISOString(),
            });
          },
        },
      });
      composedApplication.#p2Runtime = p2Runtime;
      composedApplication.#p2Production = p2Production;
      p2PreviewCoordinator = new P2CandidatePreviewCoordinator({
        runtime: p2Runtime,
        ledger,
        inspectTranscriptSource: async (sessionId) => {
          const source = await composedApplication.#controlPlane?.inspectTranscriptSource(sessionId);
          if (source === undefined) throw new Error("Control plane is unavailable");
          return source;
        },
        configurationHash: () => configuration?.get().hash ?? "",
      });
      const evolutionConfiguration = normalizeP2EvolutionRuntimeConfiguration({
        ...config.knowledgeEvolution,
        enabled: config.knowledgeEvolution?.enabled ?? configuration.get().effective.freshness.enabled,
        changeDebounceMs: config.knowledgeEvolution?.changeDebounceMs ?? configuration.get().effective.freshness.changeDebounceMs,
        fallbackScanIntervalMs: config.knowledgeEvolution?.fallbackScanIntervalMs
          ?? configuration.get().effective.freshness.fallbackScanIntervalMs,
        maxAffectedPerJob: config.knowledgeEvolution?.maxAffectedPerJob ?? configuration.get().effective.freshness.maxAffectedPerJob,
        workerPollIntervalMs: config.knowledgeEvolution?.workerPollIntervalMs ?? configuration.get().effective.runtime.workerPollIntervalMs,
      });
      p2Evolution = new P2EvolutionRuntime({
        stateDirectory: dirname(config.ledgerPath), freshnessStore: p2Production.freshnessStore,
        production: p2Production, preview: p2PreviewCoordinator, p2Runtime, configuration: evolutionConfiguration,
        alertConfiguration: configuration.get().effective.evolutionAlerts,
        onJob: (job) => {
          composedApplication.#controlPlane?.projectJob(evolutionJobSnapshot(job));
          composedApplication.#projectEvolutionCapability();
        },
      });
      composedApplication.#p2Evolution = p2Evolution;
      const automaticAdapter = new P2DurableAutomaticCompilationAdapter(
        composedApplication.#controlPlane.sessionCatalog(),
        ledger,
        p2PreviewCoordinator,
        p2Evolution,
        evolutionConfiguration.maxAttempts,
      );
      p2AutomaticCompilation = new P2AutomaticCompilationRuntime({
        stateDirectory: dirname(config.ledgerPath),
        catalog: composedApplication.#controlPlane.sessionCatalog(),
        adapter: automaticAdapter,
        pipeline: p2PreviewCoordinator.pipelineIdentity(),
        configuration: {
          ...knowledgeCompilationConfiguration(configuration.get().effective),
          ...(config.automaticKnowledgeCompilation ?? {}),
        },
        onReport: (report) => {
          const code = report.diagnostics[0]?.code ?? (report.bounded ? "SESSION_SCAN_BOUNDED" : "COMPLETE");
          void composedApplication.#log.write({ component: "worker", code: `automatic-knowledge-compilation:${code}`, count: report.queuedSessions }).catch(() => undefined);
          composedApplication.#projectAutomaticCompilationCapability();
        },
      });
      composedApplication.#p2AutomaticCompilation = p2AutomaticCompilation;
      p2Runtime.setAutomaticCompilationStateProvider(() => p2AutomaticCompilation!.state());
      composedApplication.#p2Console = new P2ConsoleRuntime({
        runtime: p2Runtime,
        production: p2Production,
        ledger,
        inspectTranscriptSource: async (sessionId) => {
          const source = await composedApplication.#controlPlane?.inspectTranscriptSource(sessionId);
          if (source === undefined) throw new Error("Control plane is unavailable");
          return source;
        },
        configurationHash: () => configuration?.get().hash ?? "",
        previewCoordinator: p2PreviewCoordinator,
      });
      const stateDirectory = dirname(config.ledgerPath);
      const queryModel = config.codexQuery?.enabled === true
        ? await CodexExecKnowledgeQueryModel.create({
          cwd: stateDirectory,
          diagnostics: new InMemoryCodexKnowledgeQueryDiagnosticStore(100),
          timeoutMs: configuration.get().effective.future.codexQueryTimeoutMs,
          concurrency: configuration.get().effective.future.codexQueryConcurrency,
          maxQueue: configuration.get().effective.future.codexQueryConcurrency * 4,
          userConfiguration: config.codexQuery.userConfiguration,
          mcpConfiguration: "DISABLED",
          ...(config.codexQuery.executable === undefined ? {} : { executable: config.codexQuery.executable }),
          ...(config.codexQuery.model === undefined ? {} : { model: config.codexQuery.model }),
        })
        : undefined;
      p3CodexModelComposed = queryModel !== undefined;
      p3Console = new P3SidecarConsole({
        stateDirectory,
        registry: p2Production.registry,
        configuration: (projectId) => configuration!.get(projectId),
        drafts: () => configuration!.drafts(100),
        ...(queryModel === undefined ? {} : { model: queryModel }),
      });
      composedApplication.#p3Console = p3Console;
      composedApplication.#controlPlane.setP3RuntimeState(p3Console.capability);
      const retrievalComposition = createP4RetrievalComposition({ projection: p2Production.registry });
      const rolloutConfigFingerprint = `sha256:${configuration.get().hash}`;
      const rolloutVersionFingerprint = `sha256:${createHash("sha256").update(SIDECAR_VERSION, "utf8").digest("hex")}`;
      const rollout = new ActiveRolloutService(
        new FileRolloutStateStore(join(stateDirectory, "p4-rollout-state.json")),
        {
          policyRevision: 1,
          configFingerprint: rolloutConfigFingerprint,
          versionFingerprint: rolloutVersionFingerprint,
          now: new Date().toISOString(),
        },
      );
      const persistedRollout = rollout.state.effective;
      if (persistedRollout.mode === "ACTIVE"
        && (persistedRollout.configFingerprint !== rolloutConfigFingerprint
          || persistedRollout.versionFingerprint !== rolloutVersionFingerprint)) {
        rollout.downgrade("COMPOSITION_FINGERPRINT_CHANGED", new Date().toISOString());
      }
      p4Active = await P4ActiveSidecarRuntime.create({
        stateDirectory,
        p2: p2Production,
        retrieval: retrievalComposition.retrieval,
        authority: retrievalComposition.authority,
        orchestrator: new ContextOrchestrator(),
        rollout,
        captureUserPrompt: async (input) => { await composedApplication.#captureLegacyHook(input); },
        observeProject: ({ projectId, projectRoot }) => { p2Evolution?.observeProject(projectId, projectRoot); },
        scanProjectChanges: async () => { await p2Evolution?.trigger(); },
        liveKnowledgeRevisions: p2Evolution,
        freshnessCompensation: p2Evolution,
        freshnessGateDeadlineMs: config.knowledgeEvolution?.freshnessGateDeadlineMs
          ?? Math.min(200, configuration.get().effective.freshness.gateTimeoutMs),
        freshnessGateMaxItems: evolutionConfiguration.freshnessGateMaxItems,
        freshnessGateMaxTargetedItems: evolutionConfiguration.freshnessGateMaxTargetedItems,
        freshnessGateMinimumRemainingMs: Math.min(evolutionConfiguration.freshnessGateMinimumRemainingMs,
          config.knowledgeEvolution?.freshnessGateDeadlineMs ?? Math.min(200, configuration.get().effective.freshness.gateTimeoutMs)),
        closureEvidence: {
          load: async () => ({
            present: { taskContract: false, diff: false, tests: false, toolResults: false },
            interaction: { turnOrdinal: 1, history: [] },
          }),
        },
        contextDelta: { load: async () => ({ traceId: "trace-p4-no-explicit-delta", items: [] }) },
        confirmationEffects: { apply: async () => { throw new Error("confirmation effects are not configured"); } },
        injectionPolicy: () => ({
          ...structuredClone(DEFAULT_CONFIGURATION.injection),
          defaultMaxTokens: Math.min(4_000, configuration!.get().effective.future.injectionMaxTokens),
        }),
        prewarmPolicy: () => ({
          enabled: configuration!.get().effective.prewarm.enabled,
          onSessionStart: configuration!.get().effective.prewarm.onSessionStart,
          ttlMs: configuration!.get().effective.prewarm.ttlMs,
          maxItems: configuration!.get().effective.prewarm.maxItems,
          maxTokens: configuration!.get().effective.prewarm.maxTokens,
        }),
        userPromptDeadlineMs: 500,
      });
      composedApplication.#p4Active = p4Active;
      p4Console = await P4SidecarConsole.create({
        stateDirectory,
        feedback: p4Active.feedbackRuntime(),
        rollout,
        inspectEligibility: async (request) => await p4Active!.inspectKnowledgeEligibility(request),
        refreshContext: (sessionId) => p4Active!.refreshContext(sessionId),
      });
      composedApplication.#p4Console = p4Console;
      composedApplication.#controlPlane.setP4RuntimeState(p4Active.capabilities(), {
        closureEvidenceVerified: false,
      });
      return composedApplication;
    } catch (error) {
      p4Console?.close();
      p4Active?.close();
      p3Console?.close();
      await p2AutomaticCompilation?.close().catch(() => undefined);
      await p2Evolution?.close().catch(() => undefined);
      await p2Runtime?.close().catch(() => undefined);
      p2Production?.close();
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
      await this.#p2Runtime?.start();
      await this.#p2Evolution?.start();
      this.#projectEvolutionCapability();
      this.#p2AutomaticCompilation?.start();
      this.#projectAutomaticCompilationCapability();
      const p2State = this.#p2Runtime?.state();
      if (p2State !== undefined) this.#controlPlane?.setP2RuntimeReady(p2State.knowledgeCompile === "READY");
      this.#projectAutomaticCompilationCapability();
      if (await this.#p1Runtime?.start()) this.#controlPlane?.setAutomaticIngestionReady();
    } catch (error) {
      await this.#p2AutomaticCompilation?.stop().catch(() => undefined);
      await this.#p2Evolution?.close().catch(() => undefined);
      await this.#runtime.stop();
      throw error;
    }
  }

  async handleHook(input: unknown): Promise<string> {
    return (await this.handleHookForTransport(input)).hookOutput;
  }

  async handleHookForTransport(input: unknown): Promise<SidecarHookTransportResult> {
    const eventName = typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as { readonly hook_event_name?: unknown }).hook_event_name
      : undefined;
    let active: P4ActiveHookResult | undefined;
    let output: string;
    if (this.#p4Active !== undefined && (eventName === "UserPromptSubmit" || eventName === "Stop")) {
      if (eventName === "Stop") await this.#runtime.handleHook(input);
      active = await this.#p4Active.handleHook(input as Parameters<P4ActiveSidecarRuntime["handleHook"]>[0]);
      output = active.hookOutput ?? "";
    } else {
      output = await this.#runtime.handleHook(input);
    }
    // Start evidence persistence only after the Hook runtime has completed;
    // the returned Hook value never waits for SQLite acceptance writes.
    this.#flushAcceptanceEvidence();
    this.#scheduleWorker();
    const delivery = active?.hookEventName === "UserPromptSubmit" && active.status === "INJECTED"
      && active.attemptId !== undefined && output.length > 0
      ? {
          attemptId: active.attemptId,
          expectedRevision: 1 as const,
          alreadyAcknowledged: active.deliveryAcknowledged === true,
        }
      : undefined;
    return Object.freeze({
      schemaVersion: 1 as const,
      hookOutput: output,
      ...(delivery === undefined ? {} : { delivery: Object.freeze(delivery) }),
    });
  }

  #scheduleWorker(): void {
    this.#workerTail = this.#workerTail
      .then(async () => { await this.#runtime.runWorkerOnce(); })
      .catch(() => undefined);
  }

  async #captureLegacyHook(input: unknown): Promise<HookCaptureResult> {
    const capture = await this.#hookHandler.handle(input);
    await this.#log.write({ component: "hook", code: captureCode(capture), durationMs: capture.durationMs }).catch(() => undefined);
    return capture;
  }

  async handleMcp(request: VersionedMcpRequest, signal?: AbortSignal) {
    if (this.#p4Active === undefined) throw Object.assign(new Error("P4 MCP runtime is unavailable"), { code: "CAPABILITY_UNAVAILABLE" });
    return await this.#p4Active.handleMcp(request, signal);
  }

  acknowledgeInjectionDelivery(request: {
    readonly attemptId: string;
    readonly expectedRevision: number;
    readonly deliveryEvidenceRef: string;
    readonly deliveredAt: string;
  }) {
    if (this.#p4Active === undefined) throw Object.assign(new Error("P4 injection runtime is unavailable"), { code: "CAPABILITY_UNAVAILABLE" });
    return this.#p4Active.acknowledgeDelivery(request);
  }

  async runWorkerOnce(): Promise<DaemonWorkerCycle> {
    const cycle = await this.#runtime.runWorkerOnce();
    await this.#p2Runtime?.runJobWorkerOnce();
    return cycle;
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

  async handleControl(request: ControlRequest | P2ControlRequest): Promise<ControlResponse> {
    if (!this.#controlPlane) throw new Error("control plane is not initialized");
    return this.#controlPlane.handle(request);
  }

  async handleP2Console(request: P2ConsoleRequest): Promise<ControlResponse> {
    const observedAt = new Date().toISOString();
    try {
      if (this.#p2Console === undefined) throw Object.assign(new Error("P2 Console is unavailable"), { code: "CAPABILITY_UNAVAILABLE" });
      return { schemaVersion: CONTROL_API_SCHEMA_VERSION, requestId: request.requestId, observedAt, ok: true, result: await this.#p2Console.handle(request) };
    } catch (error) {
      const raw = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "INTERNAL_ERROR";
      const code = raw === "NOT_FOUND" ? "NOT_FOUND"
        : raw === "STALE_REVISION" ? "STALE_REVISION"
          : raw === "CONFLICT" || raw === "MANUAL_MARKDOWN_CONFLICT" || raw === "PROJECTION_NOT_CURRENT" ? "CONFLICT"
            : raw === "INVALID_REQUEST" || raw === "REVALIDATION_FAILED" || raw === "RESTORE_REVALIDATION_FAILED" ? "INVALID_REQUEST"
              : raw === "CAPABILITY_UNAVAILABLE" || raw === "HIGH_RISK_GOVERNANCE_DISABLED" ? "CAPABILITY_UNAVAILABLE"
                : "INTERNAL_ERROR";
      return {
        schemaVersion: CONTROL_API_SCHEMA_VERSION,
        requestId: request.requestId,
        observedAt,
        ok: false,
        error: { code, message: "P2 Console request failed", retryable: raw === "OUTBOX_FAILED" },
      };
    }
  }

  async handleP3Console(request: P3ConsoleTransportRequest, signal?: AbortSignal): Promise<ControlResponse> {
    const observedAt = new Date().toISOString();
    try {
      if (this.#p3Console === undefined) throw Object.assign(new Error("P3 Console is unavailable"), { code: "CAPABILITY_UNAVAILABLE" });
      return {
        schemaVersion: CONTROL_API_SCHEMA_VERSION,
        requestId: request.requestId,
        observedAt,
        ok: true,
        result: await this.#p3Console.handle(request, signal),
      };
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      const code = name === "P3SemanticConflictError" ? "CONFLICT"
        : name === "P3TraceUnavailableError" ? "NOT_FOUND"
          : name === "P3RequestCancelledError" ? "SIDECAR_UNAVAILABLE"
            : name === "P3PolicyConsumerUnavailableError" ? "CAPABILITY_UNAVAILABLE"
              : error instanceof Error && "code" in error && error.code === "CAPABILITY_UNAVAILABLE"
                ? "CAPABILITY_UNAVAILABLE"
                : "INTERNAL_ERROR";
      return {
        schemaVersion: CONTROL_API_SCHEMA_VERSION,
        requestId: request.requestId,
        observedAt,
        ok: false,
        error: { code, message: "P3 Console request failed", retryable: code === "SIDECAR_UNAVAILABLE" },
      };
    }
  }

  async handleP4Console(request: P4ConsoleTransportRequest, signal?: AbortSignal): Promise<ControlResponse> {
    if (this.#p4Console === undefined) {
      return {
        schemaVersion: CONTROL_API_SCHEMA_VERSION,
        requestId: request.requestId,
        observedAt: new Date().toISOString(),
        ok: false,
        error: { code: "CAPABILITY_UNAVAILABLE", message: "P4 Console request failed", retryable: false },
      };
    }
    return await this.#p4Console.handle(request, signal);
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
    const rolloutMode = this.#p4Active?.capabilities().injection.mode ?? "SHADOW";
    return Object.freeze({ ...(await this.#runtime.health()), rolloutMode, socketStatus: "READY",
      knowledgeEvolution: this.#p2Evolution?.state() ?? Object.freeze({ status: "NOT_CONFIGURED" as const }) });
  }

  automaticCompilationState() {
    return this.#p2AutomaticCompilation?.state() ?? Object.freeze({ automaticCompile: "DISABLED" as const });
  }

  #projectEvolutionCapability(): void {
    const status = this.#p2Evolution?.state().status;
    if (status !== undefined && status !== "STOPPED") this.#controlPlane?.setKnowledgeEvolutionState(status);
    this.#projectSemanticEvolutionCapability();
  }

  #projectSemanticEvolutionCapability(): void {
    const capability = this.#p2Production?.semanticEvolutionCapability();
    if (capability !== undefined) this.#controlPlane?.setSemanticEvolutionState(capability.status, capability.reasonCode);
  }

  #projectAutomaticCompilationCapability(): void {
    const status = this.#p2AutomaticCompilation?.state().automaticCompile;
    if (status === undefined || status === "STOPPED") return;
    this.#controlPlane?.setAutomaticKnowledgeCompilationState(status);
  }

  async triggerAutomaticKnowledgeCompilation() {
    if (this.#p2AutomaticCompilation === undefined) throw new Error("automatic knowledge compilation is not composed");
    return await this.#p2AutomaticCompilation.trigger();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#captureTail;
    await this.#workerTail;
    await this.#p1Runtime?.close();
    await this.#p2AutomaticCompilation?.close();
    await this.#p2Evolution?.close();
    await this.#p2Runtime?.close();
    this.#p4Console?.close();
    this.#p4Active?.close();
    this.#p3Console?.close();
    this.#p2Production?.close();
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
