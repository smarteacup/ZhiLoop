import type {
  BlastRadius,
  CommitHighRiskRequest,
  HighRiskGovernanceCommand,
  HighRiskAuthorizationPort,
  HighRiskGovernancePolicy,
  HighRiskGovernancePort,
  HighRiskGovernanceStateStore,
  HighRiskGovernanceCommitRecord,
  HighRiskExecutionIdentity,
  HighRiskOperationKind,
  HighRiskOperationResult,
  HighRiskPermission,
  HighRiskPreview,
} from "./types.js";
import { fingerprint, freezeClone, requireFingerprint, requireId, uniqueIds, validIso } from "./validation.js";

const REQUIRED_PERMISSION: Readonly<Record<HighRiskOperationKind, HighRiskPermission>> = {
  GLOBAL_PROMOTION: "PROMOTE_GLOBAL",
  RULE_CHANGE: "CHANGE_RULE",
  BINDING_CHANGE: "CHANGE_BINDING",
  PRIVACY_PURGE: "PURGE_PRIVATE_DATA",
};

function validatePolicy(policy: HighRiskGovernancePolicy): void {
  if (!Number.isSafeInteger(policy.revision) || policy.revision < 1
    || !Number.isSafeInteger(policy.previewTtlMs) || policy.previewTtlMs < 1_000
    || policy.previewTtlMs > 86_400_000) {
    throw new Error("high-risk governance policy is invalid");
  }
  for (const kind of Object.keys(REQUIRED_PERMISSION) as HighRiskOperationKind[]) {
    if (typeof policy.enabledOperations[kind] !== "boolean") throw new Error(`gate for ${kind} is missing`);
  }
}

function validateCommand(command: HighRiskGovernanceCommand): void {
  if (!(command.kind in REQUIRED_PERMISSION)) throw new Error("high-risk operation kind is invalid");
  uniqueIds(command.assetIds, "assetIds");
  uniqueIds(command.projectIds, "projectIds", 1_000);
  if (command.assetIds.length === 0) throw new Error("high-risk command requires affected assets");
  if (command.reason.trim().length < 4 || command.reason.length > 1_000 || /[\0]/u.test(command.reason)) {
    throw new Error("high-risk command reason is invalid");
  }
  requireFingerprint(command.payloadFingerprint, "payload fingerprint");
}

function validateBlastRadius(blast: BlastRadius, kind: HighRiskOperationKind): void {
  const counts = [
    blast.affectedAssets, blast.affectedProjects, blast.affectedRules,
    blast.affectedBindings, blast.affectedTraces, blast.affectedInjections,
  ];
  if (counts.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000)
    || blast.affectedAssets < 1 || blast.reasonCodes.length < 1 || blast.reasonCodes.length > 100) {
    throw new Error("blast-radius preview is invalid");
  }
  uniqueIds(blast.reasonCodes, "blast-radius reason codes", 100);
  if (kind === "PRIVACY_PURGE" && !blast.irreversible) {
    throw new Error("privacy purge preview must explicitly mark irreversible impact");
  }
}

function commandFingerprint(command: HighRiskGovernanceCommand): string {
  return fingerprint(command);
}

export function confirmationFingerprint(preview: HighRiskPreview, actor: string): string {
  requireId(actor, "actor");
  return fingerprint({ previewId: preview.previewId, commandFingerprint: preview.commandFingerprint, actor });
}

