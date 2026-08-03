import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, opendir, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import type { CaptureSessionReport, CaptureSessionRequest, TranscriptCursor } from "@zhiloop/codex-session-capture";
import {
  CONTROL_API_SCHEMA_VERSION,
  type CapabilitySnapshot,
  type CaptureCommitResult,
  type CapturePreview,
  type ControlRequest,
  type ControlResponse,
  type Diagnostics,
  type EventMetadata,
  type JobCommandResult,
  type JobSnapshot,
  type P2ControlRequest,
  type SessionSummary,
  type StageSnapshot,
  eventMetadataSchema,
} from "@zhiloop/control-api";
import type { SqliteConfigurationService } from "@zhiloop/configuration-service";
import { createCursorCodec, type CursorCodec } from "@zhiloop/control-api/server";
import type { LedgerEventRecord, SqliteEventLedger } from "@zhiloop/conversation-ledger";
import {
  InvalidOperationalCursorError,
  SqliteOperationalReadModel,
  type PageRequest,
} from "@zhiloop/operational-read-model";
import {
  AppServerSessionCatalogSource,
  ReadOnlySessionCatalog,
  TranscriptSessionCatalogSource,
  type CapturedSessionState,
  type SessionCaptureProjectionPort,
  type SessionCatalogEntry,
} from "@zhiloop/session-catalog";
import { evaluateAlerts, type PreviousAlertState } from "@zhiloop/observability";
import {
  JobIdempotencyConflictError,
  JobNotFoundError,
  JobStaleRevisionError,
  JobStateConflictError,
} from "@zhiloop/job-runtime";
import {
  ExtractionConflictError,
  ExtractionNotFoundError,
  ExtractionStaleRevisionError,
} from "@zhiloop/session-extraction";

import type { SidecarConfig } from "./config.js";
import type { SidecarHealthReport } from "./application.js";
import { SIDECAR_VERSION } from "./metadata.js";

const PREVIEW_TTL_MS = 5 * 60_000;
const MAX_PREVIEWS = 1_000;
const MAX_IDEMPOTENCY_RESULTS = 5_000;
const MAX_SPOOL_DEPTH_SCAN = 100_000;
const PROJECTION_BATCH_SIZE = 500;
const SESSION_CURSOR_FILTER = createHash("sha256").update("control.sessions.v1").digest("hex");

interface MutableCaptureState {
  eventCount: number;
  readonly turnIds: Set<string>;
  ignoredRecords: number;
  redactionCount: number;
  current: boolean;
}

interface StoredPreview {
  readonly value: CapturePreview;
  readonly transcriptPath: string;
  readonly signature: string;
}

interface StoredCommit {
  readonly fingerprint: string;
  readonly result: CaptureCommitResult;
}

export interface CaptureExecutionPort {
  capture(request: CaptureSessionRequest): Promise<CaptureSessionReport>;
  transaction<T>(operation: (capture: (request: CaptureSessionRequest) => Promise<CaptureSessionReport>) => Promise<T>): Promise<T>;
}

export interface JobCommandExecutionPort {
  cancelJob(request: { readonly jobId: string; readonly expectedRevision: number; readonly idempotencyKey: string }): Promise<JobCommandResult>;
  retryJob(request: { readonly jobId: string; readonly expectedRevision: number; readonly idempotencyKey: string }): Promise<JobCommandResult>;
}

export interface P2ControlExecutionPort {
  handle(request: P2ControlRequest): Promise<unknown>;
}

export interface SidecarControlPlaneOptions {
  readonly config: SidecarConfig;
  readonly ledger: SqliteEventLedger;
  readonly capture: CaptureExecutionPort;
  readonly health: () => Promise<SidecarHealthReport>;
  readonly configuration?: SqliteConfigurationService;
  readonly jobCommands?: JobCommandExecutionPort;
  readonly extraction?: P2ControlExecutionPort;
  readonly clock?: () => Date;
}

class ControlPlaneError extends Error {
  public constructor(public readonly code: "NOT_FOUND" | "STALE_REVISION" | "CONFLICT" | "CAPABILITY_UNAVAILABLE" | "INVALID_CURSOR") {
    super(code);
    this.name = "ControlPlaneError";
  }
}

type ControlFailureCode = "NOT_FOUND" | "STALE_REVISION" | "CONFLICT" | "CAPABILITY_UNAVAILABLE" | "INVALID_CURSOR" | "INVALID_REQUEST" | "INTERNAL_ERROR";

function errorResponse(requestId: string, supported: ControlFailureCode, observedAt: string): ControlResponse {
  return {
    schemaVersion: CONTROL_API_SCHEMA_VERSION,
    requestId,
    observedAt,
    ok: false,
    error: {
      code: supported,
      message: supported === "NOT_FOUND"
        ? "Requested resource was not found"
        : supported === "STALE_REVISION"
          ? "Expected revision is stale; refresh current state"
          : supported === "CONFLICT"
            ? "Idempotency key conflicts with an earlier command"
            : supported === "CAPABILITY_UNAVAILABLE"
              ? "Capability is not available in this release"
            : supported === "INVALID_CURSOR"
                ? "Cursor is invalid or does not match this query"
                : supported === "INVALID_REQUEST"
                  ? "Control request is invalid"
                : "Control request failed",
      retryable: supported === "STALE_REVISION",
    },
  };
}

