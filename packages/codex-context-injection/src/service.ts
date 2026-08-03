import { performance } from "node:perf_hooks";

import type { ContextEnvelopeItem, KnowledgeScope } from "@zhiloop/domain";
import { estimateAdditionalContextTokens } from "@zhiloop/context-renderer";
import { fingerprintRetrievalConfiguration } from "@zhiloop/retrieval-evaluation";

import { renderAdditionalContext } from "./renderer.js";
import type { InjectionRolloutController } from "./rollout.js";
import type {
  ActiveContextProvider,
  ActiveContextResult,
  UserPromptInjectionResult,
  UserPromptInjectionServiceOptions,
  UserPromptSubmitInput,
} from "./types.js";

const MAX_DEADLINE_MS = 500;
const PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"]);

class InjectionTimeoutError extends Error {}

function validText(value: unknown, maximum: number, multiline = false): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum
    && !/[\0]/u.test(value) && (multiline || !/[\r\n]/u.test(value));
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return value.replace(/[\0\r\n]/gu, " ").slice(0, 500);
}

function scopeMatches(scope: KnowledgeScope, context: ActiveContextResult["trace"]["query"]): boolean {
  switch (scope.level) {
    case "GLOBAL": return context.allowGlobalKnowledge;
    case "PROJECT": case "MODULE": case "SYMBOL": return context.allowProjectKnowledge
      && context.projectId !== undefined && scope.projectId === context.projectId;
    case "TASK": return context.taskId !== undefined && scope.taskId === context.taskId
      && (scope.projectId === undefined || scope.projectId === context.projectId);
    case "USER": case "TEAM": return false;
  }
}

function sameInjection(
  envelope: readonly ContextEnvelopeItem[],
  trace: ActiveContextResult["trace"]["injection"]["items"],
): boolean {
  if (envelope.length !== trace.length) return false;
  return envelope.every((item, index) => {
    const expected = trace[index];
    return expected !== undefined && item.id === expected.id && item.version === expected.version
      && item.authority === expected.authority && item.detailLevel === expected.detailLevel
      && JSON.stringify(item.scope) === JSON.stringify(expected.scope);
  });
}

function validContext(value: ActiveContextResult, input: UserPromptSubmitInput): boolean {
  const { envelope, trace } = value;
  return validText(trace.traceId, 500) && validText(trace.runId, 500)
    && trace.runId === envelope.runId
    && trace.query.promptFingerprint === fingerprintRetrievalConfiguration(input.prompt)
    && trace.query.projectId === envelope.projectId && trace.query.taskId === envelope.taskId
    && trace.complexity.level === envelope.complexity.level
    && trace.complexity.estimatedTokens === envelope.budget.estimatedTokens
    && trace.complexity.maxTokens === envelope.budget.maxTokens
    && Number.isSafeInteger(envelope.budget.maxTokens) && envelope.budget.maxTokens >= 1
    && Number.isSafeInteger(envelope.budget.estimatedTokens) && envelope.budget.estimatedTokens >= 1
    && envelope.budget.estimatedTokens <= envelope.budget.maxTokens
    && Number.isSafeInteger(envelope.budget.disclosedItems)
    && envelope.budget.disclosedItems === envelope.items.length
    && Number.isSafeInteger(envelope.budget.omittedItems) && envelope.budget.omittedItems >= 0
    && (envelope.budget.omittedItems === 0 || envelope.budget.truncated)
    && estimateAdditionalContextTokens(envelope, trace.traceId) === envelope.budget.estimatedTokens
    && sameInjection(envelope.items, trace.injection.items)
    && envelope.items.every((item) => scopeMatches(item.scope, trace.query));
}

function validInput(input: UserPromptSubmitInput): boolean {
  return input.hook_event_name === "UserPromptSubmit"
    && validText(input.session_id, 500) && validText(input.turn_id, 500)
    && validText(input.cwd, 4_096) && validText(input.prompt, 20_000, true)
    && (input.transcript_path === undefined || input.transcript_path === null
      || validText(input.transcript_path, 4_096))
    && (input.model === undefined || validText(input.model, 500))
    && (input.permission_mode === undefined || PERMISSION_MODES.has(input.permission_mode));
}

export class UserPromptInjectionService {
  private readonly deadlineMs: number;

  constructor(
    private readonly provider: ActiveContextProvider,
    private readonly rollout: InjectionRolloutController,
    options: UserPromptInjectionServiceOptions = {},
  ) {
    this.deadlineMs = options.deadlineMs ?? MAX_DEADLINE_MS;
    if (!Number.isSafeInteger(this.deadlineMs) || this.deadlineMs < 1 || this.deadlineMs > MAX_DEADLINE_MS) {
      throw new Error("deadlineMs must be an integer within 1..500");
    }
  }

  async handle(input: UserPromptSubmitInput): Promise<UserPromptInjectionResult> {
    const startedAt = performance.now();
    const elapsed = (): number => Math.max(0, performance.now() - startedAt);
    if (!validInput(input)) return { status: "INVALID_INPUT", elapsedMs: elapsed() };
    const rolloutAtStart = this.rollout.snapshot;
    if (rolloutAtStart.mode === "OFF") return { status: "DISABLED", elapsedMs: elapsed() };

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadlineExceeded = false;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        deadlineExceeded = true;
        controller.abort(new InjectionTimeoutError("UserPrompt injection deadline exceeded"));
        reject(new InjectionTimeoutError("UserPrompt injection deadline exceeded"));
      }, this.deadlineMs);
      timer.unref?.();
    });

    try {
      const context = await Promise.race([
        this.provider.retrieve({
          sessionId: input.session_id, turnId: input.turn_id, cwd: input.cwd, prompt: input.prompt,
        }, controller.signal),
        timeout,
      ]);
      if (!validContext(context, input)) {
        return { status: "INVALID_CONTEXT", elapsedMs: elapsed(), diagnostic: "provider returned inconsistent or out-of-scope context" };
      }
      if (this.rollout.snapshot.revision !== rolloutAtStart.revision
        || this.rollout.snapshot.mode !== rolloutAtStart.mode) {
        return { status: "ROLLED_BACK", elapsedMs: elapsed(), traceId: context.trace.traceId, runId: context.trace.runId };
      }
      if (context.envelope.items.length === 0 && context.envelope.taskContract === undefined) {
        return { status: "NO_CONTEXT", elapsedMs: elapsed(), traceId: context.trace.traceId, runId: context.trace.runId };
      }
      if (rolloutAtStart.mode === "SHADOW") {
        return { status: "SHADOWED", elapsedMs: elapsed(), traceId: context.trace.traceId, runId: context.trace.runId };
      }
      const additionalContext = renderAdditionalContext(context.envelope, context.trace.traceId);
      return {
        status: "INJECTED", elapsedMs: elapsed(), traceId: context.trace.traceId, runId: context.trace.runId,
        output: {
          continue: true,
          hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext },
        },
      };
    } catch (error) {
      const timedOut = deadlineExceeded || error instanceof InjectionTimeoutError;
      return {
        status: timedOut ? "TIMEOUT" : "PROVIDER_ERROR",
        elapsedMs: elapsed(),
        diagnostic: safeError(error),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
