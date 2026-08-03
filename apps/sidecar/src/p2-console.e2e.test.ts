import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventLedger } from "@zhiloop/conversation-ledger";
import type { EventEnvelope } from "@zhiloop/domain";
import {
  p2IndexRecoveryResultSchema,
  p2KnowledgeDetailViewSchema,
  p2KnowledgeEditImpactSchema,
  p2KnowledgeListViewSchema,
  p2SessionExtractionViewSchema,
  type JobSnapshot,
} from "@zhiloop/control-api";
import type { KnowledgeExtractionInput, KnowledgeExtractionPort } from "@zhiloop/knowledge-compiler";
import { snapshotIdempotencyKey } from "@zhiloop/session-extraction";
import { afterEach, describe, expect, it } from "vitest";

import { P2ConsoleRuntime } from "./p2-console.js";
import { P2ProductionComposition } from "./p2-production.js";
import { P2SidecarRuntime } from "./p2-runtime.js";

const directories: string[] = [];
afterEach(async () => await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true }))));

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

function events(): readonly EventEnvelope[] {
  const fixtures = [
    { eventType: "session.started" as const, payload: { kind: "session-started" }, cwd: "/workspace/project" },
    { eventType: "user.prompted" as const, payload: { kind: "user-prompt", prompt: "确认使用可恢复 outbox" }, turnId: "turn-1" },
    { eventType: "turn.stopped" as const, payload: { kind: "turn-stopped", stopHookActive: false, lastAssistantMessage: "方案已确认" }, turnId: "turn-1" },
    { eventType: "session.ended" as const, payload: { kind: "session-ended" } },
  ];
  return fixtures.map((fixture, index) => ({
    schemaVersion: 1,
    eventId: sha(`event-${index}`), source: "codex-hook", sourceItemId: `source-${index}`,
    eventType: fixture.eventType, sessionId: "session-1", ...(fixture.turnId === undefined ? {} : { turnId: fixture.turnId }),
    occurredAt: new Date(Date.UTC(2026, 7, 4, 8, 0, index)).toISOString(),
    ...(fixture.cwd === undefined ? {} : { cwd: fixture.cwd }), contentHash: sha(`content-${index}`),
    correlationId: sha("session-1"), payload: fixture.payload,
  }));
}

const compiler: KnowledgeExtractionPort = {
  extract: async (input: KnowledgeExtractionInput) => ({
    schemaVersion: 1,
    candidates: [{
      subjectKey: "project.console.durable-outbox", kind: "DECISION", scopeHint: { level: "PROJECT", reasonCodes: ["PROJECT_BOUND"] },
      title: "Use a durable outbox", summary: "Publishing is replayable", body: "Markdown, Registry and index advance through a recoverable outbox.",
      confidence: 0.95, assertions: [{ kind: "USER_ACCEPTED", parameters: { statementRef: input.goalRef } }], evidenceHints: [],
    }],
  }),
};

async function waitFor<T>(read: () => Promise<T | undefined> | T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error("P2 E2E timed out");
}

