import type {
  AssertionKind,
  CodeGraphArtifact,
  Evidence,
  KnowledgeAssertion,
  ProjectContext,
} from "@zhiloop/domain";

export type VerificationStatus = "SUPPORTED" | "REFUTED" | "UNKNOWN" | "ERROR";

export type UserAssertion = Extract<KnowledgeAssertion, { kind: "USER_ACCEPTED" | "USER_REJECTED" }>;
export type SymbolAssertion = Extract<KnowledgeAssertion, { kind: "SYMBOL_EXISTS" }>;
export type CallPathAssertion = Extract<KnowledgeAssertion, { kind: "CALL_PATH_EXISTS" }>;
export type ImpactAssertion = Extract<KnowledgeAssertion, { kind: "IMPACT_CONTAINS" }>;
export type FileAssertion = Extract<KnowledgeAssertion, { kind: "FILE_CONTAINS" }>;
export type DependencyAssertion = Extract<KnowledgeAssertion, { kind: "DEPENDENCY_PRESENT" }>;
export type ConfigAssertion = Extract<KnowledgeAssertion, { kind: "CONFIG_EQUALS" }>;
export type CommandAssertion = Extract<KnowledgeAssertion, { kind: "COMMAND_SUCCEEDED" }>;
export type TestAssertion = Extract<KnowledgeAssertion, { kind: "TEST_PASSED" }>;
export type CrossProjectAssertion = Extract<KnowledgeAssertion, { kind: "CROSS_PROJECT_VERIFIED" }>;

export interface ProbeContext {
  readonly project: ProjectContext;
  readonly correlationId: string;
  readonly requestedAt: string;
}

export interface VerificationObservation {
  readonly status: Exclude<VerificationStatus, "ERROR">;
  readonly sourceRef: string;
  readonly observedAt: string;
  readonly target: string;
  readonly reasonCode: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
  readonly codeGraphArtifact?: CodeGraphArtifact;
}

export interface VerificationProbe<TAssertion extends KnowledgeAssertion> {
  observe(assertion: TAssertion, context: ProbeContext): Promise<VerificationObservation>;
}

export interface VerifierProbes {
  readonly user?: VerificationProbe<UserAssertion>;
  readonly symbol?: VerificationProbe<SymbolAssertion>;
  readonly callPath?: VerificationProbe<CallPathAssertion>;
  readonly impact?: VerificationProbe<ImpactAssertion>;
  readonly file?: VerificationProbe<FileAssertion>;
  readonly dependency?: VerificationProbe<DependencyAssertion>;
  readonly config?: VerificationProbe<ConfigAssertion>;
  readonly command?: VerificationProbe<CommandAssertion>;
  readonly test?: VerificationProbe<TestAssertion>;
  readonly crossProject?: VerificationProbe<CrossProjectAssertion>;
}

export interface VerificationContext extends ProbeContext {
  readonly probes: VerifierProbes;
}

export interface VerificationResult {
  readonly assertionId: string;
  readonly assertionKind: AssertionKind;
  readonly verifierId?: string;
  readonly status: VerificationStatus;
  readonly target: string;
  readonly observedAt: string;
  readonly reasonCodes: readonly string[];
  readonly evidence?: Evidence;
  readonly codeGraphArtifact?: CodeGraphArtifact;
}

export interface AssertionVerifier {
  readonly verifierId: string;
  readonly assertionKinds: readonly AssertionKind[];
  verify(assertion: KnowledgeAssertion, context: VerificationContext): Promise<VerificationResult>;
}
