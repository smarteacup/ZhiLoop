import type { EvidenceVerdict } from "./evidence.js";
import type { KnowledgeKind, KnowledgeStatus } from "./knowledge.js";
import type { KnowledgeScope } from "./scope.js";

export const CONTEXT_COMPLEXITY_LEVELS = [
  "L0_NONE", "L1_POINTER", "L2_COMPACT", "L3_EVIDENCED", "L4_EPISODE",
] as const;
export type ContextComplexityLevel = (typeof CONTEXT_COMPLEXITY_LEVELS)[number];

export const CONTEXT_AUTHORITIES = [
  "BINDING_RULE", "ACCEPTED_DECISION", "VERIFIED_FACT", "REFERENCE",
] as const;
export type ContextAuthority = (typeof CONTEXT_AUTHORITIES)[number];

export interface ContextEvidenceSummary {
  readonly evidenceId: string;
  readonly verdict: EvidenceVerdict;
}

export interface ContextEnvelopeItem {
  readonly id: string;
  readonly version: number;
  readonly subjectKey: string;
  readonly kind: KnowledgeKind;
  readonly status: KnowledgeStatus;
  readonly scope: KnowledgeScope;
  readonly authority: ContextAuthority;
  readonly detailLevel: Exclude<ContextComplexityLevel, "L0_NONE">;
  readonly title: string;
  readonly summary: string;
  readonly retrievalRank: number;
  readonly applicability?: readonly string[];
  readonly failurePaths?: readonly string[];
  readonly symbols?: readonly string[];
  readonly content?: string;
  readonly evidencePointers?: readonly string[];
  readonly evidenceSummary?: readonly ContextEvidenceSummary[];
  readonly sourceEpisodes?: readonly string[];
}

export interface TaskContractBlock {
  readonly contractId: string;
  readonly objective: string;
  readonly gates: readonly string[];
  readonly boundaries: readonly string[];
}

export interface ContextEnvelope {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly complexity: {
    readonly level: ContextComplexityLevel;
    readonly breadth: number;
    readonly depth: "NONE" | "POINTER" | "COMPACT" | "EVIDENCED" | "EPISODE";
    readonly authority: ContextAuthority | "MIXED" | "NONE";
    readonly evidence: "NONE" | "POINTER" | "SUMMARY" | "EPISODE";
    readonly reasonCodes: readonly string[];
  };
  readonly budget: {
    readonly maxTokens: number;
    readonly estimatedTokens: number;
    readonly truncated: boolean;
    readonly disclosedItems: number;
    readonly omittedItems: number;
  };
  readonly items: readonly ContextEnvelopeItem[];
  readonly taskContract?: TaskContractBlock;
}
