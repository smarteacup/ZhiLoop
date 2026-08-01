import { describe, expect, it } from "vitest";

import type { Episode, KnowledgeExtractionOutput } from "@zhiloop/domain";

import { KnowledgeExtractionAdapterError } from "./adapter-error.js";
import { toKnowledgeExtractionInput } from "./input.js";
import { knowledgeExtractionKey, runKnowledgeExtraction } from "./runner.js";
import type {
  KnowledgeExtractionPort,
  KnowledgeExtractionRequest,
  KnowledgeExtractionScheduler,
} from "./types.js";

function extractionEpisode(): Episode {
  return {
    episodeId: "episode-1",
    builderVersion: "episode-builder-v1",
    sessionIds: ["session-1"],
    turnIds: ["turn-1"],
    projectContext: { projectId: "project-1", repositoryRoot: "/repo", portable: false },
    goal: "Use a model-independent extraction port",
    goalRef: "event-goal",
    subgoals: [],
    userCorrections: [],
    actions: [],
    artifacts: [],
    outcomes: [],
    evidenceRefs: ["event-start", "event-goal", "event-end"],
    status: "COMPLETED",
    createdAt: "2026-08-01T08:00:00.000Z",
    updatedAt: "2026-08-01T08:00:01.000Z",
  };
}

function request(overrides: Partial<KnowledgeExtractionRequest> = {}): KnowledgeExtractionRequest {
  return {
    input: toKnowledgeExtractionInput(extractionEpisode()),
    compilerVersion: "compiler-v1",
    promptVersion: "prompt-v1",
    requestedAt: "2026-08-01T09:00:00.000Z",
    correlationId: "correlation-1",
    ...overrides,
  };
}

function validOutput(overrides: Record<string, unknown> = {}): KnowledgeExtractionOutput {
  return {
    schemaVersion: 1,
    candidates: [{
      subjectKey: "decision.knowledge.extraction-port",
      kind: "DECISION",
      scopeHint: { level: "PROJECT", projectId: "project-1", reasonCodes: ["EPISODE_PROJECT"] },
      title: "Use a model-independent port",
      summary: "Keep model SDKs behind the extraction port.",
      body: "The runner validates the complete structured response before materializing candidates.",
      confidence: 0.9,
      assertions: [{ kind: "USER_ACCEPTED", parameters: { statementRef: "event-goal" } }],
      evidenceHints: [{ type: "USER_STATEMENT", sourceRef: "event-goal", projectId: "project-1" }],
      ...overrides,
    }],
  } as KnowledgeExtractionOutput;
}

const options = { maxAttempts: 1, retryDelayMs: 0, perAttemptTimeoutMs: 1_000 } as const;

