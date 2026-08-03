import { SessionCaptureError } from "@zhiloop/codex-session-capture";
import type { SessionCatalogEntry, SessionPagePosition } from "@zhiloop/session-catalog";

import type {
  AutomaticIngestionCheckpoint,
  AutomaticIngestionConfiguration,
  AutomaticIngestionDependencies,
  AutomaticIngestionDiagnostic,
  AutomaticIngestionDiagnosticCode,
  AutomaticIngestionRunReport,
  IngestionProgressStatus,
  NormalizedAutomaticIngestionConfiguration,
  SessionRelationObservation,
  SourceMutationDiagnostic,
} from "./types.js";

const SOURCE_MUTATIONS = new Set<SourceMutationDiagnostic>([
  "TRANSCRIPT_REPLACED",
  "TRANSCRIPT_TRUNCATED",
  "TRANSCRIPT_ANCHOR_MISMATCH",
]);
const CAPTURE_ELIGIBLE: readonly IngestionProgressStatus[] = Object.freeze(["FOLLOW_PENDING", "CAPTURED_PARTIAL", "RETRY_PENDING"]);
const RECOVERY_ELIGIBLE: readonly IngestionProgressStatus[] = Object.freeze(["RECOVERY_PENDING"]);
const ALL_PENDING: readonly IngestionProgressStatus[] = Object.freeze([...CAPTURE_ELIGIBLE, ...RECOVERY_ELIGIBLE]);
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,999}$/u;

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, field: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}`);
  }
  return selected;
}

export function normalizeAutomaticIngestionConfiguration(
  input: AutomaticIngestionConfiguration = {},
): NormalizedAutomaticIngestionConfiguration {
  return Object.freeze({
    scanIntervalMs: boundedInteger(input.scanIntervalMs, 5_000, 1_000, 86_400_000, "scanIntervalMs"),
    followDebounceMs: boundedInteger(input.followDebounceMs, 1_000, 100, 600_000, "followDebounceMs"),
    retryDelayMs: boundedInteger(input.retryDelayMs, 10_000, 1_000, 3_600_000, "retryDelayMs"),
    pageSize: boundedInteger(input.pageSize, 100, 1, 100, "pageSize"),
    maxScanPages: boundedInteger(input.maxScanPages, 50, 1, 1_000, "maxScanPages"),
    maxSessionsPerScan: boundedInteger(input.maxSessionsPerScan, 5_000, 1, 50_000, "maxSessionsPerScan"),
    maxCapturesPerRun: boundedInteger(input.maxCapturesPerRun, 25, 1, 1_000, "maxCapturesPerRun"),
    maxRecoveriesPerRun: boundedInteger(input.maxRecoveriesPerRun, 5, 1, 100, "maxRecoveriesPerRun"),
    maxRelationsPerRun: boundedInteger(input.maxRelationsPerRun, 1_000, 1, 10_000, "maxRelationsPerRun"),
    maxRelationPages: boundedInteger(input.maxRelationPages, 50, 1, 1_000, "maxRelationPages"),
    checkpointConflictRetries: boundedInteger(input.checkpointConflictRetries, 3, 1, 10, "checkpointConflictRetries"),
  });
}

function iso(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error("clock returned an invalid date");
  return date.toISOString();
}

function plusMilliseconds(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function validEntry(entry: SessionCatalogEntry): boolean {
  return SAFE_SESSION_ID.test(entry.sessionId)
    && Number.isFinite(Date.parse(entry.lastActivityAt))
    && entry.safeSourceAlias.length > 0
    && entry.safeSourceAlias.length <= 1_000;
}

function attemptKey(checkpoint: AutomaticIngestionCheckpoint, diagnostic: SourceMutationDiagnostic): string {
  return `${checkpoint.sessionId}:${checkpoint.sourceRevision}:${diagnostic}`;
}

function cursorKey(position: SessionPagePosition): string {
  return `${position.lastActivityAt}\0${position.sessionId}`;
}

function diagnostic(
  code: AutomaticIngestionDiagnosticCode,
  retryable: boolean,
  sessionId?: string,
): AutomaticIngestionDiagnostic {
  return Object.freeze({ code, retryable, ...(sessionId === undefined ? {} : { sessionId }) });
}

interface ScanResult {
  readonly entries: ReadonlyMap<string, SessionCatalogEntry>;
  readonly coverage: "COMPLETE" | "BOUNDED";
  readonly scanned: number;
  readonly discovered: number;
  readonly changed: number;
}

interface RelationResult {
  readonly coverage: AutomaticIngestionRunReport["relationCoverage"];
  readonly observed: number;
}

export class AutomaticIngestionService {
  readonly configuration: NormalizedAutomaticIngestionConfiguration;
  readonly #now: () => Date;

  constructor(
    private readonly dependencies: AutomaticIngestionDependencies,
    configuration: AutomaticIngestionConfiguration = {},
  ) {
    this.configuration = normalizeAutomaticIngestionConfiguration(configuration);
    this.#now = dependencies.now ?? (() => new Date());
    if ((dependencies.relationSource === undefined) !== (dependencies.relationStore === undefined)) {
      throw new Error("relationSource and relationStore must be configured together");
    }
  }

  async runOnce(): Promise<AutomaticIngestionRunReport> {
    const startedAt = iso(this.#now());
    const diagnostics: AutomaticIngestionDiagnostic[] = [];
    const relationWork = this.#observeRelations(diagnostics);
    const scan = await this.#scan(startedAt, diagnostics);
    const capturedSessions = await this.#captureEligible(startedAt, scan.entries, diagnostics);
    const recoveredSessions = await this.#recoverEligible(startedAt, scan.entries, diagnostics);
    const relation = await relationWork;
    const pending = await this.dependencies.checkpoints.listEligible({
      atOrBefore: "9999-12-31T23:59:59.999Z",
      limit: this.configuration.maxSessionsPerScan,
      statuses: ALL_PENDING,
    });
    return Object.freeze({
      schemaVersion: 1,
      startedAt,
      completedAt: iso(this.#now()),
      catalogCoverage: scan.coverage,
      relationCoverage: relation.coverage,
      scannedSessions: scan.scanned,
      discoveredSessions: scan.discovered,
      changedSessions: scan.changed,
      capturedSessions,
      recoveredSessions,
      observedRelations: relation.observed,
      pendingSessions: pending.length,
      diagnostics: Object.freeze(diagnostics),
    });
  }

  async #scan(at: string, diagnostics: AutomaticIngestionDiagnostic[]): Promise<ScanResult> {
    const entries = new Map<string, SessionCatalogEntry>();
    const seenPositions = new Set<string>();
    let after: SessionPagePosition | undefined;
    let pages = 0;
    let discovered = 0;
    let changed = 0;
    let coverage: "COMPLETE" | "BOUNDED" = "COMPLETE";

    while (pages < this.configuration.maxScanPages && entries.size < this.configuration.maxSessionsPerScan) {
      const remaining = this.configuration.maxSessionsPerScan - entries.size;
      const result = await this.dependencies.catalog.list({
        limit: Math.min(remaining, this.configuration.pageSize),
        ...(after === undefined ? {} : { after }),
      });
      pages += 1;
      if (result.items.length > remaining) {
        diagnostics.push(diagnostic("SESSION_SCAN_BOUNDED", true));
        coverage = "BOUNDED";
      }
      for (const entry of result.items) {
        if (entries.size >= this.configuration.maxSessionsPerScan) break;
        if (!validEntry(entry)) {
          diagnostics.push(diagnostic("CATALOG_ENTRY_INVALID", false));
          continue;
        }
        if (entries.has(entry.sessionId)) continue;
        entries.set(entry.sessionId, entry);
        const observed = await this.#observeSession(entry, at, diagnostics);
        if (observed === "DISCOVERED") discovered += 1;
        if (observed === "CHANGED") changed += 1;
      }
      if (result.nextPosition === undefined) break;
      const key = cursorKey(result.nextPosition);
      if (seenPositions.has(key) || (after !== undefined && cursorKey(after) === key)) {
        diagnostics.push(diagnostic("CATALOG_CURSOR_LOOP", false));
        coverage = "BOUNDED";
        break;
      }
      seenPositions.add(key);
      after = result.nextPosition;
      if (pages >= this.configuration.maxScanPages || entries.size >= this.configuration.maxSessionsPerScan) {
        diagnostics.push(diagnostic("SESSION_SCAN_BOUNDED", true));
        coverage = "BOUNDED";
      }
    }
    return { entries, coverage, scanned: entries.size, discovered, changed };
  }

  async #observeSession(
    entry: SessionCatalogEntry,
    at: string,
    diagnostics: AutomaticIngestionDiagnostic[],
  ): Promise<"DISCOVERED" | "CHANGED" | "UNCHANGED"> {
    let outcome: "DISCOVERED" | "CHANGED" | "UNCHANGED" = "UNCHANGED";
    await this.#update(entry.sessionId, diagnostics, (current) => {
      const sourceRevision = `${entry.source}:${entry.sourceStatus}:${entry.sourceVersion ?? "unknown"}:${entry.sourceFormatVersion}:${entry.safeSourceAlias}:${entry.lastActivityAt}`;
      const isNew = current === undefined;
      const isChanged = !isNew && (
        current.sourceRevision !== sourceRevision
        || current.lastObservedActivityAt !== entry.lastActivityAt
        || current.safeSourceAlias !== entry.safeSourceAlias
      );
      outcome = isNew ? "DISCOVERED" : isChanged ? "CHANGED" : "UNCHANGED";
      if (!isNew && !isChanged) return current;
      const unavailable = entry.sourceStatus !== "AVAILABLE" || entry.captureStatus === "SOURCE_UNAVAILABLE";
      const alreadyCurrent = !unavailable && entry.captureStatus === "CAPTURED_CURRENT";
      const pendingRecovery = current?.lastDiagnostic !== undefined
        && SOURCE_MUTATIONS.has(current.lastDiagnostic as SourceMutationDiagnostic)
        && current.recoveryAttemptKey !== undefined
        && current.recoveryCompletedAt === undefined;
      const recoveryPending = !unavailable && pendingRecovery;
      return Object.freeze({
        schemaVersion: 1,
        sessionId: entry.sessionId,
        version: (current?.version ?? 0) + 1,
        source: entry.source,
        safeSourceAlias: entry.safeSourceAlias,
        sourceRevision,
        lastObservedActivityAt: entry.lastActivityAt,
        status: unavailable ? "SOURCE_UNAVAILABLE" : recoveryPending ? "RECOVERY_PENDING" : alreadyCurrent ? "CAPTURED_CURRENT" : "FOLLOW_PENDING",
        ...(!unavailable && !alreadyCurrent ? {
          nextEligibleAt: recoveryPending
            ? current.nextEligibleAt ?? at
            : plusMilliseconds(at, this.configuration.followDebounceMs),
        } : {}),
        ...(current?.lastAttemptAt === undefined ? {} : { lastAttemptAt: current.lastAttemptAt }),
        ...(current?.capturedByteOffset === undefined ? {} : { capturedByteOffset: current.capturedByteOffset }),
        ...(current?.capturedLineNumber === undefined ? {} : { capturedLineNumber: current.capturedLineNumber }),
        ...(pendingRecovery && current.lastDiagnostic !== undefined ? { lastDiagnostic: current.lastDiagnostic } : {}),
        ...(pendingRecovery && current.recoveryAttemptKey !== undefined ? { recoveryAttemptKey: current.recoveryAttemptKey } : {}),
        updatedAt: at,
      });
    });
    return outcome;
  }

  async #captureEligible(
    at: string,
    scannedEntries: ReadonlyMap<string, SessionCatalogEntry>,
    diagnostics: AutomaticIngestionDiagnostic[],
  ): Promise<number> {
    const eligible = await this.dependencies.checkpoints.listEligible({
      atOrBefore: at,
      limit: this.configuration.maxCapturesPerRun,
      statuses: CAPTURE_ELIGIBLE,
    });
    let captured = 0;
    for (const checkpoint of eligible) {
      const entry = scannedEntries.get(checkpoint.sessionId) ?? await this.dependencies.catalog.get(checkpoint.sessionId);
      if (entry === undefined || entry.sourceStatus !== "AVAILABLE") {
        await this.#update(checkpoint.sessionId, diagnostics, (current) => current === undefined ? undefined : ({
          ...current,
          version: current.version + 1,
          status: "SOURCE_UNAVAILABLE",
          nextEligibleAt: undefined,
          updatedAt: at,
        }));
        continue;
      }
      try {
        const report = await this.dependencies.capture.capture({ sessionId: checkpoint.sessionId, dryRun: false });
        if (
          report.sessionId !== checkpoint.sessionId
          || !Number.isSafeInteger(report.cursor.byteOffset)
          || report.cursor.byteOffset < 0
          || !Number.isSafeInteger(report.cursor.lineNumber)
          || report.cursor.lineNumber < 0
          || typeof report.hasMore !== "boolean"
        ) throw new Error("capture returned an invalid report");
        await this.#update(checkpoint.sessionId, diagnostics, (current) => current === undefined ? undefined : ({
          ...current,
          version: current.version + 1,
          status: report.hasMore ? "CAPTURED_PARTIAL" : "CAPTURED_CURRENT",
          nextEligibleAt: report.hasMore ? plusMilliseconds(at, this.configuration.followDebounceMs) : undefined,
          lastAttemptAt: at,
          capturedByteOffset: report.cursor.byteOffset,
          capturedLineNumber: report.cursor.lineNumber,
          lastDiagnostic: undefined,
          recoveryAttemptKey: undefined,
          recoveryCompletedAt: undefined,
          updatedAt: at,
        }));
        captured += 1;
      } catch (error) {
        const code = error instanceof SessionCaptureError ? error.code : undefined;
        if (code !== undefined && SOURCE_MUTATIONS.has(code as SourceMutationDiagnostic)) {
          const mutation = code as SourceMutationDiagnostic;
          diagnostics.push(diagnostic(mutation, true, checkpoint.sessionId));
          await this.#update(checkpoint.sessionId, diagnostics, (current) => current === undefined ? undefined : ({
            ...current,
            version: current.version + 1,
            status: "RECOVERY_PENDING",
            nextEligibleAt: at,
            lastAttemptAt: at,
            lastDiagnostic: mutation,
            recoveryAttemptKey: current.recoveryAttemptKey ?? attemptKey(current, mutation),
            recoveryCompletedAt: undefined,
            updatedAt: at,
          }));
        } else {
          diagnostics.push(diagnostic("CAPTURE_FAILED", true, checkpoint.sessionId));
          await this.#update(checkpoint.sessionId, diagnostics, (current) => current === undefined ? undefined : ({
            ...current,
            version: current.version + 1,
            status: "RETRY_PENDING",
            nextEligibleAt: plusMilliseconds(at, this.configuration.retryDelayMs),
            lastAttemptAt: at,
            lastDiagnostic: "CAPTURE_FAILED",
            updatedAt: at,
          }));
        }
      }
    }
    return captured;
  }

  async #recoverEligible(
    at: string,
    scannedEntries: ReadonlyMap<string, SessionCatalogEntry>,
    diagnostics: AutomaticIngestionDiagnostic[],
  ): Promise<number> {
    if (this.dependencies.recovery === undefined) return 0;
    const eligible = await this.dependencies.checkpoints.listEligible({
      atOrBefore: at,
      limit: this.configuration.maxRecoveriesPerRun,
      statuses: RECOVERY_ELIGIBLE,
    });
    let recovered = 0;
    for (const checkpoint of eligible) {
      const mutation = checkpoint.lastDiagnostic;
      const entry = scannedEntries.get(checkpoint.sessionId) ?? await this.dependencies.catalog.get(checkpoint.sessionId);
      if (entry === undefined || mutation === undefined || !SOURCE_MUTATIONS.has(mutation as SourceMutationDiagnostic)) continue;
      const key = checkpoint.recoveryAttemptKey ?? attemptKey(checkpoint, mutation as SourceMutationDiagnostic);
      try {
        const recovery = await this.dependencies.recovery.recover({
          session: entry,
          diagnostic: mutation as SourceMutationDiagnostic,
          attemptKey: key,
        });
        const completed = recovery.report.status === "COMPLETED" && recovery.sourceCheckpoint === "REBASED";
        if (!completed) diagnostics.push(diagnostic("RECOVERY_INCOMPLETE", true, checkpoint.sessionId));
        await this.#update(checkpoint.sessionId, diagnostics, (current) => current === undefined ? undefined : ({
          ...current,
          version: current.version + 1,
          status: completed ? "FOLLOW_PENDING" : "RECOVERY_PENDING",
          nextEligibleAt: plusMilliseconds(at, completed ? this.configuration.followDebounceMs : this.configuration.retryDelayMs),
          recoveryAttemptKey: key,
          ...(completed ? { recoveryCompletedAt: at } : {}),
          updatedAt: at,
        }));
        if (completed) recovered += 1;
      } catch {
        diagnostics.push(diagnostic("RECOVERY_FAILED", true, checkpoint.sessionId));
        await this.#update(checkpoint.sessionId, diagnostics, (current) => current === undefined ? undefined : ({
          ...current,
          version: current.version + 1,
          status: "RECOVERY_PENDING",
          nextEligibleAt: plusMilliseconds(at, this.configuration.retryDelayMs),
          recoveryAttemptKey: key,
          updatedAt: at,
        }));
      }
    }
    return recovered;
  }

  async #observeRelations(diagnostics: AutomaticIngestionDiagnostic[]): Promise<RelationResult> {
    const source = this.dependencies.relationSource;
    const store = this.dependencies.relationStore;
    if (source === undefined || store === undefined) return { coverage: "NOT_CONFIGURED", observed: 0 };
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let observed = 0;
    let pages = 0;
    try {
      while (observed < this.configuration.maxRelationsPerRun && pages < this.configuration.maxRelationPages) {
        const remaining = this.configuration.maxRelationsPerRun - observed;
        const page = await source.list({
          limit: remaining,
          ...(cursor === undefined ? {} : { cursor }),
        });
        pages += 1;
        const overflowed = page.items.length > remaining;
        const valid: SessionRelationObservation[] = [];
        for (const item of page.items) {
          if (observed + valid.length >= this.configuration.maxRelationsPerRun) break;
          if (
            !SAFE_SESSION_ID.test(item.parentSessionId)
            || !SAFE_SESSION_ID.test(item.childSessionId)
            || item.kind !== "SUB_AGENT"
            || !["CODEX_APP_SERVER", "CODEX_TRANSCRIPT", "HOOK"].includes(item.source)
            || !Number.isFinite(Date.parse(item.observedAt))
          ) continue;
          valid.push(Object.freeze({ ...item }));
        }
        await store.upsertMany(valid);
        observed += valid.length;
        if (overflowed) {
          diagnostics.push(diagnostic("RELATION_SCAN_BOUNDED", true));
          return { coverage: "BOUNDED", observed };
        }
        if (page.nextCursor === undefined) return { coverage: "COMPLETE", observed };
        if (page.nextCursor === cursor || seenCursors.has(page.nextCursor)) {
          diagnostics.push(diagnostic("RELATION_SCAN_BOUNDED", true));
          return { coverage: "BOUNDED", observed };
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      diagnostics.push(diagnostic("RELATION_SCAN_BOUNDED", true));
      return { coverage: "BOUNDED", observed };
    } catch {
      diagnostics.push(diagnostic("RELATION_SCAN_FAILED", true));
      return { coverage: "FAILED", observed };
    }
  }

  async #update(
    sessionId: string,
    diagnostics: AutomaticIngestionDiagnostic[],
    mutate: (current: AutomaticIngestionCheckpoint | undefined) => AutomaticIngestionCheckpoint | undefined,
  ): Promise<AutomaticIngestionCheckpoint | undefined> {
    for (let attempt = 0; attempt < this.configuration.checkpointConflictRetries; attempt += 1) {
      const current = await this.dependencies.checkpoints.load(sessionId);
      const next = mutate(current);
      if (next === undefined || next === current) return current;
      const committed = await this.dependencies.checkpoints.compareAndSwap(sessionId, current?.version, Object.freeze(next));
      if (committed === "COMMITTED") return next;
    }
    diagnostics.push(diagnostic("CHECKPOINT_CONFLICT", true, sessionId));
    return this.dependencies.checkpoints.load(sessionId);
  }
}
