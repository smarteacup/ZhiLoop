import type { KnowledgeCandidate, KnowledgeStatus } from "@zhiloop/domain";
import type { VerificationResult } from "@zhiloop/evidence-engine";

export type FingerprintTargetKind = "PATH" | "SYMBOL" | "CONFIG" | "DEPENDENCY";

export interface FingerprintTarget {
  readonly assertionId: string;
  readonly kind: FingerprintTargetKind;
  readonly key: string;
  readonly path?: string;
}

export interface FingerprintObservation extends FingerprintTarget {
  readonly digest: string;
  readonly sourceRef: string;
  readonly observedAt: string;
}

export interface KnowledgeFingerprint {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly projectId: string;
  readonly entries: readonly FingerprintObservation[];
  readonly fingerprint: string;
}

export interface KnowledgeChangeSet {
  readonly projectId: string;
  readonly changedPaths: readonly string[];
  readonly changedSymbols: readonly string[];
  readonly changedConfigs: readonly string[];
  readonly changedDependencies: readonly string[];
  readonly sourceRef: string;
  readonly observedAt: string;
}

export interface InvalidationInput {
  readonly candidate: KnowledgeCandidate;
  readonly currentStatus: KnowledgeStatus;
  readonly fingerprint: KnowledgeFingerprint;
  readonly changes: KnowledgeChangeSet;
  readonly revalidationResults?: readonly VerificationResult[];
}

export interface InvalidationDecision {
  readonly action: "UNCHANGED" | "REFRESH_FINGERPRINT" | "MARK_STALE" | "REVALIDATE";
  readonly currentStatus: KnowledgeStatus;
  readonly targetStatus: KnowledgeStatus;
  readonly affectedAssertionIds: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly preserveBody: true;
}
