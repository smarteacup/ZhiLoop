export const REAL_CODEX_ACCEPTANCE_STAGES = Object.freeze(["HOOK", "SPOOL", "LEDGER", "CATALOG", "CURSOR"] as const);
export type RealCodexAcceptanceStage = (typeof REAL_CODEX_ACCEPTANCE_STAGES)[number];

export interface RealCodexAcceptanceEvidence {
  readonly stage: RealCodexAcceptanceStage;
  readonly sessionId: string;
  readonly observedAt: string;
  /** Safe opaque identifier, not raw transcript content or a filesystem path. */
  readonly evidenceRef: string;
}

export interface RealCodexAcceptanceEvidencePort {
  collect(sessionId: string): Promise<readonly RealCodexAcceptanceEvidence[]>;
}

export interface RealCodexAcceptanceRequest {
  readonly sessionId: string;
  /** Timestamp recorded immediately before creating the real Codex task. */
  readonly taskCreatedAt: string;
}

export interface RealCodexAcceptanceResult {
  readonly schemaVersion: 1;
  readonly status: "VERIFIED" | "NOT_VERIFIED";
  readonly sessionId: string;
  readonly requiredStages: readonly RealCodexAcceptanceStage[];
  readonly verifiedStages: readonly RealCodexAcceptanceStage[];
  readonly missingStages: readonly RealCodexAcceptanceStage[];
  readonly invalidStages: readonly RealCodexAcceptanceStage[];
  readonly reason: "ACCEPTANCE_SUCCEEDED" | "EVIDENCE_INCOMPLETE_OR_INVALID";
}

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,999}$/u;
const SAFE_EVIDENCE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,999}$/u;

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

/**
 * A fail-closed executable acceptance gate. It never infers success from a
 * process being up: every stage must provide fresh, ordered evidence for the
 * exact newly-created Codex session.
 */
export class RealCodexIngestionAcceptanceVerifier {
  constructor(private readonly evidence: RealCodexAcceptanceEvidencePort) {}

  async verify(request: RealCodexAcceptanceRequest): Promise<RealCodexAcceptanceResult> {
    if (!SAFE_SESSION_ID.test(request.sessionId) || !validTimestamp(request.taskCreatedAt)) {
      throw new Error("real Codex acceptance request is invalid");
    }
    const taskCreatedAt = Date.parse(request.taskCreatedAt);
    const collected = await this.evidence.collect(request.sessionId);
    const byStage = new Map<RealCodexAcceptanceStage, RealCodexAcceptanceEvidence>();
    const invalid = new Set<RealCodexAcceptanceStage>();
    const evidenceRefs = new Set<string>();

    for (const item of collected) {
      if (!REAL_CODEX_ACCEPTANCE_STAGES.includes(item.stage)) continue;
      const observedAt = Date.parse(item.observedAt);
      if (
        item.sessionId !== request.sessionId
        || !validTimestamp(item.observedAt)
        || observedAt < taskCreatedAt
        || !SAFE_EVIDENCE_REF.test(item.evidenceRef)
        || evidenceRefs.has(item.evidenceRef)
        || byStage.has(item.stage)
      ) {
        invalid.add(item.stage);
        continue;
      }
      byStage.set(item.stage, item);
      evidenceRefs.add(item.evidenceRef);
    }

    let previous = taskCreatedAt;
    for (const stage of REAL_CODEX_ACCEPTANCE_STAGES) {
      const item = byStage.get(stage);
      if (item === undefined || invalid.has(stage)) continue;
      const observedAt = Date.parse(item.observedAt);
      if (observedAt < previous) invalid.add(stage);
      else previous = observedAt;
    }

    const verifiedStages = REAL_CODEX_ACCEPTANCE_STAGES.filter((stage) => byStage.has(stage) && !invalid.has(stage));
    const missingStages = REAL_CODEX_ACCEPTANCE_STAGES.filter((stage) => !byStage.has(stage));
    const invalidStages = REAL_CODEX_ACCEPTANCE_STAGES.filter((stage) => invalid.has(stage));
    const verified = verifiedStages.length === REAL_CODEX_ACCEPTANCE_STAGES.length;
    return Object.freeze({
      schemaVersion: 1,
      status: verified ? "VERIFIED" : "NOT_VERIFIED",
      sessionId: request.sessionId,
      requiredStages: REAL_CODEX_ACCEPTANCE_STAGES,
      verifiedStages: Object.freeze(verifiedStages),
      missingStages: Object.freeze(missingStages),
      invalidStages: Object.freeze(invalidStages),
      reason: verified ? "ACCEPTANCE_SUCCEEDED" : "EVIDENCE_INCOMPLETE_OR_INVALID",
    });
  }
}
