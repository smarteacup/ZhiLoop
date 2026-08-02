import type { ProjectContext } from "@zhiloop/domain";

export type QueryTermSource = "EXPLICIT" | "PROMPT";

export interface QueryTerm {
  readonly exact: string;
  readonly canonical: string;
  readonly source: QueryTermSource;
}

export interface QueryContextHints {
  readonly paths?: readonly string[];
  readonly symbols?: readonly string[];
  readonly errorCodes?: readonly string[];
  readonly configKeys?: readonly string[];
}

export interface QueryContextInput {
  readonly prompt: string;
  readonly project?: ProjectContext;
  readonly cwd?: string;
  readonly branch?: string;
  readonly taskId?: string;
  readonly hints?: QueryContextHints;
}

export interface QueryRetrievalBoundary {
  readonly allowProjectKnowledge: boolean;
  readonly allowGlobalKnowledge: boolean;
  readonly projectId?: string;
  readonly taskId?: string;
}

export interface QueryContext {
  readonly schemaVersion: 1;
  readonly prompt: string;
  readonly project?: ProjectContext;
  readonly cwd?: string;
  readonly branch?: string;
  readonly taskId?: string;
  readonly paths: readonly QueryTerm[];
  readonly symbols: readonly QueryTerm[];
  readonly errorCodes: readonly QueryTerm[];
  readonly configKeys: readonly QueryTerm[];
  readonly retrievalBoundary: QueryRetrievalBoundary;
  readonly reasonCodes: readonly string[];
}
