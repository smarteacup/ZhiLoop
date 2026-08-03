import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import type {
  HighRiskGovernanceCommitRecord,
  HighRiskGovernanceStateStore,
  HighRiskOperationKind,
  HighRiskPreview,
} from "./types.js";
import { fingerprint, freezeClone, requireFingerprint, requireId, uniqueIds, validIso } from "./validation.js";

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_RECORDS = 10_000;
const KINDS = new Set<HighRiskOperationKind>([
  "GLOBAL_PROMOTION", "RULE_CHANGE", "BINDING_CHANGE", "PRIVACY_PURGE",
]);

interface HighRiskFileCore {
  readonly schemaVersion: 1;
  readonly stateRevision: number;
  readonly previews: readonly HighRiskPreview[];
  readonly commits: readonly HighRiskGovernanceCommitRecord[];
}

interface HighRiskFileState extends HighRiskFileCore {
  readonly checksum: string;
}

function emptyState(): HighRiskFileCore {
  return { schemaVersion: 1, stateRevision: 0, previews: [], commits: [] };
}

function validatePreview(preview: HighRiskPreview): void {
  requireFingerprint(preview.previewId, "previewId");
  requireFingerprint(preview.commandFingerprint, "command fingerprint");
  requireFingerprint(preview.command.payloadFingerprint, "payload fingerprint");
  if (!KINDS.has(preview.command.kind) || !Number.isSafeInteger(preview.policyRevision)
    || preview.policyRevision < 1 || !validIso(preview.createdAt) || !validIso(preview.expiresAt)
    || Date.parse(preview.expiresAt) <= Date.parse(preview.createdAt)) {
    throw new Error("persisted high-risk preview is invalid");
  }
  uniqueIds(preview.command.assetIds, "assetIds");
  uniqueIds(preview.command.projectIds, "projectIds", 1_000);
  uniqueIds(preview.blastRadius.reasonCodes, "blast reason codes", 100);
  const commandHash = fingerprint(preview.command);
  const expectedPreviewId = fingerprint({
    commandHash,
    policyRevision: preview.policyRevision,
    now: preview.createdAt,
  });
  if (preview.commandFingerprint !== commandHash || preview.previewId !== expectedPreviewId) {
    throw new Error("persisted preview fingerprint mismatch");
  }
}

function validateCommit(record: HighRiskGovernanceCommitRecord, previews: ReadonlyMap<string, HighRiskPreview>): void {
  requireFingerprint(record.previewId, "commit previewId");
  requireFingerprint(record.requestFingerprint, "commit request fingerprint");
  requireFingerprint(record.result.operationId, "operationId");
  requireId(record.result.actor, "actor");
  const preview = previews.get(record.previewId);
  if (preview === undefined || record.result.previewId !== record.previewId
    || record.result.kind !== preview.command.kind || record.result.policyRevision !== preview.policyRevision
    || !validIso(record.result.committedAt)) {
    throw new Error("persisted high-risk commit is invalid");
  }
}

function validateCore(core: HighRiskFileCore): void {
  if (core.schemaVersion !== 1 || !Number.isSafeInteger(core.stateRevision) || core.stateRevision < 0
    || core.previews.length > MAX_RECORDS || core.commits.length > MAX_RECORDS) {
    throw new Error("high-risk state header is invalid");
  }
  const previews = new Map<string, HighRiskPreview>();
  for (const preview of core.previews) {
    validatePreview(preview);
    if (previews.has(preview.previewId)) throw new Error("duplicate persisted previewId");
    previews.set(preview.previewId, preview);
  }
  const commitIds = new Set<string>();
  for (const commit of core.commits) {
    validateCommit(commit, previews);
    if (commitIds.has(commit.previewId)) throw new Error("duplicate persisted commit previewId");
    commitIds.add(commit.previewId);
  }
}

export class FileHighRiskGovernanceStateStore implements HighRiskGovernanceStateStore {
  constructor(private readonly path: string) {
    if (path.trim().length === 0 || path.includes("\0")) throw new Error("high-risk state path is invalid");
  }

  getPreview(previewId: string): HighRiskPreview | undefined {
    const value = this.read().previews.find((item) => item.previewId === previewId);
    return value === undefined ? undefined : freezeClone(value);
  }

  putPreview(preview: HighRiskPreview): void {
    validatePreview(preview);
    const current = this.read();
    const existing = current.previews.find((item) => item.previewId === preview.previewId);
    if (existing !== undefined) {
      if (fingerprint(existing) !== fingerprint(preview)) throw new Error("preview ID semantic conflict");
      return;
    }
    if (current.previews.length >= MAX_RECORDS) throw new Error("high-risk preview store capacity exceeded");
    this.write({ ...current, stateRevision: current.stateRevision + 1, previews: [...current.previews, preview] });
  }

  getCommit(previewId: string): HighRiskGovernanceCommitRecord | undefined {
    const value = this.read().commits.find((item) => item.previewId === previewId);
    return value === undefined ? undefined : freezeClone(value);
  }

  putCommit(record: HighRiskGovernanceCommitRecord): void {
    const current = this.read();
    validateCommit(record, new Map(current.previews.map((item) => [item.previewId, item])));
    const existing = current.commits.find((item) => item.previewId === record.previewId);
    if (existing !== undefined) {
      if (fingerprint(existing) !== fingerprint(record)) throw new Error("commit ID semantic conflict");
      return;
    }
    if (current.commits.length >= MAX_RECORDS) throw new Error("high-risk commit store capacity exceeded");
    this.write({ ...current, stateRevision: current.stateRevision + 1, commits: [...current.commits, record] });
  }

  private read(): HighRiskFileCore {
    try {
      const stat = lstatSync(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES || (stat.mode & 0o777) !== 0o600) {
        throw new Error("high-risk state file is unsafe or not mode 0600");
      }
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as HighRiskFileState;
      const core: HighRiskFileCore = {
        schemaVersion: parsed.schemaVersion,
        stateRevision: parsed.stateRevision,
        previews: parsed.previews,
        commits: parsed.commits,
      };
      validateCore(core);
      requireFingerprint(parsed.checksum, "state checksum");
      if (parsed.checksum !== fingerprint(core)) throw new Error("high-risk state integrity checksum mismatch");
      return freezeClone(core);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
  }

  private write(core: HighRiskFileCore): void {
    validateCore(core);
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let fileDescriptor: number | undefined;
    try {
      fileDescriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(fileDescriptor, `${JSON.stringify({ ...core, checksum: fingerprint(core) })}\n`, "utf8");
      fsyncSync(fileDescriptor);
      closeSync(fileDescriptor);
      fileDescriptor = undefined;
      renameSync(temporary, this.path);
      chmodSync(this.path, 0o600);
      const directoryDescriptor = openSync(directory, "r");
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    } finally {
      if (fileDescriptor !== undefined) closeSync(fileDescriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