function operationalPage(page: { readonly limit: number; readonly cursor?: string | undefined } | undefined): PageRequest | undefined {
  if (page === undefined) return undefined;
  return page.cursor === undefined ? { limit: page.limit } : { limit: page.limit, cursor: page.cursor };
}

function successResponse(requestId: string, result: unknown, observedAt: string): ControlResponse {
  return { schemaVersion: CONTROL_API_SCHEMA_VERSION, requestId, observedAt, ok: true, result };
}

function timestamp(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error("control clock returned an invalid date");
  return value.toISOString();
}

function summary(entry: SessionCatalogEntry): SessionSummary {
  return {
    schemaVersion: CONTROL_API_SCHEMA_VERSION,
    sessionId: entry.sessionId,
    title: entry.title,
    source: entry.source,
    sourceStatus: entry.sourceStatus,
    ...(entry.sourceVersion === undefined ? {} : { sourceVersion: entry.sourceVersion }),
    captureStatus: entry.captureStatus,
    ...(entry.projectHint === undefined ? {} : { projectHint: entry.projectHint }),
    ...(entry.cwdAlias === undefined ? {} : { cwdAlias: entry.cwdAlias }),
    firstActivityAt: entry.firstActivityAt,
    lastActivityAt: entry.lastActivityAt,
    eventCount: entry.eventCount,
    turnCount: entry.turnCount,
    ignoredRecords: entry.ignoredRecords,
    redactionCount: entry.redactionCount,
  };
}

function eventMetadata(record: LedgerEventRecord): EventMetadata {
  const contentHash = /^[a-f0-9]{64}$/u.test(record.event.contentHash)
    ? record.event.contentHash
    : createHash("sha256").update(`legacy-content-hash:${record.event.contentHash}`).digest("hex");
  return {
    schemaVersion: CONTROL_API_SCHEMA_VERSION,
    sequence: record.sequence,
    eventId: record.event.eventId,
    eventType: record.event.eventType,
    source: record.event.source,
    sessionId: record.event.sessionId,
    ...(record.event.turnId === undefined ? {} : { turnId: record.event.turnId }),
    occurredAt: record.event.occurredAt,
    correlationId: record.event.correlationId,
    contentHash,
    redactionCount: record.redactionCount,
    payloadPurged: record.payloadPurged,
  };
}

function capability(
  capabilityId: string,
  status: CapabilitySnapshot["status"],
  reasonCode: CapabilitySnapshot["reasonCode"],
  observedAt: string,
  retryable = false,
  nextAction?: string,
): CapabilitySnapshot {
  return {
    schemaVersion: CONTROL_API_SCHEMA_VERSION,
    capabilityId,
    status,
    reasonCode,
    observedAt,
    lastTransitionAt: observedAt,
    retryable,
    evidenceRefs: [],
    ...(nextAction === undefined ? {} : { nextAction }),
  };
}

function previewSignature(report: CaptureSessionReport): string {
  return createHash("sha256").update(JSON.stringify({
    sessionId: report.sessionId,
    projectedEvents: report.projectedEvents,
    ignoredRecords: report.ignoredRecords,
    eventTypes: report.eventTypes,
    cursor: report.cursor,
    hasMore: report.hasMore,
  })).digest("hex");
}

async function loadOrCreateSecret(path: string): Promise<Buffer> {
  try {
    const created = await open(path, "wx", 0o600);
    try {
      const value = randomBytes(32);
      await created.writeFile(value);
      await created.sync();
      return value;
    } finally {
      await created.close();
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const existing = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await existing.stat();
    if (!metadata.isFile() || metadata.size !== 32) throw new Error("control cursor secret is invalid");
    if (process.platform !== "win32") {
      if ((metadata.mode & 0o077) !== 0) throw new Error("control cursor secret permissions are too broad");
      if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
        throw new Error("control cursor secret owner is invalid");
      }
    }
    const value = await existing.readFile();
    if (value.byteLength !== 32) throw new Error("control cursor secret changed during read");
    return value;
  } finally {
    await existing.close();
  }
}

