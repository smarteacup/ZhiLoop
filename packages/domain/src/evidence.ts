export const ASSERTION_KINDS = [
  "USER_ACCEPTED",
  "USER_REJECTED",
  "SYMBOL_EXISTS",
  "FILE_CONTAINS",
  "DEPENDENCY_PRESENT",
  "CONFIG_EQUALS",
  "COMMAND_SUCCEEDED",
  "TEST_PASSED",
  "CROSS_PROJECT_VERIFIED",
] as const;

export type AssertionKind = (typeof ASSERTION_KINDS)[number];

interface AssertionBase<TKind extends AssertionKind, TParameters> {
  readonly assertionId: string;
  readonly candidateId: string;
  readonly kind: TKind;
  readonly parameters: TParameters;
  readonly createdAt: string;
}

export type KnowledgeAssertion =
  | AssertionBase<"USER_ACCEPTED" | "USER_REJECTED", { readonly statementRef: string }>
  | AssertionBase<
      "SYMBOL_EXISTS",
      { readonly projectId: string; readonly symbol: string; readonly path?: string }
    >
  | AssertionBase<
      "FILE_CONTAINS",
      {
        readonly path: string;
        readonly expected: string;
        readonly matchMode: "EXACT" | "REGEX" | "STRUCTURAL";
      }
    >
  | AssertionBase<
      "DEPENDENCY_PRESENT",
      { readonly name: string; readonly versionConstraint?: string; readonly manifestPath?: string }
    >
  | AssertionBase<
      "CONFIG_EQUALS",
      { readonly key: string; readonly expected: string; readonly path?: string }
    >
  | AssertionBase<
      "COMMAND_SUCCEEDED",
      { readonly commandHash: string; readonly expectedExitCode: number }
    >
  | AssertionBase<
      "TEST_PASSED",
      { readonly testId: string; readonly commandHash?: string; readonly path?: string }
    >
  | AssertionBase<
      "CROSS_PROJECT_VERIFIED",
      { readonly subjectKey: string; readonly minimumProjects: number }
    >;

export const EVIDENCE_TYPES = [
  "USER_STATEMENT",
  "CODE_SYMBOL",
  "FILE_CONTENT",
  "DEPENDENCY",
  "CONFIGURATION",
  "COMMAND_RESULT",
  "TEST_RESULT",
  "CROSS_PROJECT",
] as const;

export type EvidenceType = (typeof EVIDENCE_TYPES)[number];
export type EvidenceVerdict = "SUPPORTS" | "CONTRADICTS" | "INCONCLUSIVE";

export interface EvidenceHint {
  readonly type: EvidenceType;
  readonly sourceRef: string;
  readonly projectId?: string;
  readonly correlationId: string;
}

export interface Evidence {
  readonly evidenceId: string;
  readonly assertionId?: string;
  readonly type: EvidenceType;
  readonly verdict: EvidenceVerdict;
  readonly sourceRef: string;
  readonly projectId?: string;
  readonly observedAt: string;
  readonly correlationId: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

export interface EvidenceRef {
  readonly evidenceId: string;
  readonly verdict: EvidenceVerdict;
}

