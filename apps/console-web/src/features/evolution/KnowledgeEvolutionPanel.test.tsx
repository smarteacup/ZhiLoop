// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KnowledgeEvolutionPanel } from "./KnowledgeEvolutionPanel.js";
import { observedAt, testApi } from "./test-api.js";

afterEach(() => cleanup());

const view = { schemaVersion: 1 as const, revision: 3, knowledgeId: "knowledge-1", knowledgeVersion: 2,
  projectId: "project-1", freshnessRevision: 3,
  recipe: { recipeVersion: "evidence-recipe-v1", assertionsHash: "a".repeat(64), assertionCount: 1, createdAt: observedAt },
  verificationRuns: [{ runId: "run-1", purpose: "FRESHNESS" as const, projectId: "project-1", codeRevision: "git-1",
    qualifyingProof: false, status: "COMPLETED" as const, results: [{ assertionId: "assertion-1", assertionKind: "SYMBOL_EXISTS",
      status: "REFUTED" as const, reasonCodes: ["CODEGRAPH_SYMBOL_NOT_FOUND"] }], completedAt: observedAt }],
  repairDrafts: [{ draftId: "repair-1", projectId: "project-1", assetId: "knowledge-1", assetVersion: 2,
    conflictRunId: "run-1", status: "PENDING" as const, revision: 0,
    changedAssertions: [{ assertionId: "assertion-1", assertionKind: "SYMBOL_EXISTS", reasonCodes: ["CODEGRAPH_SYMBOL_NOT_FOUND"] }],
    reasonCodes: ["FRESHNESS_CONFLICT"], createdAt: observedAt, updatedAt: observedAt }], jobs: [],
  revalidationAction: { enabled: true, expectedKnowledgeVersion: 2, expectedFreshnessRevision: 3, reasonCode: "ACTION_READY" },
  observedAt };

describe("KnowledgeEvolutionPanel", () => {
  it("renders evidence and sends revision-bound revalidation and proposed repair commands", async () => {
    const revalidate = vi.fn(async () => ({ knowledgeId: "knowledge-1", knowledgeVersion: 2,
      disposition: "NO_CHANGES" as const, reasonCode: "CODE_REVISION_ALREADY_CURRENT", observedAt }));
    const repair = vi.fn(async () => ({ draft: { ...view.repairDrafts[0]!, status: "READY" as const, revision: 1,
      proposedCandidate: { candidateId: "candidate-repair", title: "Title", summary: "Summary", body: "Body" } } }));
    render(<KnowledgeEvolutionPanel api={testApi({ knowledgeEvolution: async () => view,
      revalidateKnowledge: revalidate, submitRepairCandidate: repair })} knowledgeId="knowledge-1"
      title="Title" summary="Summary" body="Body" />);
    const user = userEvent.setup();
    expect(await screen.findByText(/evidence-recipe-v1/u)).toBeTruthy();
    expect(screen.getAllByText(/assertion-1/u)).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "手动复验当前知识" }));
    expect(revalidate).toHaveBeenCalledWith(expect.objectContaining({ knowledgeId: "knowledge-1",
      expectedKnowledgeVersion: 2, expectedFreshnessRevision: 3 }));
    await user.click(screen.getByRole("button", { name: "以当前知识内容生成修复候选" }));
    expect(repair).toHaveBeenCalledWith(expect.objectContaining({ draftId: "repair-1", expectedRevision: 0,
      title: "Title", summary: "Summary", body: "Body" }));
  });

  it("shows the absent API and a disabled project-scope gate truthfully", async () => {
    const { rerender } = render(<KnowledgeEvolutionPanel api={testApi({})} knowledgeId="knowledge-1" title="T" summary="S" body="B" />);
    expect(await screen.findByText("KNOWLEDGE_EVOLUTION_API_NOT_EXPOSED")).toBeTruthy();
    rerender(<KnowledgeEvolutionPanel api={testApi({ knowledgeEvolution: async () => ({ ...view, projectId: undefined, recipe: undefined,
      verificationRuns: [], repairDrafts: [], jobs: [], revalidationAction: { enabled: false, expectedKnowledgeVersion: 2,
        expectedFreshnessRevision: 0, reasonCode: "PROJECT_SCOPE_REQUIRED" } }) })} knowledgeId="knowledge-1" title="T" summary="S" body="B" />);
    expect(await screen.findByText("需要项目级知识")).toBeTruthy();
    expect((screen.getByRole("button", { name: "手动复验当前知识" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(/尚无/u).length).toBeGreaterThan(0);
  });

  it("preserves query and command failures and renders an existing proposed repair", async () => {
    const { rerender } = render(<KnowledgeEvolutionPanel api={testApi({ knowledgeEvolution: async () => { throw new Error("evolution failed"); } })}
      knowledgeId="knowledge-1" title="T" summary="S" body="B" />);
    expect(await screen.findByText(/evolution failed/u)).toBeTruthy();
    rerender(<KnowledgeEvolutionPanel api={testApi({ knowledgeEvolution: async () => ({ ...view, repairDrafts: [{ ...view.repairDrafts[0]!,
      status: "READY", revision: 1, proposedCandidate: { candidateId: "candidate-ready", title: "修复标题", summary: "修复摘要", body: "修复正文" } }],
      jobs: [{ schemaVersion: 1, jobId: "job-1", jobType: "KNOWLEDGE_REVALIDATE", revision: 1, status: "FAILED", attempt: 2,
        maxAttempts: 2, progress: 20, reasonCode: "JOB_FAILED", observedAt, lastTransitionAt: observedAt, retryable: false, evidenceRefs: [] }] }),
      revalidateKnowledge: async () => { throw new Error("revision conflict"); } })} knowledgeId="knowledge-1" title="T" summary="S" body="B" />);
    const user = userEvent.setup(); await user.click(await screen.findByRole("button", { name: "手动复验当前知识" }));
    expect(await screen.findByText(/revision conflict/u)).toBeTruthy(); await user.click(screen.getByText("查看修复候选"));
    expect(screen.getByText("修复正文")).toBeTruthy(); expect(screen.getByText("代码知识重新验证")).toBeTruthy();
  });
});
