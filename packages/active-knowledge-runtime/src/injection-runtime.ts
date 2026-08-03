import { createHash } from "node:crypto";

import {
  serializeUserPromptHookResult,
  UserPromptInjectionService,
} from "@zhiloop/codex-context-injection";
import { buildRetrievalTrace } from "@zhiloop/retrieval-evaluation";

import type {
  ActiveInjectionRuntimeDependencies,
  ActiveInjectionRuntimeResult,
  ActiveKnowledgeRetrievalResult,
  UserPromptSubmitInput,
} from "./types.js";

type UnauditedTerminalStatus = "TIMEOUT" | "ERROR";

function scopeKey(value: ActiveKnowledgeRetrievalResult["queryContext"]): string {
  if (value.taskId !== undefined) return JSON.stringify({
    level: "TASK",
    ...(value.project === undefined ? {} : { projectId: value.project.projectId }),
    taskId: value.taskId,
  });
  return value.project === undefined
    ? JSON.stringify({ level: "GLOBAL" })
    : JSON.stringify({ level: "PROJECT", projectId: value.project.projectId });
}

function attemptId(parts: readonly string[]): string {
  return `injection-${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}`;
}

function terminalStatus(status: Awaited<ReturnType<UserPromptInjectionService["handle"]>>["status"]): {
  readonly status: "SHADOWED" | "INJECTED" | "NO_CONTEXT" | "ROLLED_BACK" | "TIMEOUT" | "ERROR";
  readonly reason: string;
} {
  switch (status) {
    case "SHADOWED": return { status: "SHADOWED", reason: "ROLLOUT_SHADOW" };
    case "INJECTED": return { status: "INJECTED", reason: "HOOK_CONTEXT_GENERATED" };
    case "NO_CONTEXT": return { status: "NO_CONTEXT", reason: "NO_ELIGIBLE_CONTEXT" };
    case "ROLLED_BACK": return { status: "ROLLED_BACK", reason: "ROLLOUT_REVISION_CHANGED" };
    case "TIMEOUT": return { status: "TIMEOUT", reason: "USER_PROMPT_DEADLINE_EXCEEDED" };
    case "DISABLED": return { status: "ERROR", reason: "ROLLOUT_DISABLED_DURING_ATTEMPT" };
    case "INVALID_INPUT": return { status: "ERROR", reason: "INVALID_HOOK_INPUT" };
    case "PROVIDER_ERROR": return { status: "ERROR", reason: "RETRIEVAL_PROVIDER_ERROR" };
    case "INVALID_CONTEXT": return { status: "ERROR", reason: "CONTEXT_VALIDATION_FAILED" };
  }
}

export class ActiveKnowledgeInjectionRuntime {
  readonly #now: () => Date;

  constructor(private readonly dependencies: ActiveInjectionRuntimeDependencies) {
    this.#now = dependencies.now ?? (() => new Date());
  }