describe("P2 Console real composition", () => {
  it("runs snapshot → preview → commit → reverse trace → edit → suppress → restore → index recovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zhiloop-p2-e2e-")); directories.push(directory);
    const ledger = new SqliteEventLedger(join(directory, "ledger.sqlite"));
    for (const event of events()) ledger.append(event);
    ledger.commitIngestionCursor("codex-transcript:session-1", { byteOffset: 400, lineNumber: 4 });
    const runtimeReference: { value?: P2SidecarRuntime } = {};
    const production = await P2ProductionComposition.create({
      stateDirectory: directory, ledger, extraction: () => runtimeReference.value!.service(), compilerTimeoutMs: 1_000, compilerBatchSize: 10, compiler,
    });
    const jobs: JobSnapshot[] = [];
    const runtime = await P2SidecarRuntime.create({
      stateDirectory: directory, knowledgeWorker: production.worker, projectJob: (snapshot) => { jobs.push(snapshot); },
      snapshotSource: { observe: async (request) => ({
        captureRevision: ledger.count(), observedAt: new Date().toISOString(),
        sourceReferences: ledger.readAfter(request.sourceSequence.from - 1, 100).filter((record) => record.sequence <= request.sourceSequence.to)
          .map((record) => ({ eventId: record.event.eventId, ...(record.event.turnId === undefined ? {} : { turnId: record.event.turnId }), sourceSequence: record.sequence })),
      }) },
    });
    runtimeReference.value = runtime;
    await runtime.start();
    const legacyDraft = {
      schemaVersion: 1 as const,
      requestId: "legacy-snapshot",
      type: "extraction.snapshot.create" as const,
      sessionId: "session-1",
      expectedCaptureRevision: ledger.count(),
      transcriptIdentityHash: sha("transcript"),
      sourceSequence: { from: 1, to: ledger.count() },
      cursor: { byteOffset: 400, lineNumber: 4 },
      completeness: { status: "COMPLETE_SNAPSHOT" as const, sourceClosed: true, unsupportedEventTypes: [] },
      compilerVersion: "mvp-compiler-v2",
      policyHash: sha("legacy-policy"),
      configurationHash: sha("configuration"),
    };
    await runtime.createSnapshot({ ...legacyDraft, idempotencyKey: snapshotIdempotencyKey(legacyDraft) });
    const facade = new P2ConsoleRuntime({
      runtime, production, ledger, configurationHash: () => sha("configuration"),
      inspectTranscriptSource: async () => ({ schemaVersion: 1, sessionId: "session-1", previewRevision: 1, transcriptIdentityHash: sha("transcript"), projectedEvents: 0, ignoredRecords: 0, eventTypes: {}, cursor: { byteOffset: 400, lineNumber: 4 }, hasMore: false, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    });
    try {
      const revision = ledger.count();
      await facade.handle({ schemaVersion: 1, requestId: "start-1", type: "p2.session.preview", sessionId: "session-1", expectedRevision: revision, idempotencyKey: `extract:session-1:${revision}` });
      const previewView = await waitFor(() => {
        const failed = jobs.find((job) => job.status === "FAILED");
        if (failed !== undefined) {
          const snapshotId = runtime!.service().listSnapshots({ sessionId: "session-1", limit: 1 }).items[0]?.snapshotId ?? "missing";
          throw new Error(`preview failed: ${JSON.stringify(production.checkpoint(snapshotId))}`);
        }
        const value = facade.sessionView("session-1");
        return value.previewId === undefined ? undefined : value;
      });
      p2SessionExtractionViewSchema.parse(previewView);
      expect(previewView.snapshot?.compilerVersion).toBe("mvp-compiler-v3");
      expect(runtime.service().listSnapshots({ sessionId: "session-1", limit: 10 }).items).toHaveLength(2);
      expect(previewView.commitAction.enabled).toBe(true);
      await facade.handle({ schemaVersion: 1, requestId: "commit-1", type: "p2.session.commit", sessionId: "session-1", previewId: previewView.previewId!, expectedPreviewRevision: previewView.commitAction.expectedRevision, idempotencyKey: previewView.commitAction.idempotencyKey });
      const committedView = await waitFor(() => {
        const value = facade.sessionView("session-1");
        return value.stages.some(({ stage, status }) => stage === "KNOWLEDGE_PUBLICATION" && status === "SUCCEEDED") ? value : undefined;
      });
      const list = await waitFor(async () => {
        const value = p2KnowledgeListViewSchema.parse(await facade.handle({ schemaVersion: 1, requestId: "list-1", type: "p2.knowledge.list" }));
        return value.items[0];
      });
      expect(committedView.candidates[0]?.provenance.knowledgeVersions).toContainEqual({ knowledgeId: list.knowledgeId, version: 1 });

      type KnowledgeDetailView = {
        summary: string; markdown: string; version: number; status: string; eligible: boolean;
        editAction: { idempotencyKey: string };
        suppressAction: { idempotencyKey: string };
        restoreAction: { idempotencyKey: string };
      };
      const detail = p2KnowledgeDetailViewSchema.parse(await facade.handle({ schemaVersion: 1, requestId: "detail-1", type: "p2.knowledge.get", knowledgeId: list.knowledgeId })) as KnowledgeDetailView;
      expect(detail.status).toBe("ACCEPTED");
      const edit = { title: "Use a durable publication outbox", summary: detail.summary, markdown: detail.markdown };
      const impact = p2KnowledgeEditImpactSchema.parse(await facade.handle({ schemaVersion: 1, requestId: "edit-preview", type: "p2.knowledge.edit.preview", knowledgeId: list.knowledgeId, expectedVersion: detail.version, idempotencyKey: detail.editAction.idempotencyKey, draft: edit }));
      expect(impact).toMatchObject({ evidenceDowngraded: true, eligibleAfter: false });
      expect(impact.reasonCodes).toContain("CONTENT_CHANGED_REQUIRES_REVALIDATION");
      const edited = await facade.handle({ schemaVersion: 1, requestId: "edit-commit", type: "p2.knowledge.edit.commit", knowledgeId: list.knowledgeId, expectedVersion: detail.version, idempotencyKey: detail.editAction.idempotencyKey, draft: edit }) as KnowledgeDetailView;
      expect(edited).toMatchObject({ status: "STALE", eligible: false });
      const suppressed = await facade.handle({ schemaVersion: 1, requestId: "suppress", type: "p2.knowledge.suppress", knowledgeId: list.knowledgeId, expectedVersion: edited.version, idempotencyKey: edited.suppressAction.idempotencyKey, reason: "obsolete" }) as KnowledgeDetailView;
      expect(suppressed.eligible).toBe(false);
      const restored = await facade.handle({ schemaVersion: 1, requestId: "restore", type: "p2.knowledge.restore", knowledgeId: list.knowledgeId, expectedVersion: suppressed.version, idempotencyKey: suppressed.restoreAction.idempotencyKey, reason: "revalidated" }) as KnowledgeDetailView;
      expect(restored.eligible).toBe(false);
      const recovered = p2IndexRecoveryResultSchema.parse(await facade.handle({ schemaVersion: 1, requestId: "recover", type: "p2.knowledge.index.recover", knowledgeId: list.knowledgeId }));
      expect(["UNCHANGED", "INDEXED", "CHUNKS_REFRESHED"]).toContain(recovered.action);
    } finally {
      await runtime.close(); production.close(); ledger.close();
    }
  }, 20_000);
});
