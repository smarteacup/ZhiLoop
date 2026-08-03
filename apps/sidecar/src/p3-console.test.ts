import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_CONSOLE_CONFIGURATION, type ConfigurationView } from "@zhiloop/configuration-service";
import type { KnowledgeAsset } from "@zhiloop/domain";
import { SqliteKnowledgeRegistryProjection } from "@zhiloop/knowledge-registry";
import { calculateKnowledgeContentHash, MarkdownKnowledgeRepository } from "@zhiloop/markdown-repository";
import type {
  CodexKnowledgeQueryAnswer,
  CodexKnowledgeQueryModel,
  CodexKnowledgeQueryRequest,
} from "@zhiloop/model-codex-exec";
import { p3ConsoleAskResponseSchema, p3ConsoleSearchResponseSchema } from "@zhiloop/p3-console-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { P3SidecarConsole } from "./p3-console.js";

const NOW = "2026-08-04T00:00:00.000Z";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function configuration(): ConfigurationView {
  return {
    revision: 1,
    hash: "c".repeat(64),
    effective: structuredClone(DEFAULT_CONSOLE_CONFIGURATION),
    sources: {},
  };
}

function asset(): KnowledgeAsset {
  const value: KnowledgeAsset = {
    schemaVersion: 1,
    id: "knowledge-p3-sidecar",
    subjectKey: "symbol.sidecar.config-service",
    kind: "IMPLEMENTATION",
    scope: { level: "PROJECT", projectId: "project-a" },
    version: 1,
    status: "VERIFIED",
    title: "ConfigService runtime contract",
    summary: "ConfigService validates and activates configuration.",
    body: "ConfigService validates configuration before activation.",
    aliases: [],
    keywords: ["ConfigService"],
    applicability: ["project-a"],
    nonApplicability: [],
    symbols: ["ConfigService"],
    relations: [],
    evidence: [{ evidenceId: "evidence-p3-sidecar", verdict: "SUPPORTS" }],
    confidence: 1,
    sourceEpisodes: ["episode-p3-sidecar"],
    contentHash: "",
    correlationId: "correlation-p3-sidecar",
    createdAt: NOW,
    updatedAt: NOW,
  };
  return { ...value, contentHash: calculateKnowledgeContentHash(value) };
}

async function registry(root: string): Promise<SqliteKnowledgeRegistryProjection> {
  const markdown = new MarkdownKnowledgeRepository(path.join(root, "markdown"));
  const stored = (await markdown.publish(asset(), { expectedCurrentVersion: 0 })).value;
  const projection = new SqliteKnowledgeRegistryProjection(path.join(root, "registry.sqlite"));
  projection.projectCurrent(stored);
  return projection;
}

function request(requestId: string, type: "p3.knowledge.search" | "p3.knowledge.ask", projectId = "project-a") {
  return {
    schemaVersion: 1 as const,
    requestId,
    type,
    query: "How does ConfigService activate configuration?",
    projectId,
    taskId: "task-p3",
    repositoryRoot: `/workspace/${projectId}`,
    cwd: `/workspace/${projectId}`,
    hints: { symbols: ["ConfigService"] },
    maxResults: 10,
    maxContextTokens: 800,
    timeoutMs: 100,
  };
}