describe("runKnowledgeExtraction", () => {
  it("materializes a fully stamped Candidate from a valid draft batch", async () => {
    const seen: unknown[] = [];
    const output = validOutput();
    const port: KnowledgeExtractionPort = {
      extract: async (input, context) => {
        seen.push({ input, context });
        return output;
      },
    };

    const result = await runKnowledgeExtraction(request(), port, options);
    expect(result).toMatchObject({
      status: "SUCCEEDED",
      attempts: 1,
      episodeId: "episode-1",
      builderVersion: "episode-builder-v1",
      compilerVersion: "compiler-v1",
      promptVersion: "prompt-v1",
    });
    if (result.status !== "SUCCEEDED") throw new Error("expected success");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      compilerVersion: "compiler-v1",
      sourceEpisodes: ["episode-1"],
      createdAt: "2026-08-01T09:00:00.000Z",
      correlationId: "correlation-1",
    });
    expect(result.candidates[0]?.assertions[0]).toMatchObject({
      candidateId: result.candidates[0]?.candidateId,
      createdAt: "2026-08-01T09:00:00.000Z",
    });
    expect(result.candidates[0]?.evidenceHints[0]?.correlationId).toBe("correlation-1");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.candidates[0]?.assertions[0]?.parameters)).toBe(true);
    expect(seen).toHaveLength(1);
    expect((seen[0] as { context: { promptVersion: string; attempt: number } }).context).toMatchObject({
      promptVersion: "prompt-v1",
      attempt: 1,
    });
    expect(Object.isFrozen((seen[0] as { input: unknown }).input)).toBe(true);
    expect(Object.isFrozen(output.candidates[0]?.scopeHint.reasonCodes)).toBe(false);
  });

  it("returns deterministic keys and Candidate IDs for the same versioned request", async () => {
    const source = request();
    const port: KnowledgeExtractionPort = { extract: async () => validOutput() };
    const first = await runKnowledgeExtraction(source, port, options);
    const replay = await runKnowledgeExtraction({ ...source, correlationId: "other", requestedAt: "2026-08-02T09:00:00.000Z" }, port, options);
    expect(replay.extractionKey).toBe(first.extractionKey);
    expect(knowledgeExtractionKey(source)).toBe(first.extractionKey);
    expect(replay.candidates[0]?.candidateId).toBe(first.candidates[0]?.candidateId);
    expect(knowledgeExtractionKey({ ...source, promptVersion: "prompt-v2" })).not.toBe(first.extractionKey);
    expect(knowledgeExtractionKey({ ...source, compilerVersion: "compiler-v2" })).not.toBe(first.extractionKey);
    expect(knowledgeExtractionKey({ ...source, input: { ...source.input, builderVersion: "builder-v2" } })).not.toBe(first.extractionKey);
    expect(knowledgeExtractionKey({ ...source, input: { ...source.input, goal: "updated Episode goal" } })).not.toBe(first.extractionKey);
  });

  it("accepts an empty valid batch as a successful no-knowledge result", async () => {
    const result = await runKnowledgeExtraction(request(), { extract: async () => ({ schemaVersion: 1, candidates: [] }) }, options);
    expect(result).toMatchObject({ status: "SUCCEEDED", candidates: [] });
  });

  it("rejects the complete batch when any draft is schema-invalid", async () => {
    const output = validOutput();
    const invalid = {
      ...output,
      candidates: [...output.candidates, { ...output.candidates[0], title: "" }],
    };
    const result = await runKnowledgeExtraction(request(), { extract: async () => invalid }, options);
    expect(result).toMatchObject({ status: "RETRYABLE", reason: "INVALID_OUTPUT", candidates: [] });
    expect(result.diagnostics.some((item) => item.code === "SCHEMA_INVALID")).toBe(true);
  });

  it("diagnoses unsupported output versions without returning candidates", async () => {
    const result = await runKnowledgeExtraction(request(), {
      extract: async () => ({ ...validOutput(), schemaVersion: 2 }),
    }, options);
    expect(result).toMatchObject({ status: "RETRYABLE", reason: "INVALID_OUTPUT", candidates: [] });
    expect(result.diagnostics).toEqual([{ code: "SCHEMA_INVALID", path: "/schemaVersion" }]);
  });

  it("rejects oversized structured output text", async () => {
    const result = await runKnowledgeExtraction(request(), {
      extract: async () => validOutput({ body: "x".repeat(32_001) }),
    }, options);
    expect(result).toMatchObject({ status: "RETRYABLE", reason: "INVALID_OUTPUT", candidates: [] });
    expect(result.diagnostics).toContainEqual({ code: "SCHEMA_INVALID", path: "/candidates/0/body" });
  });

  it("rejects hallucinated source references atomically", async () => {
    const result = await runKnowledgeExtraction(request(), {
      extract: async () => validOutput({
        evidenceHints: [{ type: "USER_STATEMENT", sourceRef: "invented-event" }],
      }),
    }, options);
    expect(result).toMatchObject({ status: "RETRYABLE", reason: "INVALID_OUTPUT", candidates: [] });
    expect(result.diagnostics).toContainEqual({
      code: "UNREFERENCED_SOURCE",
      path: "/candidates/0/evidenceHints/0/sourceRef",
    });
  });

  it("rejects project scope, assertion, and evidence mismatches", async () => {
    const result = await runKnowledgeExtraction(request(), {
      extract: async () => validOutput({
        scopeHint: { level: "PROJECT", projectId: "other", repositoryRemote: "git@other/repo", reasonCodes: [] },
        assertions: [{ kind: "SYMBOL_EXISTS", parameters: { projectId: "other", symbol: "Compiler" } }],
        evidenceHints: [{ type: "CODE_SYMBOL", sourceRef: "event-goal", projectId: "other" }],
      }),
    }, options);
    expect(result).toMatchObject({ status: "RETRYABLE", reason: "INVALID_OUTPUT", candidates: [] });
    expect(result.diagnostics.filter((item) => item.code === "PROJECT_MISMATCH")).toHaveLength(4);
  });

  it("retries transient adapter failures and then succeeds", async () => {
    let calls = 0;
    const result = await runKnowledgeExtraction(request(), {
      extract: async () => {
        calls += 1;
        if (calls < 3) throw new Error("model unavailable");
        return validOutput();
      },
    }, { ...options, maxAttempts: 3 });
    expect(result).toMatchObject({ status: "SUCCEEDED", attempts: 3 });
    expect(calls).toBe(3);
  });

  it("can recover from a malformed model response on a later attempt", async () => {
    let calls = 0;
    const result = await runKnowledgeExtraction(request(), {
      extract: async () => (++calls === 1 ? { schemaVersion: 1, candidates: [{ broken: true }] } : validOutput()),
    }, { ...options, maxAttempts: 2 });
    expect(result).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
  });

  it("returns RETRYABLE with zero candidates after timeout exhaustion", async () => {
    let aborted = 0;
    const result = await runKnowledgeExtraction(request(), {
      extract: async (_input, context) => new Promise((resolve) => {
        context.signal.addEventListener("abort", () => {
          aborted += 1;
          resolve(validOutput());
        }, { once: true });
      }),
    }, { perAttemptTimeoutMs: 5, maxAttempts: 2, retryDelayMs: 0 });
    expect(result).toMatchObject({ status: "RETRYABLE", reason: "TIMEOUT", attempts: 2, candidates: [] });
    expect(aborted).toBe(2);
  });

  it("does not retry an explicit terminal adapter rejection", async () => {
    let calls = 0;
    const result = await runKnowledgeExtraction(request(), {
      extract: async () => {
        calls += 1;
        throw new KnowledgeExtractionAdapterError("REJECTED", false);
      },
    }, { ...options, maxAttempts: 3 });
    expect(result).toMatchObject({ status: "FAILED", reason: "ADAPTER_REJECTED", attempts: 1, candidates: [] });
    expect(calls).toBe(1);
  });

  it("retries an explicitly retryable adapter error", async () => {
    let calls = 0;
    const result = await runKnowledgeExtraction(request(), {
      extract: async () => {
        calls += 1;
        throw new KnowledgeExtractionAdapterError("RATE_LIMITED", true);
      },
    }, { ...options, maxAttempts: 2 });
    expect(result).toMatchObject({ status: "RETRYABLE", reason: "ADAPTER_UNAVAILABLE", attempts: 2 });
    expect(calls).toBe(2);
  });

  it("honors an already-aborted parent signal without calling the adapter", async () => {
    const controller = new AbortController();
    controller.abort("cancelled");
    let calls = 0;
    const result = await runKnowledgeExtraction(request(), {
      extract: async () => {
        calls += 1;
        return validOutput();
      },
    }, { ...options, signal: controller.signal });
    expect(result).toMatchObject({ status: "FAILED", reason: "ABORTED", attempts: 0, candidates: [] });
    expect(calls).toBe(0);
  });

  it("counts an in-flight attempt when the parent aborts the adapter", async () => {
    const controller = new AbortController();
    const resultPromise = runKnowledgeExtraction(request(), {
      extract: async (_input, context) => new Promise((resolve) => {
        context.signal.addEventListener("abort", () => resolve(validOutput()), { once: true });
        controller.abort("cancelled");
      }),
    }, { ...options, signal: controller.signal });
    await expect(resultPromise).resolves.toMatchObject({
      status: "FAILED",
      reason: "ABORTED",
      attempts: 1,
      candidates: [],
    });
  });

  it("aborts while waiting between retry attempts", async () => {
    const parent = new AbortController();
    const scheduler: KnowledgeExtractionScheduler = {
      sleep: async (_delay, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        parent.abort("cancelled");
      }),
    };
    const result = await runKnowledgeExtraction(request(), {
      extract: async () => { throw new Error("offline"); },
    }, { ...options, maxAttempts: 3, retryDelayMs: 1, signal: parent.signal, scheduler });
    expect(result).toMatchObject({ status: "FAILED", reason: "ABORTED", attempts: 1, candidates: [] });
  });

  it("does not misreport an independent retry scheduler failure as user cancellation", async () => {
    const scheduler: KnowledgeExtractionScheduler = {
      sleep: async () => { throw new Error("scheduler unavailable"); },
    };
    const result = await runKnowledgeExtraction(request(), {
      extract: async () => { throw new Error("offline"); },
    }, { ...options, maxAttempts: 3, retryDelayMs: 1, scheduler });
    expect(result).toMatchObject({
      status: "RETRYABLE",
      reason: "RETRY_SCHEDULER_FAILED",
      attempts: 1,
      candidates: [],
    });
  });

  it("validates request identity, timestamps, evidence, and retry options", async () => {
    const port: KnowledgeExtractionPort = { extract: async () => validOutput() };
    const source = request();
    await expect(runKnowledgeExtraction({ ...source, compilerVersion: "bad version" }, port, options)).rejects.toThrow("compilerVersion");
    await expect(runKnowledgeExtraction({ ...source, promptVersion: "" }, port, options)).rejects.toThrow("promptVersion");
    await expect(runKnowledgeExtraction({ ...source, requestedAt: "2026-02-30T09:00:00Z" }, port, options)).rejects.toThrow("requestedAt");
    await expect(runKnowledgeExtraction({
      ...source,
      input: { ...source.input, evidenceRefs: ["event-goal", "event-goal"] },
    }, port, options)).rejects.toThrow("unique");
    await expect(runKnowledgeExtraction({
      ...source,
      input: { ...source.input, goalRef: "missing" },
    }, port, options)).rejects.toThrow("goalRef");
    await expect(runKnowledgeExtraction(source, port, { ...options, perAttemptTimeoutMs: 0 })).rejects.toThrow("perAttemptTimeoutMs");
    await expect(runKnowledgeExtraction(source, port, { ...options, maxAttempts: 11 })).rejects.toThrow("maxAttempts");
    await expect(runKnowledgeExtraction(source, port, { ...options, retryDelayMs: -1 })).rejects.toThrow("retryDelayMs");
  });

  it("rejects an extraction input beyond the hard canonical size limit", async () => {
    const source = request();
    await expect(runKnowledgeExtraction({
      ...source,
      input: {
        ...source.input,
        artifacts: [{ kind: "FILE", uri: "x".repeat(4_000_001) }],
      },
    }, { extract: async () => validOutput() }, options)).rejects.toThrow("must not exceed");
  });
});