export class SidecarControlPlane {
  readonly #config: SidecarConfig;
  readonly #ledger: SqliteEventLedger;
  readonly #capture: CaptureExecutionPort;
  readonly #health: () => Promise<SidecarHealthReport>;
  readonly #configuration: SqliteConfigurationService | undefined;
  readonly #jobCommands: JobCommandExecutionPort | undefined;
  readonly #extraction: P2ControlExecutionPort | undefined;
  readonly #clock: () => Date;
  readonly #readModel: SqliteOperationalReadModel;
  readonly #catalog: ReadOnlySessionCatalog;
  readonly #cursorCodec: CursorCodec;
  readonly #captureStates: Map<string, MutableCaptureState>;
  readonly #previews = new Map<string, StoredPreview>();
  readonly #commits = new Map<string, StoredCommit>();
  #lastProjectedSequence = 0;
  #previewRevision = 0;
  #commitTail: Promise<void> = Promise.resolve();
  #projectionTail: Promise<void> = Promise.resolve();
  #closed = false;
  readonly #monitoringSinceAt: string;
  #lastHookEventAt: string | undefined;
  #previousAlerts: readonly PreviousAlertState[] = [];
  #alertCount = 0;
  #p2KnowledgeConfigured = false;

  private constructor(
    options: SidecarControlPlaneOptions,
    readModel: SqliteOperationalReadModel,
    catalog: ReadOnlySessionCatalog,
    cursorCodec: CursorCodec,
    captureStates: Map<string, MutableCaptureState>,
  ) {
    this.#config = options.config;
    this.#ledger = options.ledger;
    this.#capture = options.capture;
    this.#health = options.health;
    this.#configuration = options.configuration;
    this.#jobCommands = options.jobCommands;
    this.#extraction = options.extraction;
    this.#clock = options.clock ?? (() => new Date());
    this.#readModel = readModel;
    this.#catalog = catalog;
    this.#cursorCodec = cursorCodec;
    this.#captureStates = captureStates;
    this.#monitoringSinceAt = timestamp(this.#clock);
  }

