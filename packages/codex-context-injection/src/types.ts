import type { ContextEnvelope } from "@zhiloop/domain";
import type { RetrievalTrace } from "@zhiloop/retrieval-evaluation";

export interface UserPromptSubmitInput {
  readonly hook_event_name: "UserPromptSubmit";
  readonly session_id: string;
  readonly turn_id: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly transcript_path?: string | null;
  readonly model?: string;
  readonly permission_mode?: "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions";
}

export interface ActiveContextRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly prompt: string;
}

export interface ActiveContextResult {
  readonly envelope: ContextEnvelope;
  readonly trace: RetrievalTrace;
}

export interface ActiveContextProvider {
  retrieve(request: ActiveContextRequest, signal: AbortSignal): Promise<ActiveContextResult>;
}

export type InjectionRolloutMode = "OFF" | "SHADOW" | "ACTIVE";

export interface InjectionActivationEvidence {
  readonly datasetId: string;
  readonly datasetVersion: number;
  readonly configFingerprint: string;
  readonly defaultInjectionAllowed: true;
}

export interface InjectionRolloutSnapshot {
  readonly revision: number;
  readonly mode: InjectionRolloutMode;
  readonly evidence?: InjectionActivationEvidence;
}

export interface CodexUserPromptHookOutput {
  readonly continue: true;
  readonly hookSpecificOutput: {
    readonly hookEventName: "UserPromptSubmit";
    readonly additionalContext: string;
  };
}

export type UserPromptInjectionStatus =
  | "DISABLED"
  | "SHADOWED"
  | "INJECTED"
  | "NO_CONTEXT"
  | "ROLLED_BACK"
  | "INVALID_INPUT"
  | "TIMEOUT"
  | "PROVIDER_ERROR"
  | "INVALID_CONTEXT";

export interface UserPromptInjectionResult {
  readonly status: UserPromptInjectionStatus;
  readonly elapsedMs: number;
  readonly traceId?: string;
  readonly runId?: string;
  readonly output?: CodexUserPromptHookOutput;
  readonly diagnostic?: string;
}

export interface UserPromptInjectionServiceOptions {
  readonly deadlineMs?: number;
}