  #auditUnavailableRetrieval(
    input: UserPromptSubmitInput,
    rolloutRevision: number,
    status: UnauditedTerminalStatus,
    reasonCode: string,
  ) {
    const identity = [input.session_id, input.turn_id, String(rolloutRevision), "RETRIEVAL_UNAVAILABLE"];
    const runId = `run-unavailable-${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 24)}`;
    const traceId = `trace-unavailable-${createHash("sha256").update(JSON.stringify([...identity, "trace"])).digest("hex").slice(0, 24)}`;
    const id = attemptId([input.session_id, input.turn_id, traceId, runId, String(rolloutRevision)]);
    const envelope = {
      schemaVersion: 1 as const,
      runId,
      complexity: {
        level: "L0_NONE" as const,
        breadth: 0,
        depth: "NONE" as const,
        authority: "NONE" as const,
        evidence: "NONE" as const,
        reasonCodes: ["RETRIEVAL_NOT_COMPLETED"],
      },
      budget: {
        maxTokens: this.dependencies.injectionPolicy().defaultMaxTokens,
        estimatedTokens: 0,
        truncated: false,
        disclosedItems: 0,
        omittedItems: 0,
      },
      items: [],
    };
    const createdAt = this.#now().toISOString();
    const expected = {
      schemaVersion: 1 as const,
      attemptId: id,
      sessionId: input.session_id,
      turnId: input.turn_id,
      traceId,
      runId,
      rolloutRevision,
      status: "PENDING" as const,
      revision: 0,
      envelope,
      reasonCode: "RETRIEVAL_PENDING",
      createdAt,
    };
    const existing = this.dependencies.audits.getInjection(id);
    if (existing !== undefined && (
      existing.sessionId !== expected.sessionId || existing.turnId !== expected.turnId
      || existing.traceId !== traceId || existing.runId !== runId
      || existing.rolloutRevision !== rolloutRevision || JSON.stringify(existing.envelope) !== JSON.stringify(envelope)
    )) throw new Error("fallback injection attempt identity conflicts with the failed retrieval");
    const pending = existing ?? this.dependencies.audits.beginInjection(expected);
    if (pending.status !== "PENDING") {
      if (pending.status !== status || pending.reasonCode !== reasonCode) {
        throw new Error("persisted fallback injection result conflicts with the failed retrieval");
      }
      return pending;
    }
    return this.dependencies.audits.completeInjection(
      pending.attemptId,
      pending.revision,
      status,
      reasonCode,
      this.#now().toISOString(),
    );
  }

  async #retrieve(
    request: { readonly sessionId: string; readonly turnId: string; readonly cwd: string; readonly prompt: string },
    signal: AbortSignal,
  ) {
    const retrieved = await this.dependencies.retrieval.retrieve(request, signal);
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("active retrieval was aborted");
    const key = scopeKey(retrieved.queryContext);
    const feedback = this.dependencies.feedback.profile(key);
    const feedbackSuppressed = new Set(feedback.suppressedAssetIds);
    const feedbackPinned = new Set(feedback.pinnedAssetIds);
    const checks = await Promise.all(retrieved.candidates.map(async (candidate) => ({
      candidate,
      eligibility: await this.dependencies.eligibility.inspect({
        assetId: candidate.asset.id,
        version: candidate.asset.version,
        scopeKey: key,
        signal,
      }),
    })));
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("active retrieval was aborted");
    const eligibleIds = new Set(checks.filter(({ candidate, eligibility }) => (
      eligibility.exists && eligibility.current && eligibility.scopeMatched
      && eligibility.statusEligible && !eligibility.suppressed
      && !feedbackSuppressed.has(candidate.asset.id)
    )).map(({ candidate }) => candidate.asset.id));
    const candidates = retrieved.candidates.filter((candidate) => eligibleIds.has(candidate.asset.id))
      .sort((left, right) => Number(feedbackPinned.has(right.asset.id)) - Number(feedbackPinned.has(left.asset.id))
        || left.rank - right.rank || left.asset.id.localeCompare(right.asset.id))
      .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
    const retrieval = {
      items: retrieved.retrieval.items.filter((item) => eligibleIds.has(item.asset.id)),
      diagnostics: [
        ...retrieved.retrieval.diagnostics,
        ...checks.filter(({ candidate }) => !eligibleIds.has(candidate.asset.id)).map(({ candidate, eligibility }) => ({
          code: eligibility.scopeMatched ? "STATUS_FILTERED" as const : "SCOPE_FILTERED" as const,
          channel: "EXACT" as const,
          message: "active eligibility gate excluded the candidate",
          ...(eligibility.scopeMatched ? { assetId: candidate.asset.id } : {}),
        })),
      ],
    };
    const rerank = {
      items: candidates,
      diagnostics: retrieved.rerank.diagnostics,
    };
    const envelope = this.dependencies.orchestrator.orchestrate({
      runId: retrieved.runId,
      traceId: retrieved.traceId,
      queryContext: retrieved.queryContext,
      candidates,
      policy: this.dependencies.injectionPolicy(),
      ...(retrieved.requestedLevel === undefined ? {} : { requestedLevel: retrieved.requestedLevel }),
      automatic: true,
      ...(retrieved.signals === undefined ? {} : { signals: retrieved.signals }),
      ...(retrieved.taskContract === undefined ? {} : { taskContract: retrieved.taskContract }),
      feedback: {
        scopeKey: feedback.scopeKey,
        preferredLevel: feedback.preferredLevel,
        sampleCount: feedback.sampleCount,
        reasonCodes: feedback.reasonCodes,
      },
    });
    const trace = buildRetrievalTrace({
      traceId: retrieved.traceId,
      runId: retrieved.runId,
      queryContext: retrieved.queryContext,
      retrieval,
      rerank,
      envelope,
      ...(retrieved.signals === undefined ? {} : { signals: retrieved.signals }),
      automatic: true,
    });
    return { envelope, trace };
  }

  async handle(input: UserPromptSubmitInput): Promise<ActiveInjectionRuntimeResult> {
    const rolloutAtStart = this.dependencies.rollout.snapshot;
    const holder: {
      record?: ReturnType<ActiveInjectionRuntimeDependencies["audits"]["beginInjection"]>;
      attemptedPersistence?: boolean;
    } = {};
    try {
      const service = new UserPromptInjectionService({
        retrieve: async (request, signal) => {
          const context = await this.#retrieve(request, signal);
          const id = attemptId([
            request.sessionId,
            request.turnId,
            context.trace.traceId,
            context.trace.runId,
            String(rolloutAtStart.revision),
          ]);
          holder.attemptedPersistence = true;
          const existing = this.dependencies.audits.getInjection(id);
          if (existing !== undefined && (
            existing.sessionId !== request.sessionId
            || existing.turnId !== request.turnId
            || existing.traceId !== context.trace.traceId
            || existing.runId !== context.trace.runId
            || existing.rolloutRevision !== rolloutAtStart.revision
            || JSON.stringify(existing.envelope) !== JSON.stringify(context.envelope)
          )) throw new Error("injection attempt identity conflicts with the exact Context Envelope");
          holder.record = existing ?? this.dependencies.audits.beginInjection({
            schemaVersion: 1,
            attemptId: id,
            sessionId: request.sessionId,
            turnId: request.turnId,
            traceId: context.trace.traceId,
            runId: context.trace.runId,
            rolloutRevision: rolloutAtStart.revision,
            status: "PENDING",
            revision: 0,
            envelope: context.envelope,
            reasonCode: "DELIVERY_PENDING",
            createdAt: this.#now().toISOString(),
          });
          return context;
        },
      }, this.dependencies.rollout, {
        ...(this.dependencies.deadlineMs === undefined ? {} : { deadlineMs: this.dependencies.deadlineMs }),
      });
      const handled = await service.handle(input);
      if (handled.status === "DISABLED") return { status: "DISABLED" };
      if (handled.status === "INVALID_INPUT") return { status: "INVALID_INPUT" };
      const terminal = terminalStatus(handled.status);
      const pending = holder.record;
      if (pending === undefined) {
        const attempt = holder.attemptedPersistence !== true
          && (terminal.status === "TIMEOUT" || terminal.status === "ERROR")
          ? this.#auditUnavailableRetrieval(input, rolloutAtStart.revision, terminal.status, terminal.reason)
          : undefined;
        return {
          ...(attempt === undefined ? {} : { attempt }),
          status: terminal.status,
          ...(handled.diagnostic === undefined ? {} : { diagnostic: handled.diagnostic }),
        };
      }
      const current = this.dependencies.audits.getInjection(pending.attemptId);
      const completed = current !== undefined && current.status !== "PENDING"
        ? current
        : this.dependencies.audits.completeInjection(
          pending.attemptId,
          pending.revision,
          terminal.status,
          terminal.reason,
          this.#now().toISOString(),
        );
      if (completed.status !== terminal.status) throw new Error("persisted injection result conflicts with delivery result");
      return {
        attempt: completed,
        status: completed.status,
        ...(completed.status === "INJECTED" ? { hookOutput: serializeUserPromptHookResult(handled) } : {}),
        ...(handled.diagnostic === undefined ? {} : { diagnostic: handled.diagnostic }),
      };
    } catch (error) {
      let pending = holder.record;
      if (pending?.status === "PENDING") {
        try {
          const current = this.dependencies.audits.getInjection(pending.attemptId);
          pending = current !== undefined && current.status !== "PENDING"
            ? current
            : this.dependencies.audits.completeInjection(
              pending.attemptId,
              pending.revision,
              "ERROR",
              "RUNTIME_COMPOSITION_ERROR",
              this.#now().toISOString(),
            );
        } catch {
          // The Hook remains fail-open. Recovery can CAS the durable PENDING attempt on the next replay.
        }
      }
      if (pending === undefined && holder.attemptedPersistence !== true && rolloutAtStart.mode !== "OFF") {
        try {
          pending = this.#auditUnavailableRetrieval(
            input,
            rolloutAtStart.revision,
            "ERROR",
            "RUNTIME_COMPOSITION_ERROR",
          );
        } catch {
          // The Hook remains fail-open when even the fallback audit cannot be persisted.
        }
      }
      return {
        ...(pending === undefined ? {} : { attempt: pending }),
        status: "ERROR",
        diagnostic: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 500) : "UnknownError",
      };
    }
  }
}
