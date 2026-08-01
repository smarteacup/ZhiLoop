import { describe, expect, it } from "vitest";

import type { Episode, KnowledgeCandidateDraft, KnowledgeKind } from "@zhiloop/domain";

import { toKnowledgeExtractionInput } from "./input.js";
import {
  DEFAULT_MVP_COMPILER_VERSION,
  DEFAULT_MVP_PROMPT_VERSION,
  MVP_KNOWLEDGE_EXTRACTION_SCHEMA,
  MVP_KNOWLEDGE_KINDS,
  MVP_SYSTEM_INSTRUCTIONS,
  MvpKnowledgeCompiler,
} from "./mvp-compiler.js";
import { runKnowledgeExtraction } from "./runner.js";
import type {
  KnowledgeExtractionRequest,
  StructuredGenerationContext,
  StructuredGenerationModel,
  StructuredGenerationRequest,
} from "./types.js";

function episode(): Episode {
  return {
    episodeId: "episode-mvp",
    builderVersion: "episode-builder-v2",
    sessionIds: ["session-1"],
    turnIds: ["turn-1"],
    projectContext: { projectId: "project-1", repositoryRoot: "/private/repo", portable: false },
    goal: "Implement five MVP knowledge kinds",
    goalRef: "event-goal",
    subgoals: [],
    userStatements: [{
      turnId: "turn-1",
      sourceEventId: "event-goal",
      kind: "GOAL",
      statement: "Implement five MVP knowledge kinds",
      occurredAt: "2026-08-01T08:00:00.000Z",
    }, {
      turnId: "turn-1",
      sourceEventId: "event-corrected",
      kind: "CORRECTION",
      statement: "Store conclusions only",
      occurredAt: "2026-08-01T08:00:01.000Z",
    }],
    userCorrections: [{
      correctionId: "correction-1",
      turnId: "turn-1",
      originalRef: "event-original",
      originalStatement: "Store hidden reasoning",
      correctedRef: "event-corrected",
      correctedStatement: "Store conclusions only",
      occurredAt: "2026-08-01T08:00:01.000Z",
    }],
    actions: [],
    artifacts: [],
    outcomes: [],
    evidenceRefs: ["event-goal", "event-original", "event-corrected"],
    status: "COMPLETED",
    createdAt: "2026-08-01T08:00:00.000Z",
    updatedAt: "2026-08-01T08:00:02.000Z",
  };
}

function request(overrides: Partial<KnowledgeExtractionRequest> = {}): KnowledgeExtractionRequest {
  return {
    input: toKnowledgeExtractionInput(episode()),
    compilerVersion: DEFAULT_MVP_COMPILER_VERSION,
    promptVersion: DEFAULT_MVP_PROMPT_VERSION,
    requestedAt: "2026-08-01T09:00:00.000Z",
    correlationId: "correlation-mvp",
    ...overrides,
  };
}

function draft(kind: KnowledgeKind, index: number): KnowledgeCandidateDraft {
  return {
    subjectKey: `${kind.toLowerCase()}.mvp.topic-${index}`,
    kind,
    scopeHint: { level: "PROJECT", projectId: "project-1", reasonCodes: ["EPISODE_PROJECT"] },
    title: `${kind} knowledge ${index}`,
    summary: `A durable ${kind.toLowerCase()} conclusion.`,
    body: "Only observable conclusions are retained.",
    confidence: 0.8,
    assertions: [],
    evidenceHints: [{ type: "USER_STATEMENT", sourceRef: "event-goal" }],
  };
}

const runOptions = { maxAttempts: 1, retryDelayMs: 0, perAttemptTimeoutMs: 1_000 } as const;

