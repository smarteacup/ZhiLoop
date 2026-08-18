// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConsoleApi } from "../../../api/client.js";
import type { KnowledgeDetailView, KnowledgeListView } from "../../../api/p2.js";
import { KnowledgePage } from "./KnowledgePage.js";

const timestamp = "2026-08-04T10:00:00.000Z";
const ready = { schemaVersion: 1 as const, capabilityId: "knowledge.governance", status: "READY" as const, reasonCode: "COMPONENT_READY" as const, observedAt: timestamp, lastTransitionAt: timestamp, retryable: false, evidenceRefs: [] };
const provenance = { sessionIds: ["session-1"], turnIds: ["turn-2"], eventIds: ["event-3"], snapshotIds: ["snapshot-4"], episodeIds: ["episode-5"], knowledgeVersions: [{ knowledgeId: "knowledge-1", version: 3 }] };
const list: KnowledgeListView = { revision: 12, indexStatus: "DEGRADED", indexReasonCode: "INDEX_PUBLICATION_RETRY", retryable: true, items: [{ knowledgeId: "knowledge-1", version: 3, subjectKey: "symbol:Compiler", title: "Compiler contract", summary: "Evidence-backed boundary", scope: "PROJECT", projectId: "zhiloop", kind: "DECISION", status: "ACCEPTED", confidence: 0.91, evidenceVerdict: "SUPPORTS", eligible: true, eligibilityReasonCodes: [], freshnessStatus: "FRESH", freshnessReasonCode: "FRESHNESS_FRESH", updatedAt: timestamp }] };
const detail: KnowledgeDetailView = {
  revision: 18, knowledgeId: "knowledge-1", version: 3, title: "Compiler contract", summary: "Evidence-backed boundary", subjectKey: "symbol:Compiler", kind: "DECISION", scope: "PROJECT", projectId: "zhiloop", status: "ACCEPTED", confidence: 0.91, eligible: true, eligibilityReasonCodes: [], markdown: "# Contract\n\nKeep evidence linked.", scopeReasonCodes: ["PROJECT_SOURCE_DOMINANT"],
  assertions: [{ assertionId: "assertion-1", text: "Every conclusion keeps provenance", status: "SUPPORTS" }], evidence: [{ evidenceId: "evidence-1", verdict: "SUPPORTS", source: "event-3", reasonCode: "SOURCE_VERIFIED" }], relations: [{ relation: "RELATED_TO", knowledgeId: "knowledge-2", version: 1, title: "Ledger contract" }], provenance, lifecycle: [{ status: "ACCEPTED", occurredAt: timestamp, reasonCode: "POLICY_ACCEPTED" }], usage: [{ sessionId: "session-1", turnId: "turn-8", mode: "INJECTED", occurredAt: timestamp }], versions: [{ version: 2, status: "SUPERSEDED", createdAt: timestamp, reasonCode: "EDITED", markdown: "old", diffFromPrevious: "- old\n+ current" }, { version: 3, status: "ACCEPTED", createdAt: timestamp, reasonCode: "EDITED", markdown: "current", diffFromPrevious: "- v2\n+ v3" }],
  freshness: { status: "CONFLICT", projected: true, revision: 2, codeRevision: "git:abc123", graphRevision: "graph:9", reasonCodes: ["FRESHNESS_CONFLICT"], affectedAssertionIds: ["assertion-1"], updatedAt: timestamp, anchors: [{ assertionId: "assertion-1", kind: "SYMBOL", key: "Compiler.compile", path: "src/compiler.ts" }], events: [{ eventId: "freshness-event-1", previousStatus: "REVALIDATE", status: "CONFLICT", revision: 2, codeRevision: "git:abc123", graphRevision: "graph:9", reasonCodes: ["FRESHNESS_CONFLICT"], affectedAssertionIds: ["assertion-1"], occurredAt: timestamp }] },
  editAction: { enabled: true, expectedRevision: 3, idempotencyKey: "edit:3", reasonCode: "ACTION_READY" }, suppressAction: { enabled: true, expectedRevision: 3, idempotencyKey: "suppress:3", reasonCode: "ACTION_READY" }, restoreAction: { enabled: false, expectedRevision: 3, idempotencyKey: "restore:3", reasonCode: "NOT_SUPPRESSED" },
};

