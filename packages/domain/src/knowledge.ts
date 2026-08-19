import type { EvidenceHint, EvidenceRef, KnowledgeAssertion } from "./evidence.js";
import type { KnowledgeScope, ScopeHint } from "./scope.js";
import type { KnowledgeClaimMode, KnowledgeLocator, ScenarioHint } from "./localization.js";

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
  readonly schemaVersion: 1 | 2;
  readonly candidateId: string;
  readonly compilerVersion: string;
  readonly status: "PROPOSED";
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

export type KnowledgeCandidate = KnowledgeCandidateBase & CandidateSupport & (
  | { readonly schemaVersion: 1; readonly claimMode?: KnowledgeClaimMode; readonly locator?: KnowledgeLocator }
  | { readonly schemaVersion: 2; readonly claimMode: KnowledgeClaimMode; readonly locator: KnowledgeLocator }
);

export type KnowledgeAssertionDraft =
  | { readonly kind: "USER_ACCEPTED" | "USER_REJECTED"; readonly parameters: { readonly statementRef: string } }
  | {
      readonly kind: "SYMBOL_EXISTS";
      readonly parameters: { readonly projectId: string; readonly symbol: string; readonly path?: string };
    }
  | {
      readonly kind: "CALL_PATH_EXISTS";
      readonly parameters: { readonly projectId: string; readonly from: string; readonly to: string; readonly maxDepth?: number };
    }
  | {
      readonly kind: "IMPACT_CONTAINS";
      readonly parameters: { readonly projectId: string; readonly symbol: string; readonly impactedSymbol: string };
    }
  | {
      readonly kind: "FILE_CONTAINS";
      readonly parameters: {
        readonly path: string;
        readonly expected: string;
        readonly matchMode: "EXACT" | "REGEX" | "STRUCTURAL";
      };
    }
  | {
      readonly kind: "DEPENDENCY_PRESENT";
      readonly parameters: { readonly name: string; readonly versionConstraint?: string; readonly manifestPath?: string };
    }
  | {
      readonly kind: "CONFIG_EQUALS";
      readonly parameters: { readonly key: string; readonly expected: string; readonly path?: string };
    }
  | {
      readonly kind: "COMMAND_SUCCEEDED";
      readonly parameters: { readonly commandHash: string; readonly expectedExitCode: number };
    }
  | {
      readonly kind: "TEST_PASSED";
      readonly parameters: { readonly testId: string; readonly commandHash?: string; readonly path?: string };
    }
  | {
      readonly kind: "CROSS_PROJECT_VERIFIED";
      readonly parameters: { readonly subjectKey: string; readonly minimumProjects: number };
    };

export interface EvidenceHintDraft {
  readonly type: EvidenceHint["type"];
  readonly sourceRef: string;
  readonly projectId?: string;
}

interface KnowledgeCandidateDraftBase {
  readonly subjectKey: string;
  readonly kind: KnowledgeKind;
  readonly scopeHint: ScopeHint;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly confidence: number;
  readonly claimMode?: KnowledgeClaimMode;
  readonly scenarioHint?: ScenarioHint;
}

export type KnowledgeCandidateDraft = KnowledgeCandidateDraftBase & (
  | {
      readonly assertions: readonly [KnowledgeAssertionDraft, ...KnowledgeAssertionDraft[]];
      readonly evidenceHints: readonly EvidenceHintDraft[];
    }
  | {
      readonly assertions: readonly KnowledgeAssertionDraft[];
      readonly evidenceHints: readonly [EvidenceHintDraft, ...EvidenceHintDraft[]];
    }
);

export interface KnowledgeExtractionOutput {
  readonly schemaVersion: 1;
  readonly candidates: readonly KnowledgeCandidateDraft[];
}

export interface KnowledgeAsset {
  readonly schemaVersion: 1 | 2;
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
  readonly claimMode?: KnowledgeClaimMode;
  readonly locator?: KnowledgeLocator;
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