function cited(input: CodexKnowledgeQueryRequest): CodexKnowledgeQueryAnswer {
  const answer = "ConfigService validates before activation.";
  const knowledge = input.retrievedKnowledge[0];
  if (knowledge === undefined) throw new Error("expected retrieved knowledge");
  return {
    schemaVersion: 1,
    queryId: input.queryId,
    retrievalTraceId: input.retrievalTraceId,
    modelRunId: "model-run-p3-sidecar",
    outcome: "SUCCEEDED",
    model: "codex-test",
    answer,
    factualSpans: [{ start: 0, end: answer.length }],
    citations: [{
      knowledgeId: knowledge.knowledgeId,
      version: knowledge.version,
      answerSpans: [{ start: 0, end: answer.length }],
      evidenceIds: [...knowledge.evidenceIds],
    }],
    unknowns: [],
    conflicts: [],
    latencyMs: 3,
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

describe("P3SidecarConsole", () => {
  it("uses the production Registry, enforces scope, and remains SHADOW", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zhiloop-p3-sidecar-"));
    roots.push(root);
    const projection = await registry(root);
    const console = new P3SidecarConsole({ stateDirectory: root, registry: projection, configuration, drafts: () => [] });

    expect(console.capability).toMatchObject({
      retrieval: { state: "READY", reasonCode: "COMPONENT_READY" },
      codexQuery: { state: "NOT_CONFIGURED", reasonCode: "CAPABILITY_NOT_CONFIGURED" },
    });
    const visible = p3ConsoleSearchResponseSchema.parse(await console.handle(request("request-visible", "p3.knowledge.search")));
    expect(visible.trace.results.map((item) => item.knowledgeId)).toEqual(["knowledge-p3-sidecar"]);
    expect(visible.trace.injectionResult).toBe("SHADOWED");
    const isolated = p3ConsoleSearchResponseSchema.parse(await console.handle(request("request-isolated", "p3.knowledge.search", "project-b")));
    expect(isolated.trace.results).toEqual([]);

    console.close();
    projection.close();
  });

  it("persists ASK idempotency across Sidecar restart and never invokes the model twice", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zhiloop-p3-sidecar-restart-"));
    roots.push(root);
    const projection = await registry(root);
    const firstAnswer = vi.fn(async (input: CodexKnowledgeQueryRequest) => cited(input));
    const firstModel: CodexKnowledgeQueryModel = { answer: firstAnswer };
    const first = new P3SidecarConsole({ stateDirectory: root, registry: projection, configuration, drafts: () => [], model: firstModel });
    const command = request("request-restart-idempotent", "p3.knowledge.ask");
    const initial = p3ConsoleAskResponseSchema.parse(await first.handle(command));
    first.close();

    const secondAnswer = vi.fn(async (input: CodexKnowledgeQueryRequest) => cited(input));
    const reopened = new P3SidecarConsole({ stateDirectory: root, registry: projection, configuration, drafts: () => [], model: { answer: secondAnswer } });
    const replayed = p3ConsoleAskResponseSchema.parse(await reopened.handle(command));
    expect(replayed).toEqual(initial);
    expect(firstAnswer).toHaveBeenCalledTimes(1);
    expect(secondAnswer).not.toHaveBeenCalled();

    reopened.close();
    projection.close();
  });

  it("falls back on an unconfigured or timed-out Codex model without widening permissions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zhiloop-p3-sidecar-timeout-"));
    roots.push(root);
    const projection = await registry(root);
    const noModelDirectory = path.join(root, "no-model");
    const timedDirectory = path.join(root, "timed");
    await Promise.all([mkdir(noModelDirectory), mkdir(timedDirectory)]);
    const noModel = new P3SidecarConsole({ stateDirectory: noModelDirectory, registry: projection, configuration, drafts: () => [] });
    const fallback = p3ConsoleAskResponseSchema.parse(await noModel.handle(request("request-no-model", "p3.knowledge.ask")));
    expect(fallback.answer.outcome).toBe("FALLBACK_SEARCH");
    noModel.close();

    const hanging: CodexKnowledgeQueryModel = { answer: async () => await new Promise<CodexKnowledgeQueryAnswer>(() => undefined) };
    const timed = new P3SidecarConsole({ stateDirectory: timedDirectory, registry: projection, configuration, drafts: () => [], model: hanging });
    const timeoutCommand = { ...request("request-timeout", "p3.knowledge.ask"), timeoutMs: 10 };
    const timeout = p3ConsoleAskResponseSchema.parse(await timed.handle(timeoutCommand));
    expect(timeout.answer.outcome).toBe("FALLBACK_SEARCH");
    expect(timeout.trace.injectionResult).not.toBe("INJECTED");
    timed.close();
    projection.close();
  });
});
