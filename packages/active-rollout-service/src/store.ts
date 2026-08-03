import { randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import type { PersistedRolloutState, RolloutStateStore } from "./types.js";
import { validateShadowEligibilityEvidence } from "./evaluation.js";
import { fingerprint, freezeClone, requireFingerprint, validIso } from "./validation.js";

const MAX_STATE_BYTES = 2 * 1024 * 1024;

type FileRolloutState = PersistedRolloutState & { readonly checksum: string };

function validateState(value: PersistedRolloutState): void {
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.stateRevision) || value.stateRevision < 1) {
    throw new Error("rollout state header is invalid");
  }
  for (const revision of [value.effective, value.lastKnownGood]) {
    if (!Number.isSafeInteger(revision.policyRevision) || revision.policyRevision < 1
      || !(revision.mode === "SHADOW" || revision.mode === "ACTIVE")) {
      throw new Error("effective rollout revision is invalid");
    }
    requireFingerprint(revision.configFingerprint, "config fingerprint");
    requireFingerprint(revision.versionFingerprint, "version fingerprint");
  }
  if (value.audit.length < 1 || value.audit.length > 10_000
    || value.evidence.length > 1_000 || !value.audit.every((item) => validIso(item.occurredAt))) {
    throw new Error("rollout state history is invalid");
  }
  for (const evidence of value.evidence) validateShadowEligibilityEvidence(evidence);
}

export class MemoryRolloutStateStore implements RolloutStateStore {
  private state?: PersistedRolloutState;

  load(): PersistedRolloutState | undefined {
    return this.state === undefined ? undefined : freezeClone(this.state);
  }

  save(next: PersistedRolloutState, expectedStateRevision: number): void {
    validateState(next);
    const current = this.state?.stateRevision ?? 0;
    if (current !== expectedStateRevision || next.stateRevision !== expectedStateRevision + 1) {
      throw new Error("stale rollout state revision");
    }
    this.state = freezeClone(next);
  }
}

export class FileRolloutStateStore implements RolloutStateStore {
  constructor(private readonly path: string) {
    if (path.trim().length === 0 || path.includes("\0")) throw new Error("state path is invalid");
  }

  load(): PersistedRolloutState | undefined {
    try {
      const stat = lstatSync(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES
        || (stat.mode & 0o777) !== 0o600) {
        throw new Error("rollout state file is unsafe or not mode 0600");
      }
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as FileRolloutState;
      const { checksum, ...state } = parsed;
      validateState(state);
      requireFingerprint(checksum, "rollout state checksum");
      if (checksum !== fingerprint(state)) throw new Error("rollout state integrity checksum mismatch");
      return freezeClone(state);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  save(next: PersistedRolloutState, expectedStateRevision: number): void {
    validateState(next);
    const current = this.load()?.stateRevision ?? 0;
    if (current !== expectedStateRevision || next.stateRevision !== expectedStateRevision + 1) {
      throw new Error("stale rollout state revision");
    }
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify({ ...next, checksum: fingerprint(next) })}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.path);
      chmodSync(this.path, 0o600);
      const directoryDescriptor = openSync(directory, "r");
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
