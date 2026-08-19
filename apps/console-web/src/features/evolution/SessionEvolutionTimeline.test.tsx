// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ConsoleApi } from "../../api/client.js";
import type { SessionExtractionView } from "../../api/p2.js";
import { SessionEvolutionTimeline } from "./SessionEvolutionTimeline.js";
import { observedAt, testApi } from "./test-api.js";

afterEach(() => cleanup());

const extraction: SessionExtractionView = { sessionId: "session-1", revision: 2,
  snapshot: { snapshotId: "snapshot-1", revision: 1, completeness: "COMPLETE_SNAPSHOT", sourceSequenceFrom: 1,
    sourceSequenceThrough: 2, compilerVersion: "compiler-v1", policyHash: "a".repeat(64), createdAt: observedAt,
    unsupportedEventTypes: [] },
  stages: [{ stage: "CANDIDATE_PREVIEW", status: "SUCCEEDED", reasonCode: "STAGE_COMPLETE", retryable: false }],
  candidates: [{ candidateId: "candidate-1", subjectKey: "subject", kind: "DECISION", title: "方案结论", summary: "摘要", body: "正文",
    scope: "PROJECT", confidence: 0.9, status: "PROPOSED", evidenceVerdict: "INCONCLUSIVE",
    policy: { action: "KEEP_PROPOSED", targetStatus: "PROPOSED", shouldPublish: false, reasonCodes: ["EVIDENCE_PARTIAL"] },
    assertions: [{ assertionId: "assertion-1", kind: "SYMBOL_EXISTS", target: "Service" }],
    evidenceChecks: [],
    commitments: [{ signalId: "signal-1", kind: "USER_ACCEPTED", turnId: "turn-1", statementRef: "event-1",
      statement: "按这个方案实施", occurredAt: observedAt, reasonCodes: ["EXPLICIT_ACCEPTANCE"] }],
    evolution: { status: "DECIDED", action: "STORE", targetKnowledgeVersions: [], confidence: 0.9, requiresConfirmation: false,
      reasonCodes: ["NEW_SUBJECT"] }, provenance: { sessionIds: ["session-1"], turnIds: ["turn-1"], eventIds: ["event-1"],
        snapshotIds: ["snapshot-1"], episodeIds: ["episode-1"], knowledgeVersions: [{ knowledgeId: "knowledge-1", version: 1 }] } }],
  commitmentAmbiguities: [], reverseProvenance: [],
  extractAction: { enabled: false, expectedRevision: 2, idempotencyKey: "extract-disabled-0001", reasonCode: "CAPTURE_NOT_CURRENT" },
  commitAction: { enabled: false, expectedRevision: 0, idempotencyKey: "commit-disabled-0001", reasonCode: "PREVIEW_NOT_READY" } };

describe("SessionEvolutionTimeline", () => {
  it("combines capture, extraction, candidate, and injection facts", async () => {
    const injections = { observedAt, truncated: false, capabilityStatus: "READY" as const, capabilityReasonCode: "COMPONENT_READY",
      attempts: [{ attemptId: "attempt-1", sessionId: "session-1", turnId: "turn-1", runId: "run-1", retrievalTraceId: "trace-1",
        rolloutRevision: 1, status: "SHADOWED" as const, reasonCode: "SHADOW_MODE", envelope: { mode: "SHADOW" as const,
          detailLevel: "L1_POINTER" as const, maxTokens: 100, estimatedTokens: 0, items: [], omitted: [], reasonCodes: ["SHADOW_MODE"] },
        createdAt: observedAt, mcpExpansions: [] }] };
    render(<SessionEvolutionTimeline api={testApi({ sessionExtraction: async () => extraction,
      sessionInjections: async () => injections, knowledgeEvolution: async () => ({ schemaVersion: 1, revision: 1,
        knowledgeId: "knowledge-1", knowledgeVersion: 1, projectId: "project-1", freshnessRevision: 0,
        verificationRuns: [], jobs: [], revalidationAction: { enabled: false, expectedKnowledgeVersion: 1,
          expectedFreshnessRevision: 0, reasonCode: "VERIFICATION_RECIPE_MISSING" }, observedAt,
        repairDrafts: [{ draftId: "draft-1", projectId: "project-1", assetId: "knowledge-1", assetVersion: 1,
          conflictRunId: "run-conflict", status: "PENDING", revision: 0, changedAssertions: [],
          reasonCodes: ["ASSERTION_UNSUPPORTED"], createdAt: observedAt, updatedAt: observedAt }] }) })}
      sessionId="session-1" captureStatus="CAPTURED_CURRENT" capturedAt={observedAt} />);
    expect(await screen.findByText(/知识候选：方案结论/u)).toBeTruthy(); expect(screen.getByText(/上下文注入：turn-1/u)).toBeTruthy();
    expect(screen.getByText("候选知识生成")).toBeTruthy(); expect(screen.getAllByText("已采集至最新").length).toBeGreaterThan(0);
    expect(screen.getByText("不可变提取快照")).toBeTruthy(); expect(screen.getByText(/用户承诺/u)).toBeTruthy();
    expect(screen.getByText("已发布知识引用")).toBeTruthy(); expect(screen.getByText("知识修复草稿")).toBeTruthy();
  });

  it("shows absent APIs and query failures explicitly", async () => {
    const { rerender } = render(<SessionEvolutionTimeline api={testApi({})} sessionId="session-1"
      captureStatus="CAPTURED_PARTIAL" capturedAt={observedAt} />);
    expect(await screen.findByText("SESSION_EXTRACTION_API_NOT_EXPOSED")).toBeTruthy();
    expect(screen.getByText("SESSION_INJECTION_API_NOT_EXPOSED")).toBeTruthy();
    rerender(<SessionEvolutionTimeline api={testApi({ sessionExtraction: async () => { throw new Error("timeline failed"); } }) as ConsoleApi}
      sessionId="session-1" captureStatus="CAPTURED_PARTIAL" capturedAt={observedAt} />);
    expect(await screen.findByText(/timeline failed/u)).toBeTruthy();
  });
});