describe("MvpKnowledgeCompiler", () => {
  it("extracts all five MVP kinds in one atomic multi-candidate batch", async () => {
    const captured: Array<{ request: StructuredGenerationRequest; context: StructuredGenerationContext }> = [];
    const model: StructuredGenerationModel = {
      generate: async (generationRequest, context) => {
        captured.push({ request: generationRequest, context });
        return {
          schemaVersion: 1,
          candidates: MVP_KNOWLEDGE_KINDS.map((kind, index) => draft(kind, index)),
        };
      },
    };

    const result = await runKnowledgeExtraction(request(), new MvpKnowledgeCompiler({ model }), runOptions);
    expect(result.status).toBe("SUCCEEDED");
    expect(result.candidates.map((candidate) => candidate.kind)).toEqual(MVP_KNOWLEDGE_KINDS);
    expect(result.candidates.every((candidate) => candidate.status === "PROPOSED")).toBe(true);
    expect(new Set(result.candidates.map((candidate) => candidate.candidateId)).size).toBe(5);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.request.input.corrections[0]).toEqual({
      originalRef: "event-original",
      originalStatement: "Store hidden reasoning",
      correctedRef: "event-corrected",
      correctedStatement: "Store conclusions only",
    });
    expect(captured[0]?.context).toMatchObject({ attempt: 1, extractionKey: result.extractionKey, inputHash: result.inputHash });
  });

  it("supplies a frozen five-kind response schema and conclusion-only instructions", async () => {
    let captured: StructuredGenerationRequest | undefined;
    const compiler = new MvpKnowledgeCompiler({
      model: { generate: async (generationRequest) => {
        captured = generationRequest;
        return { schemaVersion: 1, candidates: [] };
      } },
    });
    await runKnowledgeExtraction(request(), compiler, runOptions);

    const kindSchema = (((captured?.responseSchema["definitions"] as Record<string, unknown>)["candidateDraft"] as Record<string, unknown>)["properties"] as Record<string, unknown>)["kind"] as Record<string, unknown>;
    expect(kindSchema["enum"]).toEqual(MVP_KNOWLEDGE_KINDS);
    expect(captured?.responseSchema["$id"]).toBe("https://zhiloop.dev/schemas/mvp-knowledge-extraction-output/v1");
    expect(captured?.systemInstructions).toContain("Do not output hidden reasoning");
    expect(captured?.systemInstructions).toContain("caller always materializes candidates as PROPOSED");
    expect(captured?.systemInstructions).toContain("Treat corrections as authoritative");
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(MVP_KNOWLEDGE_EXTRACTION_SCHEMA)).toBe(true);
    expect(Object.isFrozen(MVP_KNOWLEDGE_KINDS)).toBe(true);
    expect(MVP_SYSTEM_INSTRUCTIONS).not.toContain("think step by step");
  });

  it("supports multiple candidates of the same kind", async () => {
    const compiler = new MvpKnowledgeCompiler({
      model: { generate: async () => ({
        schemaVersion: 1,
        candidates: [draft("DESIGN", 1), draft("DESIGN", 2)],
      }) },
    });
    const result = await runKnowledgeExtraction(request(), compiler, runOptions);
    expect(result.candidates.map((candidate) => candidate.subjectKey)).toEqual([
      "design.mvp.topic-1",
      "design.mvp.topic-2",
    ]);
  });

  it("rejects a well-formed non-MVP kind as retryable invalid output", async () => {
    const compiler = new MvpKnowledgeCompiler({
      model: { generate: async () => ({ schemaVersion: 1, candidates: [draft("FACT", 1)] }) },
    });
    const result = await runKnowledgeExtraction(request(), compiler, runOptions);
    expect(result).toMatchObject({ status: "RETRYABLE", reason: "INVALID_OUTPUT", candidates: [] });
  });

  it("rejects model commentary or hidden rationale through the strict output schema", async () => {
    const compiler = new MvpKnowledgeCompiler({
      model: { generate: async () => ({
        schemaVersion: 1,
        candidates: [{ ...draft("DECISION", 1), rationale: "private reasoning" }],
      }) },
    });
    const result = await runKnowledgeExtraction(request(), compiler, runOptions);
    expect(result).toMatchObject({ status: "RETRYABLE", reason: "INVALID_OUTPUT", candidates: [] });
    expect(result.diagnostics.some((item) => item.code === "SCHEMA_INVALID")).toBe(true);
  });

  it("fails closed when runtime versions do not match the configured compiler", async () => {
    let calls = 0;
    const compiler = new MvpKnowledgeCompiler({
      model: { generate: async () => {
        calls += 1;
        return { schemaVersion: 1, candidates: [] };
      } },
    });
    const result = await runKnowledgeExtraction(request({ promptVersion: "other-prompt" }), compiler, runOptions);
    expect(result).toMatchObject({ status: "FAILED", reason: "ADAPTER_REJECTED", candidates: [] });
    expect(calls).toBe(0);
  });

  it("lets the runner retry transient model failure without provider coupling", async () => {
    let calls = 0;
    const compiler = new MvpKnowledgeCompiler({
      model: { generate: async () => {
        calls += 1;
        if (calls === 1) throw new Error("provider offline");
        return { schemaVersion: 1, candidates: [draft("EXPERIENCE", 1)] };
      } },
    });
    const result = await runKnowledgeExtraction(request(), compiler, {
      ...runOptions,
      maxAttempts: 2,
    });
    expect(result).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
    expect(calls).toBe(2);
  });

  it("validates configured compiler and prompt versions", () => {
    const model: StructuredGenerationModel = { generate: async () => ({ schemaVersion: 1, candidates: [] }) };
    expect(() => new MvpKnowledgeCompiler({ model, compilerVersion: "bad version" })).toThrow("compilerVersion");
    expect(() => new MvpKnowledgeCompiler({ model, promptVersion: "" })).toThrow("promptVersion");
    expect(() => new MvpKnowledgeCompiler({ model: {} as StructuredGenerationModel })).toThrow("model");
  });
});
