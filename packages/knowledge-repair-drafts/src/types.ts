import type { KnowledgeAssertion, KnowledgeCandidate, KnowledgeStatus } from "@zhiloop/domain";

export const KNOWLEDGE_REPAIR_DRAFT_STATUSES = ["PENDING", "READY", "DISMISSED", "PROMOTED", "FAILED"] as const;
export type KnowledgeRepairDraftStatus = (typeof KNOWLEDGE_REPAIR_DRAFT_STATUSES)[number];

export interface RepairChangedAssertion {
  readonly assertionId: string;
  readonly assertionKind: KnowledgeAssertion["kind"];
  readonly verificationStatus: "UNSUPPORTED";
  readonly reasonCodes: readonly string[];
  readonly evidenceId?: string;
}

export interface RepairSourceKnowledge {
  readonly assetId: string;
  readonly assetVersion: number;
  readonly contentHash: string;
  readonly lifecycleStatus: KnowledgeStatus;
  readonly candidate: KnowledgeCandidate;
}

export interface RepairConflictEvidence {
  readonly runId: string;
  readonly codeRevision: string;
  readonly graphRevision?: string;
  readonly completedAt: string;
}

export interface RepairPromotionReceipt {
  readonly receiptId: string;
  readonly candidateId: string;
  readonly acceptedAt: string;
}

export interface RepairFailure {
  readonly code: string;
  readonly retryable: false;
  readonly occurredAt: string;
}

export interface KnowledgeRepairDraft {
  readonly schemaVersion: 1;
  readonly draftId: string;
  readonly projectId: string;
  readonly sourceKnowledge: RepairSourceKnowledge;
  readonly conflict: RepairConflictEvidence;
  readonly status: KnowledgeRepairDraftStatus;
  readonly revision: number;
  readonly changedAssertions: readonly RepairChangedAssertion[];
  readonly reasonCodes: readonly string[];
  readonly proposedCandidate?: KnowledgeCandidate;
  readonly proposedCandidateHash?: string;
  readonly dismissalReason?: string;
  readonly failure?: RepairFailure;
  readonly promotionReceipt?: RepairPromotionReceipt;
  readonly inheritedAuthorization: false;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateKnowledgeRepairDraftInput {
  readonly projectId: string;
  readonly sourceKnowledge: RepairSourceKnowledge;
  readonly conflict: RepairConflictEvidence;
  readonly changedAssertions: readonly RepairChangedAssertion[];
  readonly reasonCodes: readonly string[];
  readonly createdAt: string;
}

export interface RepairDraftWriteResult {
  readonly status: "CREATED" | "IDEMPOTENT" | "TRANSITIONED";
  readonly draft: KnowledgeRepairDraft;
}

export interface RepairDraftPage {
  readonly items: readonly KnowledgeRepairDraft[];
  readonly next?: { readonly createdAt: string; readonly draftId: string };
}

export interface RepairDraftListRequest {
  readonly limit: number;
  readonly projectId?: string;
  readonly statuses?: readonly KnowledgeRepairDraftStatus[];
  readonly after?: { readonly createdAt: string; readonly draftId: string };
}

export interface KnowledgeRepairDraftStore {
  create(input: CreateKnowledgeRepairDraftInput): RepairDraftWriteResult;
  get(draftId: string): KnowledgeRepairDraft | undefined;
  getByConflict(assetId: string, assetVersion: number, conflictRunId: string): KnowledgeRepairDraft | undefined;
  list(request: RepairDraftListRequest): RepairDraftPage;
  attachCandidate(request: { readonly draftId: string; readonly expectedRevision: number; readonly effectKey: string;
    readonly candidate: KnowledgeCandidate; readonly updatedAt: string }): RepairDraftWriteResult;
  dismiss(request: { readonly draftId: string; readonly expectedRevision: number; readonly effectKey: string;
    readonly reason: string; readonly updatedAt: string }): RepairDraftWriteResult;
  fail(request: { readonly draftId: string; readonly expectedRevision: number; readonly effectKey: string;
    readonly code: string; readonly updatedAt: string }): RepairDraftWriteResult;
  promote(request: { readonly draftId: string; readonly expectedRevision: number; readonly effectKey: string;
    readonly receipt: RepairPromotionReceipt; readonly updatedAt: string }): RepairDraftWriteResult;
}
