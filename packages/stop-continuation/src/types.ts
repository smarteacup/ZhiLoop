import type { ClosureVerificationInput } from "@zhiloop/closure-verifier";
import type { ClosurePolicy } from "@zhiloop/config";
import type { ClosureVerificationResult } from "@zhiloop/domain";
import type { KnowledgeMcpExpansionDelta } from "@zhiloop/knowledge-mcp";

export interface StopHookInput {
  readonly hook_event_name: "Stop";
  readonly session_id: string;
  readonly turn_id: string;
  readonly cwd: string;
  readonly stop_hook_active: boolean;
  readonly last_assistant_message: string | null;
}

export interface StopClosurePort {
  verify(input: ClosureVerificationInput, policy: ClosurePolicy, signal: AbortSignal): Promise<ClosureVerificationResult>;
}

export interface StopContextDeltaPort {
  load(knowledgeIds: readonly string[], signal: AbortSignal): Promise<{
    readonly traceId: string;
    readonly items: readonly KnowledgeMcpExpansionDelta[];
  }>;
}

export interface ContinuationCounterStore {
  get(key: string): number;
  claim(key: string, maximum: number): boolean;
}

export interface CodexStopHookOutput {
  readonly decision: "block";
  readonly reason: string;
}

export type StopContinuationStatus =
  | "PASS"
  | "CONTINUED_WITH_CONTEXT"
  | "CONTINUED_WITH_CORRECTION"
  | "ASK_USER"
  | "HOOK_ALREADY_ACTIVE"
  | "LIMIT_REACHED"
  | "INVALID_INPUT"
  | "UNKNOWN";

export interface StopContinuationResult {
  readonly status: StopContinuationStatus;
  readonly decision?: ClosureVerificationResult["decision"];
  readonly continuationCount: number;
  readonly output?: CodexStopHookOutput;
  readonly diagnostic?: string;
}

export interface StopContinuationRequest {
  readonly hook: StopHookInput;
  readonly closureInput: ClosureVerificationInput;
  readonly risk?: "LOW" | "MEDIUM" | "HIGH";
}

export interface StopContinuationOptions {
  readonly outerHookTimeoutMs: number;
}
