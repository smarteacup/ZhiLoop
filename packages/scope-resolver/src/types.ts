import type { KnowledgeCandidate, KnowledgeScope, ProjectContext } from "@zhiloop/domain";

export interface ScopeResolutionInput {
  readonly candidate: KnowledgeCandidate;
  readonly projectContext: ProjectContext;
  readonly taskId?: string;
  readonly userId?: string;
  readonly teamId?: string;
  readonly allowGlobal?: boolean;
  readonly projectTerms?: readonly string[];
}

export interface ScopeResolution {
  readonly scope: KnowledgeScope;
  readonly confidence: number;
  readonly reasonCodes: readonly string[];
  readonly projectSpecificSignals: readonly string[];
}
