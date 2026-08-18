import type { VerificationPolicy } from "@zhiloop/config";
import type { KnowledgeCandidate, KnowledgeScope, KnowledgeStatus } from "@zhiloop/domain";
import type { VerificationResult } from "@zhiloop/evidence-engine";

export interface VerifiedProjectEvidenceRef {
  readonly projectId: string;
  readonly subjectKey: string;
  readonly evidenceId: string;
  readonly sourceRef: string;
  readonly observedAt: string;
}

export interface EvidencePolicyInput {
  readonly candidate: KnowledgeCandidate;
  readonly currentStatus: KnowledgeStatus;
  readonly resolvedScope: KnowledgeScope;
  readonly projectScope: Extract<KnowledgeScope, { level: "PROJECT" }>;
  readonly projectSpecificSignals: readonly string[];
  readonly verificationResults: readonly VerificationResult[];
  readonly verificationPolicy: VerificationPolicy;
  readonly verifiedProjects?: readonly VerifiedProjectEvidenceRef[];
  readonly userExplicitlyApprovedGlobal?: boolean;
  readonly conflictIds?: readonly string[];
  readonly adoptionAmbiguous?: boolean;
  /** A content revision may publish without a status transition only when this run has fresh supporting Evidence. */
  readonly contentRevisionRequested?: boolean;
}

export type EvidencePolicyAction = "APPLY" | "KEEP" | "ASK_USER";
export type EvidencePolicyInteraction = "NONE" | "ASK_USER";

export interface EvidencePolicyDecision {
  readonly action: EvidencePolicyAction;
  readonly interaction: EvidencePolicyInteraction;
  readonly currentStatus: KnowledgeStatus;
  readonly targetStatus: KnowledgeStatus;
  readonly transitionPath: readonly KnowledgeStatus[];
  readonly effectiveScope: KnowledgeScope;
  readonly shouldPublish: boolean;
  readonly evidenceIds: readonly string[];
  readonly reasonCodes: readonly string[];
}