  public static async create(options: SidecarControlPlaneOptions): Promise<SidecarControlPlane> {
    const stateDirectory = dirname(options.config.ledgerPath);
    const secret = await loadOrCreateSecret(join(stateDirectory, "control-cursor.key"));
    const captureStates = new Map<string, MutableCaptureState>();
    const projection: SessionCaptureProjectionPort = {
      getMany: async (sessionIds) => new Map(sessionIds.flatMap((sessionId) => {
        const state = captureStates.get(sessionId);
        if (!state) return [];
        const value: CapturedSessionState = {
          current: state.current,
          eventCount: state.eventCount,
          turnCount: state.turnIds.size,
          ignoredRecords: state.ignoredRecords,
          redactionCount: state.redactionCount,
        };
        return [[sessionId, value] as const];
      })),
    };
    const catalog = new ReadOnlySessionCatalog(
      new AppServerSessionCatalogSource(),
      new TranscriptSessionCatalogSource(options.config.codexSessionsRoot),
      { captureProjection: projection, ...(options.clock === undefined ? {} : { clock: options.clock }) },
    );
    const readModel = new SqliteOperationalReadModel(join(stateDirectory, "operational.sqlite"), {
      cursorSecret: secret,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    const control = new SidecarControlPlane(options, readModel, catalog, createCursorCodec(secret), captureStates);
    control.#initialize();
    return control;
  }

  #initialize(): void {
    const capabilities = this.#baseCapabilities(timestamp(this.#clock));
    for (const value of capabilities) this.#readModel.projectCapability(value);
    const initialization = new Promise<void>((resolvePromise) => setImmediate(resolvePromise)).then(async () => {
      await this.#restoreProjectionState();
      await this.#projectThrough(this.#ledger.count());
    });
    this.#projectionTail = initialization.then(
      () => undefined,
      () => {
        this.#readModel.projectOperatorDiagnostic({
          diagnosticId: "ledger-projection-initialization",
          component: "sidecar.control-plane",
          code: "LEDGER_PROJECTION_RETRY_REQUIRED",
          severity: "WARNING",
          observedAt: timestamp(this.#clock),
          retryable: true,
          evidenceRefs: ["ledger:projection"],
        });
      },
    );
  }

  #baseCapabilities(observedAt: string): CapabilitySnapshot[] {
    return [
      capability("conversation.capture", "READY", "COMPONENT_READY", observedAt),
      capability("codex.live-hook", "NOT_VERIFIED", "CAPABILITY_NOT_VERIFIED", observedAt, false, "Validate a newly created Codex task"),
      capability("session.catalog", "STARTING", "COMPONENT_STARTING", observedAt),
      capability("durable.jobs", "STARTING", "COMPONENT_STARTING", observedAt),
      capability("automatic.ingestion", "STARTING", "COMPONENT_STARTING", observedAt),
      capability("configuration", "READY", "COMPONENT_READY", observedAt),
      capability("observability.alerts", "READY", "COMPONENT_READY", observedAt),
      capability("session.relations", "NOT_CONFIGURED", "CAPABILITY_NOT_CONFIGURED", observedAt, false, "Compose an observable parent/child relation source"),
      capability("session.extraction", "STARTING", "COMPONENT_STARTING", observedAt),
      capability("knowledge.provenance", "STARTING", "COMPONENT_STARTING", observedAt),
      capability("knowledge.compile", "STARTING", "COMPONENT_STARTING", observedAt),
      capability("knowledge.governance", "STARTING", "COMPONENT_STARTING", observedAt),
      capability("knowledge.automatic-compile", "DISABLED", "CAPABILITY_DISABLED", observedAt, false, "Manual extraction is the only enabled SHADOW trigger"),
      capability("knowledge.retrieval", "DISABLED", "CAPABILITY_DISABLED", observedAt, false, "Compose the retrieval runtime"),
      capability("context.injection", "DISABLED", "CAPABILITY_DISABLED", observedAt, false, "Complete SHADOW quality gates before injection"),
      capability("knowledge.mcp", "DISABLED", "MCP_TRANSPORT_NOT_ENABLED", observedAt, false, "Enable the local knowledge MCP transport"),
      capability("closure.verification", "DISABLED", "STOP_VERIFIER_NOT_COMPOSED", observedAt, false, "Compose the Stop closure verifier"),
      capability("active.rollout", "DISABLED", "ACTIVE_ROLLOUT_NOT_ELIGIBLE", observedAt, false, "Pass SHADOW eligibility gates"),
    ];
  }

  #stateFor(sessionId: string): MutableCaptureState {
    let state = this.#captureStates.get(sessionId);
    if (!state) {
      state = { eventCount: 0, turnIds: new Set(), ignoredRecords: 0, redactionCount: 0, current: false };
      this.#captureStates.set(sessionId, state);
    }
    return state;
  }

  #recordLedgerState(record: LedgerEventRecord): void {
    const state = this.#stateFor(record.event.sessionId);
    state.eventCount += 1;
    if (record.event.turnId !== undefined) state.turnIds.add(record.event.turnId);
    state.redactionCount += record.redactionCount;
    if (record.event.source === "codex-hook" && (this.#lastHookEventAt === undefined || record.event.occurredAt > this.#lastHookEventAt)) {
      this.#lastHookEventAt = record.event.occurredAt;
    }
  }

  async #restoreProjectionState(): Promise<void> {
    const persistedSequence = this.#readModel.latestEventSequence();
    let sequence = 0;
    while (sequence < persistedSequence) {
      const records = this.#ledger.readAfter(sequence, PROJECTION_BATCH_SIZE)
        .filter((record) => record.sequence <= persistedSequence);
      if (records.length === 0) break;
      for (const record of records) this.#recordLedgerState(record);
      sequence = records.at(-1)?.sequence ?? sequence;
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    }
    this.#lastProjectedSequence = sequence;
  }

  async #projectBatch(): Promise<number> {
    const records = this.#ledger.readAfter(this.#lastProjectedSequence, PROJECTION_BATCH_SIZE);
    if (records.length === 0) return 0;
    const projected: EventMetadata[] = [];
    for (const record of records) {
      const parsed = eventMetadataSchema.safeParse(eventMetadata(record));
      if (parsed.success) {
        projected.push(parsed.data);
      } else {
        this.#readModel.projectOperatorDiagnostic({
          diagnosticId: `ledger-projection-${record.sequence}`,
          component: "sidecar.control-plane",
          code: "EVENT_METADATA_UNSUPPORTED",
          severity: "WARNING",
          observedAt: timestamp(this.#clock),
          retryable: false,
          evidenceRefs: [`ledger-sequence:${record.sequence}`],
        });
      }
    }
    this.#readModel.projectEventMetadataBatch(projected);
    for (const record of records) this.#recordLedgerState(record);
    this.#lastProjectedSequence = records.at(-1)?.sequence ?? this.#lastProjectedSequence;
    return records.length;
  }

  async #projectThrough(targetSequence: number): Promise<void> {
    while (this.#lastProjectedSequence < targetSequence) {
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      if (await this.#projectBatch() === 0) return;
    }
  }

  public scheduleLedgerProjection(): Promise<void> {
    const targetSequence = this.#ledger.count();
    const operation = this.#projectionTail.then(async () => await this.#projectThrough(targetSequence));
    this.#projectionTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  public sessionCatalog(): Pick<ReadOnlySessionCatalog, "list" | "get"> {
    return this.#catalog;
  }

  public projectJob(snapshot: JobSnapshot): void {
    this.#readModel.projectJob(snapshot);
  }

  public projectCapabilitySnapshot(snapshot: CapabilitySnapshot): void {
    this.#readModel.projectCapability(snapshot);
  }

  public setAutomaticIngestionReady(): void {
    const observedAt = timestamp(this.#clock);
    this.#readModel.projectCapability(capability("durable.jobs", "READY", "COMPONENT_READY", observedAt));
    this.#readModel.projectCapability(capability("automatic.ingestion", "READY", "COMPONENT_READY", observedAt));
  }

  public setP2RuntimeReady(knowledgeConfigured: boolean): void {
    this.#p2KnowledgeConfigured = knowledgeConfigured;
    const observedAt = timestamp(this.#clock);
    this.#readModel.projectCapability(capability("session.extraction", "READY", "COMPONENT_READY", observedAt));
    this.#readModel.projectCapability(capability("knowledge.provenance", "READY", "COMPONENT_READY", observedAt));
    this.#readModel.projectCapability(knowledgeConfigured
      ? capability("knowledge.compile", "READY", "COMPONENT_READY", observedAt)
      : capability("knowledge.compile", "NOT_CONFIGURED", "CAPABILITY_NOT_CONFIGURED", observedAt, false, "Configure the production knowledge worker"));
    this.#readModel.projectCapability(knowledgeConfigured
      ? capability("knowledge.governance", "READY", "COMPONENT_READY", observedAt)
      : capability("knowledge.governance", "NOT_CONFIGURED", "CAPABILITY_NOT_CONFIGURED", observedAt, false, "Configure the production knowledge stores"));
    this.#readModel.projectCapability(capability(
      "knowledge.automatic-compile",
      "DISABLED",
      "CAPABILITY_DISABLED",
      observedAt,
      false,
      "Manual extraction is the only enabled SHADOW trigger",
    ));
  }

  async #refreshSession(sessionId: string): Promise<SessionSummary | undefined> {
    const entry = await this.#catalog.get(sessionId);
    if (!entry) return undefined;
    const value = summary(entry);
    const cursor = this.#ledger.loadIngestionCursor<TranscriptCursor>(`codex-transcript:${sessionId}`);
    this.#readModel.projectSession({
      summary: value,
      ...(cursor === undefined ? {} : {
        latestCursor: {
          byteOffset: cursor.cursor.byteOffset,
          lineNumber: cursor.cursor.lineNumber,
          observedAt: cursor.updatedAt,
        },
      }),
    });
    return value;
  }

  async #listSessions(request: Extract<ControlRequest, { type: "sessions.list" }>): Promise<{ items: SessionSummary[]; nextCursor?: string }> {
    let after: { lastActivityAt: string; sessionId: string } | undefined;
    const cursor = request.page?.cursor;
    if (cursor !== undefined) {
      try {
        const decoded = this.#cursorCodec.decode(cursor);
        if (decoded.filterHash !== SESSION_CURSOR_FILTER) throw new Error("filter mismatch");
        if (Number.isNaN(Date.parse(decoded.sortKey)) || /[\0\r\n/\\]/u.test(decoded.tieBreaker)) throw new Error("invalid position");
        after = { lastActivityAt: decoded.sortKey, sessionId: decoded.tieBreaker };
      } catch {
        throw new ControlPlaneError("INVALID_CURSOR");
      }
    }
    const listed = await this.#catalog.list({
      limit: request.page?.limit ?? 50,
      ...(after === undefined ? {} : { after }),
    });
    const transcript = listed.sourceCapabilities.find((item) => item.source === "CODEX_TRANSCRIPT");
    const status = transcript?.status === "AVAILABLE" ? "READY" : "DEGRADED";
    this.#readModel.projectCapability(capability(
      "session.catalog",
      status,
      status === "READY" ? "COMPONENT_READY" : "SOURCE_UNAVAILABLE",
      timestamp(this.#clock),
      status !== "READY",
    ));
    const items = listed.items.map(summary);
    for (const item of items) this.#readModel.projectSession({ summary: item });
    const next = listed.nextPosition;
    return {
      items,
      ...(next === undefined ? {} : {
        nextCursor: this.#cursorCodec.encode({
          version: 1,
          sortKey: next.lastActivityAt,
          tieBreaker: next.sessionId,
          filterHash: SESSION_CURSOR_FILTER,
        }),
      }),
    };
  }

  async #diagnostics(): Promise<Diagnostics> {
    let spoolDepth = 0;
    let oldestSpoolAgeMs = 0;
    let spoolReadable = true;
    const observedAt = timestamp(this.#clock);
    const alertConfiguration = this.#configuration?.get().effective.runtime.alerts;
    try {
      const directory = await opendir(this.#config.spoolPath);
      for await (const entry of directory) {
        if (entry.isFile() && entry.name.endsWith(".json")) {
          spoolDepth += 1;
          if (alertConfiguration !== undefined && spoolDepth <= alertConfiguration.spoolDepth.error) {
            const metadata = await stat(join(this.#config.spoolPath, entry.name));
            oldestSpoolAgeMs = Math.max(oldestSpoolAgeMs, Math.max(0, Date.parse(observedAt) - metadata.mtimeMs));
          }
        }
        if (spoolDepth >= MAX_SPOOL_DEPTH_SCAN) break;
      }
    } catch {
      spoolDepth = 0;
      spoolReadable = false;
      this.#readModel.projectOperatorDiagnostic({
        diagnosticId: "spool-unavailable",
        component: "sidecar.control-plane",
        code: "SPOOL_UNAVAILABLE",
        severity: "ERROR",
        observedAt: timestamp(this.#clock),
        retryable: true,
        evidenceRefs: ["spool:unreadable"],
      });
    }
    const [health, storage] = await Promise.all([this.#health(), stat(this.#config.ledgerPath)]);
    const lastCycle = health.lastWorkerCycle;
    const jobs = this.#readModel.getOverview({ observedAt, rolloutMode: "SHADOW", sidecarVersion: SIDECAR_VERSION, alertCount: this.#alertCount }).jobs;
    const alerts = alertConfiguration === undefined ? undefined : evaluateAlerts({
      schemaVersion: 1,
      notificationsEnabled: alertConfiguration.enabled && alertConfiguration.notify,
      notificationMinimumSeverity: alertConfiguration.minimumSeverity,
      spool: { enabled: true, depth: alertConfiguration.spoolDepth, oldestAgeMs: alertConfiguration.spoolOldestAgeMs },
      cursor: { enabled: true, lagEvents: alertConfiguration.cursorLagEvents },
      failedJobs: { enabled: true, count: alertConfiguration.failedJobs },
      hookSilence: { enabled: true, ageMs: alertConfiguration.hookSilenceMs },
      quietHours: alertConfiguration.quietHours,
    }, {
      schemaVersion: 1,
      observedAt,
      spool: { depth: spoolDepth, oldestAgeMs: oldestSpoolAgeMs },
      cursors: [],
      jobs: { failedCount: jobs.failed },
      hook: {
        expected: true,
        monitoringSinceAt: this.#monitoringSinceAt,
        ...(this.#lastHookEventAt === undefined ? {} : { lastEventAt: this.#lastHookEventAt }),
      },
    }, this.#previousAlerts);
    if (alerts !== undefined) {
      this.#previousAlerts = Object.freeze(alerts.activeAlerts.map((alert) => Object.freeze({
        dedupeKey: alert.dedupeKey,
        severity: alert.severity,
        reasonCodes: alert.reasonCodes,
        notificationPending: alert.notificationPending,
        notificationDelivered: alert.notificationDelivered,
      })));
      this.#alertCount = alerts.activeAlerts.length;
    }
    const alertView = alerts === undefined ? undefined : {
      ...alerts,
      activeAlerts: alerts.activeAlerts.map((alert) => ({ ...alert, reasonCodes: [...alert.reasonCodes] })),
      transitions: alerts.transitions.map((transition) => ({ ...transition, reasonCodes: [...transition.reasonCodes] })),
    };
    const value: Diagnostics = {
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      observedAt,
      ledgerSequence: this.#ledger.count(),
      spoolDepth,
      consumerLags: [],
      worker: {
        healthy: health.status === "READY" && spoolReadable,
        consumed: lastCycle?.consumed ?? 0,
        produced: lastCycle?.produced ?? 0,
        retryableFailures: (lastCycle?.retryableFailures ?? 0) + (spoolReadable ? 0 : 1),
      },
      storage: { healthy: storage.isFile(), databaseBytes: storage.size },
      ...(alertView === undefined ? {} : { alerts: alertView }),
    };
    this.#readModel.projectHealth(value);
    return value;
  }

  #prunePreviews(now: number): void {
    for (const [sessionId, preview] of this.#previews) {
      if (Date.parse(preview.value.expiresAt) <= now) this.#previews.delete(sessionId);
    }
    while (this.#previews.size >= MAX_PREVIEWS) {
      const oldest = this.#previews.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#previews.delete(oldest);
    }
  }

  async #identity(transcriptPath: string, sessionId: string): Promise<string> {
    const canonicalRoot = await realpath(this.#config.codexSessionsRoot);
    const canonicalTranscript = await realpath(transcriptPath);
    if (!canonicalTranscript.startsWith(`${canonicalRoot}${sep}`)) throw new ControlPlaneError("STALE_REVISION");
    const handle = await open(canonicalTranscript, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new ControlPlaneError("STALE_REVISION");
      const cursor = this.#ledger.loadIngestionCursor<TranscriptCursor>(`codex-transcript:${sessionId}`)?.cursor;
      return createHash("sha256").update(JSON.stringify({
        source: relative(canonicalRoot, canonicalTranscript),
        device: String(metadata.dev),
        inode: String(metadata.ino),
        size: metadata.size,
        modified: metadata.mtimeMs,
        changed: metadata.ctimeMs,
        cursor: cursor ?? null,
      })).digest("hex");
    } finally {
      await handle.close();
    }
  }

  async #preview(sessionId: string): Promise<CapturePreview> {
    const report = await this.#capture.capture({ sessionId, dryRun: true });
    const now = this.#clock().getTime();
    this.#prunePreviews(now);
    if (this.#previewRevision >= Number.MAX_SAFE_INTEGER) throw new Error("capture preview revision exhausted");
    this.#previewRevision += 1;
    const value: CapturePreview = {
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      sessionId: report.sessionId,
      previewRevision: this.#previewRevision,
      transcriptIdentityHash: await this.#identity(report.transcriptPath, report.sessionId),
      projectedEvents: report.projectedEvents,
      ignoredRecords: report.ignoredRecords,
      eventTypes: { ...report.eventTypes },
      cursor: { ...report.cursor },
      hasMore: report.hasMore,
      expiresAt: new Date(now + PREVIEW_TTL_MS).toISOString(),
    };
    this.#previews.set(report.sessionId, { value, transcriptPath: report.transcriptPath, signature: previewSignature(report) });
    return value;
  }

  /** Read-only source inspection used by manual P2 snapshot validation. */
  public async inspectTranscriptSource(sessionId: string): Promise<CapturePreview> {
    return await this.#preview(sessionId);
  }

  #knowledgeCompileStage(sessionId: string, observedAt: string): StageSnapshot {
    return {
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      entityId: sessionId,
      stage: "KNOWLEDGE_COMPILE",
      status: this.#p2KnowledgeConfigured ? "PENDING" : "DISABLED",
      reasonCode: this.#p2KnowledgeConfigured ? "NOT_APPLICABLE" : "KNOWLEDGE_WORKER_NOT_COMPOSED",
      observedAt,
      lastTransitionAt: observedAt,
      retryable: false,
      evidenceRefs: [],
      nextAction: this.#p2KnowledgeConfigured ? "Start a manual session extraction preview" : "Compose the production knowledge worker",
    };
  }

  async #commit(request: Extract<ControlRequest, { type: "capture.commit" }>): Promise<CaptureCommitResult> {
    const fingerprint = createHash("sha256").update(JSON.stringify({
      type: request.type,
      sessionId: request.sessionId,
      previewRevision: request.previewRevision,
      transcriptIdentityHash: request.transcriptIdentityHash,
      idempotencyKey: request.idempotencyKey,
    })).digest("hex");
    const existing = this.#commits.get(request.idempotencyKey) ?? this.#readModel.getCaptureCommandReceipt(request.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new ControlPlaneError("CONFLICT");
      return existing.result;
    }
    const stored = this.#previews.get(request.sessionId);
    if (!stored || stored.value.previewRevision !== request.previewRevision
      || stored.value.transcriptIdentityHash !== request.transcriptIdentityHash
      || Date.parse(stored.value.expiresAt) <= this.#clock().getTime()) {
      throw new ControlPlaneError("STALE_REVISION");
    }
    const result = await this.#capture.transaction(async (capture) => {
      if (await this.#identity(stored.transcriptPath, request.sessionId) !== request.transcriptIdentityHash) {
        throw new ControlPlaneError("STALE_REVISION");
      }
      const verification = await capture({ sessionId: request.sessionId, dryRun: true });
      if (previewSignature(verification) !== stored.signature
        || await this.#identity(stored.transcriptPath, request.sessionId) !== request.transcriptIdentityHash) {
        throw new ControlPlaneError("STALE_REVISION");
      }
      return capture({ sessionId: request.sessionId, dryRun: false });
    });
    await this.scheduleLedgerProjection();
    const state = this.#stateFor(request.sessionId);
    state.ignoredRecords += result.ignoredRecords;
    state.current = !result.hasMore;
    await this.#refreshSession(request.sessionId);
    const observedAt = timestamp(this.#clock);
    const stage = this.#knowledgeCompileStage(request.sessionId, observedAt);
    this.#readModel.projectStageRun({ runId: `capture-${request.sessionId}-${request.previewRevision}`, snapshot: stage });
    const committed: CaptureCommitResult = {
      schemaVersion: CONTROL_API_SCHEMA_VERSION,
      sessionId: request.sessionId,
      previewRevision: request.previewRevision,
      appendedEvents: result.appendedEvents,
      duplicateEvents: result.duplicateEvents,
      cursor: { ...result.cursor },
      knowledgeCompileStage: stage,
    };
    this.#readModel.saveCaptureCommandReceipt(request.idempotencyKey, fingerprint, committed);
    this.#previews.delete(request.sessionId);
    this.#commits.set(request.idempotencyKey, { fingerprint, result: committed });
    while (this.#commits.size > MAX_IDEMPOTENCY_RESULTS) {
      const oldest = this.#commits.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#commits.delete(oldest);
    }
    return committed;
  }

  async #serializedCommit(request: Extract<ControlRequest, { type: "capture.commit" }>): Promise<CaptureCommitResult> {
    const operation = this.#commitTail.then(async () => await this.#commit(request));
    this.#commitTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  public async noteLegacyCapture(report: CaptureSessionReport): Promise<void> {
    if (report.status !== "CAPTURED") return;
    await this.scheduleLedgerProjection();
    const state = this.#stateFor(report.sessionId);
    state.ignoredRecords += report.ignoredRecords;
    state.current = !report.hasMore;
    await this.#refreshSession(report.sessionId);
  }

  public async handle(request: ControlRequest | P2ControlRequest): Promise<ControlResponse> {
    const observedAt = timestamp(this.#clock);
    try {
      let result: unknown;
      switch (request.type) {
        case "overview.get": {
          await this.scheduleLedgerProjection();
          result = this.#readModel.getOverview({ observedAt, rolloutMode: "SHADOW", sidecarVersion: SIDECAR_VERSION, alertCount: this.#alertCount });
          break;
        }
        case "capabilities.list":
          result = this.#readModel.listCapabilities(operationalPage(request.page));
          break;
        case "sessions.list":
          await this.scheduleLedgerProjection();
          result = await this.#listSessions(request);
          break;
        case "session.get": {
          await this.scheduleLedgerProjection();
          if (await this.#refreshSession(request.sessionId) === undefined) throw new ControlPlaneError("NOT_FOUND");
          result = this.#readModel.getSession(request.sessionId);
          break;
        }
        case "session.events.list":
          await this.scheduleLedgerProjection();
          result = this.#readModel.listSessionEvents(request.sessionId, operationalPage(request.page));
          break;
        case "jobs.list":
          result = this.#readModel.listJobs(operationalPage(request.page));
          break;
        case "job.cancel":
          if (this.#jobCommands === undefined) throw new ControlPlaneError("CAPABILITY_UNAVAILABLE");
          result = await this.#jobCommands.cancelJob({
            jobId: request.jobId,
            expectedRevision: request.expectedRevision,
            idempotencyKey: request.idempotencyKey,
          });
          break;
        case "job.retry":
          if (this.#jobCommands === undefined) throw new ControlPlaneError("CAPABILITY_UNAVAILABLE");
          result = await this.#jobCommands.retryJob({
            jobId: request.jobId,
            expectedRevision: request.expectedRevision,
            idempotencyKey: request.idempotencyKey,
          });
          break;
        case "diagnostics.get":
          await this.scheduleLedgerProjection();
          result = await this.#diagnostics();
          break;
        case "capture.preview":
          result = await this.#preview(request.sessionId);
          break;
        case "capture.commit":
          result = await this.#serializedCommit(request);
          break;
        case "config.get": {
          if (this.#configuration === undefined) throw new ControlPlaneError("CAPABILITY_UNAVAILABLE");
          const view = this.#configuration.get(request.projectId);
          result = {
            view: { schemaVersion: CONTROL_API_SCHEMA_VERSION, ...view },
            drafts: this.#configuration.drafts(100),
            history: this.#configuration.history(100),
          };
          break;
        }
        case "config.validate":
          if (this.#configuration === undefined) throw new ControlPlaneError("CAPABILITY_UNAVAILABLE");
          result = this.#configuration.validateDraft({
            baseRevision: request.baseRevision,
            scope: request.scope,
            ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
            draft: request.draft,
          });
          break;
        case "config.activate":
          if (this.#configuration === undefined) throw new ControlPlaneError("CAPABILITY_UNAVAILABLE");
          result = await this.#configuration.activate(request.expectedRevision, request.draftRevision, request.idempotencyKey);
          break;
        case "config.rollback":
          if (this.#configuration === undefined) throw new ControlPlaneError("CAPABILITY_UNAVAILABLE");
          result = await this.#configuration.rollback(request.expectedRevision, request.targetRevision, request.idempotencyKey);
          break;
        case "extraction.snapshot.create":
        case "extraction.candidates.preview":
        case "extraction.candidates.commit":
        case "extraction.snapshot.get":
        case "extraction.snapshots.list":
        case "extraction.candidates.get":
        case "extraction.policy-commit.get":
        case "extraction.provenance.get":
          if (this.#extraction === undefined) throw new ControlPlaneError("CAPABILITY_UNAVAILABLE");
          result = await this.#extraction.handle(request);
          break;
      }
      return successResponse(request.requestId, result, timestamp(this.#clock));
    } catch (error) {
      const code = error instanceof ControlPlaneError
        ? error.code
        : error instanceof JobNotFoundError
          ? "NOT_FOUND"
          : error instanceof ExtractionNotFoundError
            ? "NOT_FOUND"
          : error instanceof JobStaleRevisionError
            ? "STALE_REVISION"
            : error instanceof ExtractionStaleRevisionError
              ? "STALE_REVISION"
            : error instanceof JobIdempotencyConflictError || error instanceof JobStateConflictError
              ? "CONFLICT"
              : error instanceof ExtractionConflictError
                ? "CONFLICT"
                : error instanceof Error && error.name === "P2CapabilityUnavailableError"
                  ? "CAPABILITY_UNAVAILABLE"
        : error instanceof InvalidOperationalCursorError
          ? "INVALID_CURSOR"
          : error instanceof Error && "code" in error && error.code === "SESSION_NOT_FOUND"
            ? "NOT_FOUND"
            : error instanceof Error && "code" in error && (error.code === "INVALID_SESSION_ID" || error.code === "INVALID_TRANSCRIPT_OPTIONS")
              ? "INVALID_REQUEST"
              : error instanceof Error && "code" in error && (
                error.code === "TRANSCRIPT_REPLACED" || error.code === "TRANSCRIPT_TRUNCATED" || error.code === "TRANSCRIPT_ANCHOR_MISMATCH"
              )
                ? "STALE_REVISION"
          : "INTERNAL_ERROR";
      return errorResponse(request.requestId, code, timestamp(this.#clock));
    }
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    await this.#commitTail;
    await this.#projectionTail;
    this.#readModel.close();
    this.#closed = true;
  }
}
