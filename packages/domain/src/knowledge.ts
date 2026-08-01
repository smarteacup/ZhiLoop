import type { EvidenceHint, EvidenceRef, KnowledgeAssertion } from "./evidence.js";
import type { KnowledgeScope, ScopeHint } from "./scope.js";

export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

export const KNOWLEDGE_KINDS = [
  "FACT",
  "REQUIREMENT",
  "DESIGN",
  "DECISION",
  "IMPLEMENTATION",
  "EXPERIENCE",
  "RULE",
  "PREFERENCE",
  "OPEN_QUESTION",
] as const;

export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export const KNOWLEDGE_STATUSES = [
  "PROPOSED",
  "ACCEPTED",
  "IMPLEMENTED",
  "VERIFIED",
  "REJECTED",
  "STALE",
  "SUPERSEDED",
] as const;

export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export const KNOWLEDGE_RELATION_TYPES = [
  "CONTRADICTS",
  "SUPERSEDES",
  "IMPLEMENTS",
  "DERIVED_FROM",
  "RELATED_TO",
  "DUPLICATE_OF",
] as const;

export type KnowledgeRelationType = (typeof KNOWLEDGE_RELATION_TYPES)[number];

export interface KnowledgeRelation {
  readonly type: KnowledgeRelationType;
  readonly targetId: string;
  readonly targetVersion?: number;
  readonly reason?: string;
}

interface KnowledgeCandidateBase {
  readonly candidateId: string;
  readonly compilerVersion: string;
  readonly subjectKey: string;
  readonly kind: KnowledgeKind;
  readonly scopeHint: ScopeHint;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly sourceEpisodes: NonEmptyReadonlyArray<string>;
  readonly confidence: number;
  readonly createdAt: string;
  readonly correlationId: string;
}

export type CandidateSupport =
  | {
      readonly assertions: NonEmptyReadonlyArray<KnowledgeAssertion>;
      readonly evidenceHints: readonly EvidenceHint[];
    }
  | {
      readonly assertions: readonly KnowledgeAssertion[];
      readonly evidenceHints: NonEmptyReadonlyArray<EvidenceHint>;
    };

export type KnowledgeCandidate = KnowledgeCandidateBase & CandidateSupport;

export interface KnowledgeAsset {
  readonly id: string;
  readonly subjectKey: string;
  readonly kind: KnowledgeKind;
  readonly scope: KnowledgeScope;
  readonly version: number;
  readonly status: KnowledgeStatus;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly aliases: readonly string[];
  readonly keywords: readonly string[];
  readonly applicability: readonly string[];
  readonly nonApplicability: readonly string[];
  readonly symbols: readonly string[];
  readonly relations: readonly KnowledgeRelation[];
  readonly evidence: readonly EvidenceRef[];
  readonly confidence: number;
  readonly sourceEpisodes: NonEmptyReadonlyArray<string>;
  readonly contentHash: string;
  readonly codeFingerprint?: string;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const SUBJECT_KEY_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){2,}$/;
const DEFAULT_RETRIEVAL_STATUSES = new Set<KnowledgeStatus>([
  "ACCEPTED",
  "IMPLEMENTED",
  "VERIFIED",
]);

export function isValidSubjectKey(subjectKey: string): boolean {
  return SUBJECT_KEY_PATTERN.test(subjectKey);
}

export function isDefaultRetrievalEligible(status: KnowledgeStatus): boolean {
  return DEFAULT_RETRIEVAL_STATUSES.has(status);
}
