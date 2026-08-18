export type CodeIntelligenceCapabilityStatus = "READY" | "NOT_CONFIGURED" | "INCOMPATIBLE" | "UNAVAILABLE";

export interface CodeIntelligenceCapability {
  readonly provider: "CODEGRAPH";
  readonly status: CodeIntelligenceCapabilityStatus;
  readonly reasonCode: string;
  readonly providerVersion?: string;
  readonly indexedFiles?: number;
}

export interface CodeProjectSnapshot {
  readonly projectRoot: string;
  readonly projectFingerprint: string;
}

export interface CodeSymbolQuery {
  readonly symbol: string;
  readonly path?: string;
  readonly limit?: number;
}

export interface CodeSymbolFact {
  readonly symbol: string;
  readonly qualifiedName: string;
  readonly kind: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly language: string;
  readonly exported: boolean;
}

export interface CodeRelationshipFact {
  readonly symbol: string;
  readonly kind: string;
  readonly path: string;
  readonly startLine: number;
}

export interface CodeFactResult<TFact> {
  readonly capability: CodeIntelligenceCapability;
  readonly facts: readonly TFact[];
}

export interface CodeIntelligencePort {
  capabilities(project: CodeProjectSnapshot): Promise<CodeIntelligenceCapability>;
  findSymbols(project: CodeProjectSnapshot, query: CodeSymbolQuery): Promise<CodeFactResult<CodeSymbolFact>>;
  callers(project: CodeProjectSnapshot, symbol: string, limit?: number): Promise<CodeFactResult<CodeRelationshipFact>>;
  impact(project: CodeProjectSnapshot, symbol: string, limit?: number): Promise<CodeFactResult<CodeRelationshipFact>>;
}
