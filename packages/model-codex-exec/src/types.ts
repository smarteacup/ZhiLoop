export interface CodexExecProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin: string;
  readonly signal: AbortSignal;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  /** When supplied, replaces rather than extends the child environment. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface CodexExecProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CodexExecProcessPort {
  run(request: CodexExecProcessRequest): Promise<CodexExecProcessResult>;
}

export interface CodexExecUsageDiagnostic {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
}

export interface CodexExecEventDiagnostic {
  readonly type: string;
  readonly itemType?: string;
  readonly status?: string;
  readonly errorCode?: string;
  readonly usage?: CodexExecUsageDiagnostic;
}

export type CodexExecRunOutcome = "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface CodexExecRunDiagnostic {
  readonly extractionKey: string;
  readonly attempt: number;
  readonly outcome: CodexExecRunOutcome;
  readonly exitCode?: number | null;
  readonly terminationSignal?: NodeJS.Signals | null;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly events: readonly CodexExecEventDiagnostic[];
}

export interface CodexExecStructuredGenerationModelOptions {
  readonly cwd: string;
  readonly executable?: string;
  readonly model?: string;
  readonly process?: CodexExecProcessPort;
  readonly timeoutMs?: number;
  readonly maxPromptBytes?: number;
  readonly maxResultBytes?: number;
  readonly maxJsonlBytes?: number;
  readonly maxStderrBytes?: number;
  readonly maxDiagnosticRuns?: number;
  readonly ignoreUserConfig?: boolean;
}

/** Generic read-only JSON generation boundary shared by bounded ZhiLoop model adapters. */
export interface CodexExecJsonGenerationRequest {
  readonly operation: "KNOWLEDGE_EXTRACTION" | "SEMANTIC_EVOLUTION";
  readonly promptVersion: string;
  readonly trustedInstructions: string;
  readonly untrustedInput: unknown;
  readonly responseSchema: Readonly<Record<string, unknown>>;
}

export interface CodexExecJsonGenerationContext {
  readonly runKey: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
}

export interface CodexExecJsonGenerationPort {
  generateStructured(request: CodexExecJsonGenerationRequest, context: CodexExecJsonGenerationContext): Promise<unknown>;
}
