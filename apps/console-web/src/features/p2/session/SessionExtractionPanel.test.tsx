// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConsoleApi } from "../../../api/client.js";
import type { SessionExtractionView } from "../../../api/p2.js";
import { SessionExtractionPanel } from "./SessionExtractionPanel.js";

const observedAt = "2026-08-04T10:00:00.000Z";
const ready = { schemaVersion: 1 as const, capabilityId: "knowledge.compiler", status: "READY" as const, reasonCode: "COMPONENT_READY" as const, observedAt, lastTransitionAt: observedAt, retryable: false, evidenceRefs: [] };
const view: SessionExtractionView = {
  sessionId: "session-1", revision: 7,
  snapshot: { snapshotId: "snapshot-7", revision: 7, completeness: "PARTIAL_SNAPSHOT", sourceSequenceFrom: 1, sourceSequenceThrough: 42, compilerVersion: "compiler-2", policyHash: "policy-hash", createdAt: observedAt, unsupportedEventTypes: ["TOOL_STREAM_DELTA"] },
  stages: [{ stage: "EPISODE_BUILD", status: "SUCCEEDED", reasonCode: "STAGE_COMPLETE", retryable: false, completedUnits: 3, totalUnits: 3 }, { stage: "EVIDENCE", status: "DEGRADED", reasonCode: "EVIDENCE_PARTIAL", retryable: true }],
  candidates: [{ candidateId: "candidate-1", subjectKey: "symbol:Compiler", kind: "DECISION", title: "Compiler boundary", summary: "Keep evidence at the boundary", scope: "PROJECT", confidence: 0.88, status: "PROPOSED", evidenceVerdict: "INCONCLUSIVE", policy: { action: "KEEP_PROPOSED", targetStatus: "PROPOSED", shouldPublish: false, reasonCodes: ["EVIDENCE_PARTIAL"] }, provenance: { sessionIds: ["session-1"], turnIds: ["turn-2"], eventIds: ["event-4"], snapshotIds: ["snapshot-7"], episodeIds: ["episode-1"], knowledgeVersions: [{ knowledgeId: "knowledge-1", version: 2 }] } }],
  reverseProvenance: [],
  extractAction: { enabled: true, expectedRevision: 7, idempotencyKey: "extract:session-1:7", reasonCode: "ACTION_READY" },
  commitAction: { enabled: true, expectedRevision: 1, idempotencyKey: "commit:preview-1:1", reasonCode: "ACTION_READY" },
  previewId: "preview-1",
};

function apiWith(overrides: Partial<ConsoleApi> = {}): ConsoleApi {
  return {
    overview: async () => { throw new Error("unused"); }, capabilities: async () => ({ items: [ready] }), sessions: async () => ({ items: [] }), session: async () => { throw new Error("unused"); }, events: async () => ({ items: [] }), jobs: async () => ({ items: [] }), diagnostics: async () => { throw new Error("unused"); }, previewCapture: async () => { throw new Error("unused"); }, commitCapture: async () => { throw new Error("unused"); }, sessionExtraction: async () => view,
    ...overrides,
  };
}

afterEach(() => cleanup());

describe("SessionExtractionPanel", () => {
  it("renders partial snapshot, unsupported events, policy and bidirectional provenance", async () => {
    render(<SessionExtractionPanel api={apiWith()} sessionId="session-1" />);
    expect(await screen.findByRole("heading", { name: "会话知识提取" })).toBeTruthy();
    expect(screen.getAllByText("PARTIAL_SNAPSHOT").length).toBeGreaterThan(0);
    expect(screen.getByText(/TOOL_STREAM_DELTA/u)).toBeTruthy();
    expect(screen.getByText(/KEEP_PROPOSED → PROPOSED/u)).toBeTruthy();
    expect(screen.getByRole("link", { name: "knowledge-1@2" }).getAttribute("href")).toBe("#/knowledge/knowledge-1");
  });

  it("uses the server expected revision and idempotency key when activated by keyboard", async () => {
    const start = vi.fn(async () => ({ ...view, revision: 8 }));
    const user = userEvent.setup();
    render(<SessionExtractionPanel api={apiWith({ startSessionExtraction: start })} sessionId="session-1" />);
    const button = await screen.findByRole("button", { name: "提取当前会话快照" });
    button.focus();
    await user.keyboard("{Enter}");
    expect(start).toHaveBeenCalledWith({ sessionId: "session-1", expectedRevision: 7, idempotencyKey: "extract:session-1:7" });
    expect(await screen.findByText(/服务端最新 revision/u)).toBeTruthy();
  });

  it("does not query extraction when the actual capability is not verified", async () => {
    const query = vi.fn(async () => view);
    render(<SessionExtractionPanel api={apiWith({ capabilities: async () => ({ items: [{ ...ready, status: "NOT_VERIFIED", reasonCode: "CAPABILITY_NOT_VERIFIED" }] }), sessionExtraction: query })} sessionId="session-1" />);
    expect(await screen.findByText("CAPABILITY_NOT_VERIFIED")).toBeTruthy();
    expect(query).not.toHaveBeenCalled();
  });

  it("keeps stale command failures visible without claiming success", async () => {
    const user = userEvent.setup();
    render(<SessionExtractionPanel api={apiWith({ startSessionExtraction: async () => { throw new Error("STALE_REVISION"); } })} sessionId="session-1" />);
    await user.click(await screen.findByRole("button", { name: "提取当前会话快照" }));
    expect((await screen.findByRole("status")).textContent).toContain("STALE_REVISION");
    expect(screen.queryByText(/已确认/u)).toBeNull();
  });
});
