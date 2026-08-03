import type { KnowledgeFeedbackEvent } from "@zhiloop/feedback-engine";

import type {
  FeedbackRecordResult,
  FeedbackRuntimePort,
  KnowledgeFeedbackRuntimeDependencies,
  McpUsageInput,
} from "./types.js";

function activeSignal(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("feedback operation was aborted");
}

function requireCurrentScope(
  value: Awaited<ReturnType<KnowledgeFeedbackRuntimeDependencies["eligibility"]["inspect"]>>,
): void {
  if (!value.exists || !value.current || !value.scopeMatched) {
    throw new Error("feedback target is stale, missing, or outside the active Scope");
  }
}

export class KnowledgeFeedbackRuntime implements FeedbackRuntimePort {
  constructor(private readonly dependencies: KnowledgeFeedbackRuntimeDependencies) {}

  async record(
    event: KnowledgeFeedbackEvent,
    version: number,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<FeedbackRecordResult> {
    activeSignal(signal);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error("feedback knowledge version is invalid");
    const eligibility = await this.dependencies.eligibility.inspect({
      assetId: event.assetId,
      version,
      scopeKey: event.scopeKey,
      signal,
    });
    activeSignal(signal);
    requireCurrentScope(eligibility);
    if ((event.action === "PIN" || event.action === "RELEVANT")
      && (!eligibility.statusEligible || eligibility.suppressed)) {
      throw new Error("positive feedback cannot make ineligible knowledge retrievable");
    }
    const result = this.dependencies.store.record(event);
    return {
      result,
      eligibleAfterWrite: event.action === "SUPPRESS"
        ? false
        : eligibility.statusEligible && !eligibility.suppressed,
    };
  }

  async recordUsage(input: McpUsageInput, signal: AbortSignal = new AbortController().signal): Promise<"RECORDED" | "EXISTING"> {
    activeSignal(signal);
    const eligibility = await this.dependencies.eligibility.inspect({
      assetId: input.assetId,
      version: input.version,
      scopeKey: input.scopeKey,
      signal,
    });
    activeSignal(signal);
    requireCurrentScope(eligibility);
    if (!eligibility.statusEligible || eligibility.suppressed) {
      throw new Error("MCP use feedback cannot revive ineligible knowledge");
    }
    return this.dependencies.store.recordUsage({
      usageEventId: input.usageEventId,
      expansionId: input.expansionId,
      traceId: input.traceId,
      occurredAt: input.occurredAt,
    });
  }

  profile(scopeKey: string) {
    return this.dependencies.store.profile(scopeKey);
  }
}