function apiWith(overrides: Partial<ConsoleApi> = {}): ConsoleApi {
  return {
    overview: async () => { throw new Error("unused"); }, capabilities: async () => ({ items: [ready] }), sessions: async () => ({ items: [] }), session: async () => { throw new Error("unused"); }, events: async () => ({ items: [] }), jobs: async () => ({ items: [] }), diagnostics: async () => { throw new Error("unused"); }, previewCapture: async () => { throw new Error("unused"); }, commitCapture: async () => { throw new Error("unused"); }, knowledgeList: async () => list, knowledgeDetail: async () => detail,
    ...overrides,
  };
}

afterEach(() => cleanup());

describe("KnowledgePage", () => {
  it("applies the complete filter set on the server and exposes degraded indexing", async () => {
    const query = vi.fn(async () => list);
    const user = userEvent.setup();
    render(<KnowledgePage api={apiWith({ knowledgeList: query })} />);
    await screen.findByRole("heading", { name: "知识库" });
    await user.selectOptions(screen.getByLabelText("Scope"), "PROJECT");
    await user.type(screen.getByLabelText("项目"), "zhiloop");
    await user.type(screen.getByLabelText("关键词"), "compiler");
    await user.selectOptions(screen.getByLabelText("Evidence"), "SUPPORTS");
    await user.selectOptions(screen.getByLabelText("召回资格"), "true");
    await user.click(screen.getByRole("button", { name: "应用服务端筛选" }));
    expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "PROJECT", projectId: "zhiloop", keyword: "compiler", evidenceVerdict: "SUPPORTS", eligible: true }), expect.any(AbortSignal));
    expect(await screen.findByText("INDEX_PUBLICATION_RETRY")).toBeTruthy();
    expect(screen.getByText(/索引可能落后/u)).toBeTruthy();
  });

  it("renders Markdown, version diff, Scope, Evidence, relations and bidirectional provenance", async () => {
    render(<KnowledgePage api={apiWith()} knowledgeId="knowledge-1" />);
    expect(await screen.findByRole("heading", { name: "Compiler contract" })).toBeTruthy();
    expect(screen.getAllByText(/Keep evidence linked/u).length).toBeGreaterThan(0);
    expect(screen.getByText("PROJECT_SOURCE_DOMINANT")).toBeTruthy();
    expect(screen.getByText(/SOURCE_VERIFIED/u)).toBeTruthy();
    expect(screen.getByRole("link", { name: /RELATED_TO → Ledger contract/u })).toBeTruthy();
    expect(screen.getByRole("link", { name: "session-1" })).toBeTruthy();
    expect(screen.getByText(/- v2/u)).toBeTruthy();
    expect(screen.getByText("POLICY_ACCEPTED")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "代码知识保鲜" })).toBeTruthy();
    expect(screen.getAllByText("与当前代码冲突").length).toBeGreaterThan(0);
    expect(screen.getByText(/Compiler\.compile/u)).toBeTruthy();
    expect(screen.getByText(/等待重新验证 → 与当前代码冲突/u)).toBeTruthy();
  });

  it("previews edit impact and commits a new version with the same expected version", async () => {
    const preview = vi.fn(async (command) => ({ knowledgeId: command.knowledgeId, basedOnVersion: command.expectedVersion, proposedVersion: 4, changedFields: ["title"], scopeChanged: false, evidenceDowngraded: true, eligibleBefore: true, eligibleAfter: false, reasonCodes: ["EVIDENCE_UNSUPPORTED"], draft: command.draft }));
    const commit = vi.fn(async () => ({ ...detail, revision: 19, version: 4, title: "Updated contract", status: "PROPOSED" as const, eligible: false, eligibilityReasonCodes: ["EVIDENCE_UNSUPPORTED"], editAction: { ...detail.editAction, expectedRevision: 4 }, suppressAction: { ...detail.suppressAction, expectedRevision: 4 }, restoreAction: { ...detail.restoreAction, expectedRevision: 4 } }));
    const user = userEvent.setup();
    render(<KnowledgePage api={apiWith({ previewKnowledgeEdit: preview, commitKnowledgeEdit: commit })} knowledgeId="knowledge-1" />);
    const title = await screen.findByLabelText("标题");
    await user.clear(title);
    await user.type(title, "Updated contract");
    await user.click(screen.getByRole("button", { name: "预览编辑影响" }));
    expect(await screen.findByText(/Evidence 降级：true/u)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "创建新知识版本" }));
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ knowledgeId: "knowledge-1", expectedVersion: 3, idempotencyKey: "edit:3", draft: expect.objectContaining({ title: "Updated contract" }) }));
    expect(await screen.findByText(/操作已创建新版本/u)).toBeTruthy();
  });

  it("blocks stale revisions and surfaces command conflicts without overwriting", async () => {
    const user = userEvent.setup();
    const stale = { ...detail, version: 4 };
    const suppress = vi.fn(async () => { throw new Error("STALE_REVISION"); });
    const { unmount } = render(<KnowledgePage api={apiWith({ knowledgeDetail: async () => stale, suppressKnowledge: suppress })} knowledgeId="knowledge-1" />);
    expect(await screen.findByText("STALE_REVISION")).toBeTruthy();
    expect((screen.getByRole("button", { name: "预览编辑影响" }) as HTMLButtonElement).disabled).toBe(true);
    unmount();

    render(<KnowledgePage api={apiWith({ suppressKnowledge: suppress })} knowledgeId="knowledge-1" />);
    await user.type(await screen.findByLabelText("移除/恢复原因"), "obsolete");
    await user.click(screen.getByRole("button", { name: "创建可恢复的 suppress 版本" }));
    expect((await screen.findByRole("status")).textContent).toContain("STALE_REVISION");
    expect(screen.getByRole("heading", { name: "Compiler contract" })).toBeTruthy();
  });

  it("creates reversible suppress and revalidated restore versions", async () => {
    const suppress = vi.fn(async () => ({ ...detail, version: 4, status: "ACCEPTED" as const, eligible: false, eligibilityReasonCodes: ["GOVERNANCE_SUPPRESSED"], editAction: { ...detail.editAction, expectedRevision: 4 }, suppressAction: { enabled: false, expectedRevision: 4, idempotencyKey: "suppress:4", reasonCode: "ALREADY_SUPPRESSED" }, restoreAction: { enabled: true, expectedRevision: 4, idempotencyKey: "restore:4", reasonCode: "ACTION_READY" } }));
    const restore = vi.fn(async () => ({ ...detail, version: 5, status: "ACCEPTED" as const, editAction: { ...detail.editAction, expectedRevision: 5 }, suppressAction: { ...detail.suppressAction, expectedRevision: 5 }, restoreAction: { ...detail.restoreAction, expectedRevision: 5 } }));
    const user = userEvent.setup();
    render(<KnowledgePage api={apiWith({ suppressKnowledge: suppress, restoreKnowledge: restore })} knowledgeId="knowledge-1" />);
    const reason = await screen.findByLabelText("移除/恢复原因");
    await user.type(reason, "superseded by implementation");
    await user.click(screen.getByRole("button", { name: "创建可恢复的 suppress 版本" }));
    expect(suppress).toHaveBeenCalledWith({ knowledgeId: "knowledge-1", expectedVersion: 3, idempotencyKey: "suppress:3", reason: "superseded by implementation" });
    await user.clear(screen.getByLabelText("移除/恢复原因"));
    await user.type(screen.getByLabelText("移除/恢复原因"), "evidence revalidated");
    await user.click(screen.getByRole("button", { name: "重新校验并恢复" }));
    expect(restore).toHaveBeenCalledWith({ knowledgeId: "knowledge-1", expectedVersion: 4, idempotencyKey: "restore:4", reason: "evidence revalidated" });
  });

  it("does not call query APIs when capability is disabled", async () => {
    const query = vi.fn(async () => list);
    render(<KnowledgePage api={apiWith({ capabilities: async () => ({ items: [{ ...ready, status: "DISABLED", reasonCode: "KNOWLEDGE_WORKER_NOT_COMPOSED" }] }), knowledgeList: query })} />);
    expect(await screen.findByRole("heading", { name: "知识查询不可用" })).toBeTruthy();
    expect(screen.getByText(/KNOWLEDGE_WORKER_NOT_COMPOSED/u)).toBeTruthy();
    expect(query).not.toHaveBeenCalled();
  });
});
