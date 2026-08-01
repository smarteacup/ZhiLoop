import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import path from "node:path";

import type { EventEnvelope } from "@zhiloop/domain";
import { canonicalStringify } from "@zhiloop/ingestion-codex";
import { parseEventEnvelope } from "@zhiloop/schemas";

import { redactEventEnvelope } from "./redaction.js";
import type {
  HookEventSink,
  LocalEventSpoolOptions,
  SpoolDiagnostic,
  SpoolDrainOptions,
  SpoolDrainResult,
  SpoolStoreResult,
} from "./types.js";

const DEFAULT_MAX_RECORD_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_SCAN_FILES = 100;
const DEFAULT_DRAIN_LIMIT = 100;
const MAX_DRAIN_LIMIT = 1_000;
const SPOOL_FILE = /^[a-f0-9]{64}\.json$/;

interface SpoolRecord {
  readonly spoolVersion: 1;
  readonly queuedAt: string;
  readonly redactionCount: number;
  readonly event: EventEnvelope;
}

interface LocatedRecord {
  readonly fileName: string;
  readonly record: SpoolRecord;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function eventFileName(eventId: string): string {
  return `${sha256(eventId)}.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSpoolRecord(value: unknown): SpoolRecord {
  if (!isRecord(value) || value["spoolVersion"] !== 1) throw new InvalidSpoolRecordError();
  const queuedAt = value["queuedAt"];
  const redactionCount = value["redactionCount"];
  if (typeof queuedAt !== "string" || Number.isNaN(Date.parse(queuedAt))) throw new InvalidSpoolRecordError();
  if (!Number.isSafeInteger(redactionCount) || (redactionCount as number) < 0) {
    throw new InvalidSpoolRecordError();
  }
  const parsedEvent = parseEventEnvelope(value["event"]);
  if (!parsedEvent.ok) throw new InvalidSpoolRecordError();
  return {
    spoolVersion: 1,
    queuedAt,
    redactionCount: redactionCount as number,
    event: parsedEvent.value,
  };
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
}

function errorCode(error: unknown): string | undefined {
  if (isRecord(error) && typeof error["code"] === "string") return error["code"];
  return undefined;
}

export class SpoolConflictError extends Error {
  override readonly name = "SpoolConflictError";
}

class InvalidSpoolRecordError extends Error {
  override readonly name = "InvalidSpoolRecordError";
}

export class LocalEventSpool {
  readonly #directory: string;
  readonly #clock: () => Date;
  readonly #randomId: () => string;
  readonly #maxRecordBytes: number;
  readonly #maxScanFiles: number;

  constructor(directory: string, options: LocalEventSpoolOptions = {}) {
    if (directory.length === 0) throw new Error("spool directory must not be empty");
    this.#directory = path.resolve(directory);
    this.#clock = options.clock ?? (() => new Date());
    this.#randomId = options.randomId ?? randomUUID;
    this.#maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
    this.#maxScanFiles = options.maxScanFiles ?? DEFAULT_MAX_SCAN_FILES;
    assertPositiveSafeInteger(this.#maxRecordBytes, "maxRecordBytes");
    assertPositiveSafeInteger(this.#maxScanFiles, "maxScanFiles");
  }

  get directory(): string {
    return this.#directory;
  }

  async #ensureDirectory(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.#directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("spool path must be a real directory");
    if (process.platform !== "win32") await chmod(this.#directory, 0o700);
  }

  async #syncDirectory(): Promise<void> {
    if (process.platform === "win32") return;
    const handle = await open(this.#directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #read(fileName: string): Promise<SpoolRecord> {
    const filePath = path.join(this.#directory, fileName);
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new Error("spool record is not a regular file");
      if (metadata.size > this.#maxRecordBytes) throw new RangeError("spool record exceeds size limit");
      const text = await handle.readFile({ encoding: "utf8" });
      const record = parseSpoolRecord(JSON.parse(text) as unknown);
      if (eventFileName(record.event.eventId) !== fileName) throw new SpoolConflictError("spool filename mismatch");
      return record;
    } finally {
      await handle.close();
    }
  }

  async #scanActiveFileNames(limit: number): Promise<{ readonly fileNames: readonly string[]; readonly truncated: boolean }> {
    const directory = await opendir(this.#directory);
    const fileNames: string[] = [];
    for await (const entry of directory) {
      if (!entry.isFile() || !SPOOL_FILE.test(entry.name)) continue;
      if (fileNames.length === limit) return { fileNames: fileNames.sort(), truncated: true };
      fileNames.push(entry.name);
    }
    return { fileNames: fileNames.sort(), truncated: false };
  }

  async #countActiveFiles(): Promise<number> {
    const directory = await opendir(this.#directory);
    let count = 0;
    for await (const entry of directory) {
      if (entry.isFile() && SPOOL_FILE.test(entry.name)) count += 1;
    }
    return count;
  }

  async #existingResult(fileName: string, expected: SpoolRecord): Promise<SpoolStoreResult> {
    const existing = await this.#read(fileName);
    if (canonicalStringify(existing.event) !== canonicalStringify(expected.event)) {
      throw new SpoolConflictError(`eventId conflict for ${expected.event.eventId}`);
    }
    return { status: "duplicate", fileName };
  }

  async store(event: EventEnvelope, priorRedactionCount = 0): Promise<SpoolStoreResult> {
    if (!Number.isSafeInteger(priorRedactionCount) || priorRedactionCount < 0) {
      throw new Error("priorRedactionCount must be a non-negative safe integer");
    }
    const redacted = redactEventEnvelope(event);
    const totalRedactionCount = priorRedactionCount + redacted.redactionCount;
    if (!Number.isSafeInteger(totalRedactionCount)) throw new Error("combined redactionCount exceeds safe integer range");
    const now = this.#clock();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("spool clock returned an invalid date");
    const record: SpoolRecord = {
      spoolVersion: 1,
      queuedAt: now.toISOString(),
      redactionCount: totalRedactionCount,
      event: redacted.event,
    };
    const serialized = `${canonicalStringify(record)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > this.#maxRecordBytes) {
      throw new RangeError("spool record exceeds size limit");
    }

    await this.#ensureDirectory();
    const fileName = eventFileName(record.event.eventId);
    const targetPath = path.join(this.#directory, fileName);
    try {
      return await this.#existingResult(fileName, record);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }

    const randomId = this.#randomId();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(randomId)) throw new Error("randomId must be a safe filename component");
    const temporaryPath = path.join(this.#directory, `.tmp-${process.pid}-${randomId}`);
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      try {
        await handle.writeFile(serialized, { encoding: "utf8" });
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temporaryPath, targetPath);
        await this.#syncDirectory();
        return { status: "stored", fileName, redactionCount: record.redactionCount };
      } catch (error) {
        if (errorCode(error) === "EEXIST") return await this.#existingResult(fileName, record);
        throw error;
      }
    } finally {
      try {
        await unlink(temporaryPath);
      } catch {
        // Best-effort cleanup must not replace the write or conflict result.
      }
    }
  }

  async drain(sink: HookEventSink, options: SpoolDrainOptions = {}): Promise<SpoolDrainResult> {
    const limit = options.limit ?? DEFAULT_DRAIN_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DRAIN_LIMIT) {
      throw new Error(`drain limit must be between 1 and ${MAX_DRAIN_LIMIT}`);
    }
    await this.#ensureDirectory();
    const scan = await this.#scanActiveFileNames(this.#maxScanFiles);
    const diagnostics: SpoolDiagnostic[] = [];
    const located: LocatedRecord[] = [];

    for (const fileName of scan.fileNames) {
      try {
        located.push({ fileName, record: await this.#read(fileName) });
      } catch (error) {
        const code = error instanceof RangeError
          ? "oversized-record"
          : error instanceof SpoolConflictError
            ? "filename-mismatch"
            : error instanceof SyntaxError || error instanceof InvalidSpoolRecordError
              ? "invalid-record"
              : "read-failed";
        let quarantined = false;
        try {
          await rename(
            path.join(this.#directory, fileName),
            path.join(this.#directory, `${fileName}.corrupt-${randomUUID()}`),
          );
          quarantined = true;
        } catch {
          // The diagnostic remains visible even when quarantine cannot be completed.
        }
        diagnostics.push({ fileName, code, quarantined });
      }
    }

    located.sort((left, right) => {
      const occurred = left.record.event.occurredAt.localeCompare(right.record.event.occurredAt);
      if (occurred !== 0) return occurred;
      const queued = left.record.queuedAt.localeCompare(right.record.queuedAt);
      return queued !== 0 ? queued : left.fileName.localeCompare(right.fileName);
    });

    const fallbackSignal = new AbortController().signal;
    let delivered = 0;
    let stopReason: SpoolDrainResult["stopReason"] = null;
    for (const item of located.slice(0, limit)) {
      if (options.signal?.aborted === true) {
        stopReason = "aborted";
        break;
      }
      try {
        await sink.enqueue(item.record.event, options.signal ?? fallbackSignal);
        delivered += 1;
      } catch {
        stopReason = "sink-error";
        break;
      }
      try {
        await unlink(path.join(this.#directory, item.fileName));
      } catch {
        stopReason = "cleanup-error";
        break;
      }
    }

    const remaining = await this.#countActiveFiles();
    return { delivered, remaining, diagnostics, stopReason, scanTruncated: scan.truncated };
  }
}
