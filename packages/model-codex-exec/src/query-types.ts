import type { CodexExecProcessPort } from "./types.js";

export interface CodexKnowledgeQueryContext {
  readonly prompt: string;
  readonly promptFingerprint: string;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly repositoryRoot?: string;
  readonly paths: readonly string[];
  readonly symbols: readonly string[];
  readonly errorCodes: readonly string[];
  readonly configKeys: readonly string[];
  readonly allowProjectKnowledge: boolean;
  readonly allowGlobalKnowledge: boolean;
  readonly reasonCodes: readonly string[];
}

export interface EligibleRetrievedKnowledge {
  readonly knowledgeId: string;
  readonly version: number;
  readonly title: string;
  readonly content: string;
  readonly evidenceIds: readonly string[];
  readonly eligible: true;
}

export interface AnswerSpan {
  readonly start: number;
  readonly end: number;
}

export interface CodexKnowledgeAnswerCitation {
  readonly knowledgeId: string;
  readonly version: number;
  readonly answerSpans: readonly AnswerSpan[];
  readonly evidenceIds: readonly string[];
}

export interface CodexKnowledgeAnswerConflict {
  readonly summary: string;
  readonly knowledgeVersions: readonly {
    readonly knowledgeId: string;
    readonly version: number;
  }[];
}

export type CodexKnowledgeQueryOutcome = "SUCCEEDED" | "FALLBACK_SEARCH" | "CANCELLED" | "FAILED";
export type CodexKnowledgeQueryReason =
  | "COMPLETED"
  | "UNAVAILABLE"
  | "UNAUTHENTICATED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "INVALID_OUTPUT"
  | "CONCURRENCY_LIMIT"
  | "CANCELLED";

export interface CodexKnowledgeQueryUsage {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
}

export interface CodexKnowledgeQueryAnswer {
  readonly schemaVersion: 1;
  readonly queryId: string;
  readonly retrievalTraceId: string;
  readonly modelRunId?: string;
  readonly outcome: CodexKnowledgeQueryOutcome;
  readonly model?: string;
  readonly answer: string;
  readonly factualSpans: readonly AnswerSpan[];
  readonly citations: readonly CodexKnowledgeAnswerCitation[];
  readonly unknowns: readonly string[];
  readonly conflicts: readonly CodexKnowledgeAnswerConflict[];
  readonly latencyMs: number;
  readonly usage: CodexKnowledgeQueryUsage;
}

export interface CodexKnowledgeQueryRequest {
  readonly queryId: string;
  readonly retrievalTraceId: string;
  readonly question: string;
  readonly queryContext: CodexKnowledgeQueryContext;
  readonly retrievedKnowledge: readonly EligibleRetrievedKnowledge[];
  readonly signal: AbortSignal;
}

export interface CodexKnowledgeQueryModel {
  answer(request: CodexKnowledgeQueryRequest): Promise<CodexKnowledgeQueryAnswer>;
}

export interface CodexKnowledgeQueryRunDiagnostic {
  readonly modelRunId: string;
  readonly queryId: string;
  readonly retrievalTraceId: string;
  readonly outcome: CodexKnowledgeQueryOutcome;
  readonly reason: CodexKnowledgeQueryReason;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly latencyMs: number;
  readonly usage: CodexKnowledgeQueryUsage;
  readonly model?: string;
}

export interface CodexKnowledgeQueryDiagnosticStore {
  append(diagnostic: CodexKnowledgeQueryRunDiagnostic): Promise<void>;
}

export type CodexUserConfigurationPolicy = "IGNORE" | "ALLOW";
export type CodexMcpConfigurationPolicy = "DISABLED" | "ALLOW_CONFIGURED";

export interface CodexExecKnowledgeQueryModelOptions {
  /** Fixed operator-owned directory; never derived from the question or knowledge. */
  readonly cwd: string;
  readonly diagnostics: CodexKnowledgeQueryDiagnosticStore;
  readonly executable?: string;
  readonly model?: string;
  readonly process?: CodexExecProcessPort;
  readonly timeoutMs?: number;
  readonly maxPromptBytes?: number;
  readonly maxResultBytes?: number;
  readonly maxJsonlBytes?: number;
  readonly maxStderrBytes?: number;
  readonly maxKnowledgeItems?: number;
  readonly maxKnowledgeBytes?: number;
  readonly concurrency?: number;
  readonly maxQueue?: number;
  readonly userConfiguration?: CodexUserConfigurationPolicy;
  readonly mcpConfiguration?: CodexMcpConfigurationPolicy;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly clock?: () => Date;
  readonly runIdFactory?: () => string;
}

export class InMemoryCodexKnowledgeQueryDiagnosticStore implements CodexKnowledgeQueryDiagnosticStore {
  readonly #maximum: number;
  readonly #records: CodexKnowledgeQueryRunDiagnostic[] = [];

  constructor(maximum = 100) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 10_000) {
      throw new Error("maximum diagnostics must be between 1 and 10000");
    }
    this.#maximum = maximum;
  }

  async append(diagnostic: CodexKnowledgeQueryRunDiagnostic): Promise<void> {
    this.#records.push(Object.freeze({ ...diagnostic, usage: Object.freeze({ ...diagnostic.usage }) }));
    if (this.#records.length > this.#maximum) this.#records.splice(0, this.#records.length - this.#maximum);
  }

  list(): readonly CodexKnowledgeQueryRunDiagnostic[] {
    return Object.freeze([...this.#records]);
  }
}