export class HighRiskGovernanceService {
  private policyValue: HighRiskGovernancePolicy;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly port: HighRiskGovernancePort,
    private readonly store: HighRiskGovernanceStateStore,
    private readonly authorization: HighRiskAuthorizationPort,
    policy: HighRiskGovernancePolicy,
  ) {
    validatePolicy(policy);
    this.policyValue = freezeClone(policy);
  }

  get policy(): HighRiskGovernancePolicy {
    return freezeClone(this.policyValue);
  }

  /**
   * Resolves an authoritative durable preview for server-side commit flows.
   * Browser clients only carry the preview identity and typed confirmation;
   * they never become the source of truth for blast-radius facts.
   */
  getPreview(previewId: string): HighRiskPreview | undefined {
    requireFingerprint(previewId, "preview ID");
    const preview = this.store.getPreview(previewId);
    return preview === undefined ? undefined : freezeClone(preview);
  }

  updatePolicy(next: HighRiskGovernancePolicy, expectedRevision: number): HighRiskGovernancePolicy {
    validatePolicy(next);
    if (expectedRevision !== this.policyValue.revision || next.revision <= expectedRevision) {
      throw new Error("stale high-risk policy revision");
    }
    this.policyValue = freezeClone(next);
    return this.policy;
  }

  async preview(command: HighRiskGovernanceCommand, now: string): Promise<HighRiskPreview> {
    validateCommand(command);
    if (!validIso(now)) throw new Error("preview timestamp must be canonical ISO-8601");
    const blastRadius = await this.port.preview(freezeClone(command));
    validateBlastRadius(blastRadius, command.kind);
    const commandHash = commandFingerprint(command);
    const previewId = fingerprint({ commandHash, policyRevision: this.policyValue.revision, now });
    const preview: HighRiskPreview = freezeClone({
      previewId,
      policyRevision: this.policyValue.revision,
      commandFingerprint: commandHash,
      command,
      blastRadius,
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + this.policyValue.previewTtlMs).toISOString(),
    });
    this.store.putPreview(preview);
    return preview;
  }

  async commit(request: CommitHighRiskRequest): Promise<HighRiskOperationResult> {
    requireId(request.actor, "actor");
    requireFingerprint(request.confirmationFingerprint, "confirmation fingerprint");
    if (!validIso(request.now)) throw new Error("commit timestamp must be canonical ISO-8601");
    const requestHash = fingerprint({
      preview: request.preview,
      expectedPolicyRevision: request.expectedPolicyRevision,
      actor: request.actor,
      confirmationFingerprint: request.confirmationFingerprint,
    });
    const previous = this.store.getCommit(request.preview.previewId);
    if (previous !== undefined) {
      const stored = this.store.getPreview(request.preview.previewId);
      if (stored === undefined || fingerprint(stored) !== fingerprint(request.preview)
        || request.confirmationFingerprint !== confirmationFingerprint(stored, request.actor)) {
        throw new Error("idempotent high-risk preview or actor-bound confirmation does not match");
      }
      const required = REQUIRED_PERMISSION[previous.result.kind];
      if (!await this.authorization.hasPermission(request.actor, required)) {
        throw new Error(`permission ${required} is required`);
      }
      if (previous.requestFingerprint !== requestHash) throw new Error("idempotent high-risk request does not match committed request");
      return freezeClone(previous.result);
    }
    if (request.expectedPolicyRevision !== this.policyValue.revision
      || request.preview.policyRevision !== this.policyValue.revision) {
      throw new Error("stale high-risk policy or preview revision");
    }
    const stored = this.store.getPreview(request.preview.previewId);
    if (stored === undefined || fingerprint(stored) !== fingerprint(request.preview)
      || stored.commandFingerprint !== commandFingerprint(stored.command)) {
      throw new Error("forged or unknown blast-radius preview");
    }
    if (Date.parse(request.now) > Date.parse(stored.expiresAt)) throw new Error("blast-radius preview expired");
    if (!this.policyValue.activeStageEnabled) throw new Error("ACTIVE stage is not enabled for high-risk governance");
    if (!this.policyValue.enabledOperations[stored.command.kind]) {
      throw new Error(`${stored.command.kind} gate is disabled`);
    }
    const required = REQUIRED_PERMISSION[stored.command.kind];
    if (!await this.authorization.hasPermission(request.actor, required)) {
      throw new Error(`permission ${required} is required`);
    }
    if (request.confirmationFingerprint !== confirmationFingerprint(stored, request.actor)) {
      throw new Error("actor-bound confirmation fingerprint does not match preview");
    }
    if (this.inFlight.has(stored.previewId)) throw new Error("high-risk operation is already in progress");
    this.inFlight.add(stored.previewId);
    try {
      const operationId = fingerprint({
        kind: "HIGH_RISK_GOVERNANCE",
        previewId: stored.previewId,
        commandFingerprint: stored.commandFingerprint,
        policyRevision: stored.policyRevision,
      });
      const identity: HighRiskExecutionIdentity = {
        operationId,
        idempotencyKey: operationId,
        previewId: stored.previewId,
        requestFingerprint: requestHash,
      };
      const executed = await this.port.execute(freezeClone(stored.command), identity);
      if (executed.operationId !== operationId || executed.requestFingerprint !== requestHash
        || !(executed.outcome === "COMMITTED" || executed.outcome === "REPLAYED")
        || !validIso(executed.committedAt)) {
        throw new Error("high-risk execution receipt does not match stable idempotency identity");
      }
      const result: HighRiskOperationResult = freezeClone({
        operationId,
        previewId: stored.previewId,
        kind: stored.command.kind,
        actor: request.actor,
        policyRevision: this.policyValue.revision,
        blastRadius: stored.blastRadius,
        committedAt: executed.committedAt,
      });
      this.store.putCommit({ previewId: stored.previewId, result, requestFingerprint: requestHash });
      return result;
    } finally {
      this.inFlight.delete(stored.previewId);
    }
  }
}

export class MemoryHighRiskGovernanceStateStore implements HighRiskGovernanceStateStore {
  private readonly previews = new Map<string, HighRiskPreview>();
  private readonly commits = new Map<string, HighRiskGovernanceCommitRecord>();

  getPreview(previewId: string): HighRiskPreview | undefined {
    const value = this.previews.get(previewId);
    return value === undefined ? undefined : freezeClone(value);
  }

  putPreview(preview: HighRiskPreview): void {
    const existing = this.previews.get(preview.previewId);
    if (existing !== undefined && fingerprint(existing) !== fingerprint(preview)) {
      throw new Error("preview ID semantic conflict");
    }
    this.previews.set(preview.previewId, freezeClone(preview));
  }

  getCommit(previewId: string): HighRiskGovernanceCommitRecord | undefined {
    const value = this.commits.get(previewId);
    return value === undefined ? undefined : freezeClone(value);
  }

  putCommit(record: HighRiskGovernanceCommitRecord): void {
    const existing = this.commits.get(record.previewId);
    if (existing !== undefined && fingerprint(existing) !== fingerprint(record)) {
      throw new Error("commit ID semantic conflict");
    }
    this.commits.set(record.previewId, freezeClone(record));
  }
}
