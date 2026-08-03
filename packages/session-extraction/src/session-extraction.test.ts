import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { jobEffectKey, SqliteDurableJobStore } from "@zhiloop/job-runtime";

import {
  SessionExtractionService,
  candidatePolicyCommitIdempotencyKey,
  candidatePreviewIdempotencyKey,
  snapshotIdempotencyKey,
} from "./service.js";
import { SessionExtractionStore } from "./store.js";
import {
  ExtractionConflictError,
  ExtractionStaleRevisionError,
  type CandidatePolicyCommitRequest,
  type CandidatePreviewRequest,
  type SnapshotCreateRequest,
} from "./types.js";

const observedAt = "2026-08-04T08:00:00.000Z";
const clock = () => new Date("2026-08-04T08:05:00.000Z");
const hash = (character: string) => character.repeat(64);

function snapshotRequest(overrides: Partial<Omit<SnapshotCreateRequest, "idempotencyKey">> = {}): SnapshotCreateRequest {
  const base: Omit<SnapshotCreateRequest, "idempotencyKey"> = {
    schemaVersion: 1,
    requestId: "request_snapshot_create_01",
    type: "extraction.snapshot.create",
    sessionId: "session-extraction-01",
    expectedCaptureRevision: 7,
    transcriptIdentityHash: hash("a"),
    sourceSequence: { from: 1, to: 3 },
    cursor: { byteOffset: 1_024, lineNumber: 30 },
    completeness: { status: "PARTIAL_SNAPSHOT", sourceClosed: false, unsupportedEventTypes: ["future_tool_event_v2"] },
    compilerVersion: "compiler-v2",
    policyHash: hash("b"),
    configurationHash: hash("c"),
    ...overrides,
  };
  return { ...base, idempotencyKey: snapshotIdempotencyKey(base) };
}

const sourceReferences = [
  { eventId: "event-1", turnId: "turn-1", sourceSequence: 1 },
  { eventId: "event-2", turnId: "turn-1", sourceSequence: 2 },
  { eventId: "event-3", turnId: "turn-2", sourceSequence: 3 },
] as const;

function previewRequest(snapshot: ReturnType<SessionExtractionService["createSnapshot"]>["snapshot"]): CandidatePreviewRequest {
  const body = {
    snapshot: { snapshotId: snapshot.snapshotId, revision: 1 as const, identityHash: snapshot.identityHash },
    compilerVersion: snapshot.compilerVersion,
    policyHash: snapshot.policyHash,
  };
  return {
    schemaVersion: 1,
    requestId: "request_candidate_preview_01",
    type: "extraction.candidates.preview",
    ...body,
    idempotencyKey: candidatePreviewIdempotencyKey(body),
  };
}

function commitRequest(
  snapshot: ReturnType<SessionExtractionService["createSnapshot"]>["snapshot"],
  previewId: string,
  revision: number,
): CandidatePolicyCommitRequest {
  const body = {
    snapshot: { snapshotId: snapshot.snapshotId, revision: 1 as const, identityHash: snapshot.identityHash },
    previewId,
    expectedPreviewRevision: revision,
    compilerVersion: snapshot.compilerVersion,
    policyHash: snapshot.policyHash,
  };
  return {
    schemaVersion: 1,
    requestId: "request_candidate_commit_01",
    type: "extraction.candidates.commit",
    ...body,
    idempotencyKey: candidatePolicyCommitIdempotencyKey(body),
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "zhiloop-session-extraction-"));
  const filename = join(directory, "runtime.sqlite");
  let jobCounter = 0;
  const jobs = new SqliteDurableJobStore(filename, { clock, idFactory: () => `job-extraction-${++jobCounter}` });
  const store = new SessionExtractionStore(filename);
  const service = new SessionExtractionService(store, jobs, { clock });
  return {
    filename,
    jobs,
    store,
    service,
    close: () => {
      store.close();
      jobs.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("session extraction snapshots", () => {
  it("derives immutable partial identity and replays the same source without duplication", () => {
    const runtime = fixture();
    try {
      const request = snapshotRequest();
      const first = runtime.service.createSnapshot(request, {
        captureRevision: 7,
        sourceReferences,
        observedAt,
      });
      const replay = runtime.service.createSnapshot(request, {
        captureRevision: 7,
        sourceReferences: [...sourceReferences].reverse(),
        observedAt,
      });
      expect(first.status).toBe("CREATED");
      expect(replay).toEqual({ status: "EXISTING", snapshot: first.snapshot });
      expect(first.snapshot).toMatchObject({
        revision: 1,
        completeness: { status: "PARTIAL_SNAPSHOT", sourceClosed: false, unsupportedEventTypes: ["future_tool_event_v2"] },
      });
      expect(first.snapshot.snapshotId).toBe(`snapshot_${first.snapshot.identityHash.slice(0, 48)}`);
      expect(runtime.service.listSnapshots({ sessionId: request.sessionId, limit: 10 }).items).toHaveLength(1);
    } finally {
      runtime.close();
    }
  });

  it("fails closed on stale capture, false completeness, invalid references and changed replay refs", () => {
    const runtime = fixture();
    try {
      expect(() => runtime.service.createSnapshot(snapshotRequest(), {
        captureRevision: 8,
        sourceReferences,
        observedAt,
      })).toThrow(ExtractionStaleRevisionError);
      const closed = snapshotRequest({
        completeness: { status: "COMPLETE_SNAPSHOT", sourceClosed: true, unsupportedEventTypes: [] },
      });
      expect(() => runtime.service.createSnapshot(closed, {
        captureRevision: 7,
        sourceReferences: [{ ...sourceReferences[0]!, sourceSequence: 99 }],
        observedAt,
      })).toThrow(/outside snapshot sequence range/);
      expect(() => runtime.service.createSnapshot(snapshotRequest({
        completeness: { status: "COMPLETE_SNAPSHOT", sourceClosed: true, unsupportedEventTypes: ["future_tool_event_v2"] },
      }), {
        captureRevision: 7,
        sourceReferences,
        observedAt,
      })).toThrow();

      const request = snapshotRequest();
      runtime.service.createSnapshot(request, { captureRevision: 7, sourceReferences, observedAt });
      expect(() => runtime.service.createSnapshot(request, {
        captureRevision: 7,
        sourceReferences: [{ ...sourceReferences[0], eventId: "changed-event" }, ...sourceReferences.slice(1)],
        observedAt,
      })).toThrow(ExtractionConflictError);
    } finally {
      runtime.close();
    }
  });

  it("remains idempotent across concurrent connections and process restart", () => {
    const runtime = fixture();
    let secondStore: SessionExtractionStore | undefined;
    try {
      secondStore = new SessionExtractionStore(runtime.filename);
      const second = new SessionExtractionService(secondStore, runtime.jobs, { clock });
      const request = snapshotRequest();
      const first = runtime.service.createSnapshot(request, { captureRevision: 7, sourceReferences, observedAt });
      expect(second.createSnapshot(request, { captureRevision: 7, sourceReferences, observedAt }).status).toBe("EXISTING");
      secondStore.close();
      secondStore = new SessionExtractionStore(runtime.filename);
      expect(secondStore.getSnapshot(first.snapshot.snapshotId)).toEqual(first.snapshot);
      expect(secondStore.migrationVersion()).toBe(1);
    } finally {
      secondStore?.close();
      runtime.close();
    }
  });

  it("creates a monotonic incremental snapshot linked to its immutable predecessor", () => {
    const runtime = fixture();
    try {
      const first = runtime.service.createSnapshot(snapshotRequest(), {
        captureRevision: 7,
        sourceReferences,
        observedAt,
      }).snapshot;
      const incrementalRequest = snapshotRequest({
        requestId: "request_snapshot_create_02",
        expectedCaptureRevision: 8,
        sourceSequence: { from: 4, to: 4 },
        cursor: { byteOffset: 2_048, lineNumber: 40 },
      });
      const incremental = runtime.service.createSnapshot(incrementalRequest, {
        captureRevision: 8,
        sourceReferences: [{ eventId: "event-4", turnId: "turn-2", sourceSequence: 4 }],
        previousSnapshotId: first.snapshotId,
        observedAt: "2026-08-04T08:10:00.000Z",
      }).snapshot;
      expect(incremental.previousSnapshotId).toBe(first.snapshotId);
      expect(runtime.service.getSnapshot(incremental.snapshotId)).toMatchObject({ previousSnapshotId: first.snapshotId });
      expect(() => runtime.service.createSnapshot(snapshotRequest({
        requestId: "request_snapshot_create_bad_predecessor",
        expectedCaptureRevision: 8,
        sourceSequence: { from: 3, to: 4 },
        cursor: { byteOffset: 2_048, lineNumber: 40 },
      }), {
        captureRevision: 8,
        sourceReferences: [{ eventId: "event-overlap", sourceSequence: 3 }],
        previousSnapshotId: first.snapshotId,
        observedAt: "2026-08-04T08:10:00.000Z",
      })).toThrow(/compatible incremental predecessor/);
    } finally {
      runtime.close();
    }
  });
});

describe("candidate preview and policy commit jobs", () => {
  it("uses separate durable, revision-bound, idempotent jobs without publishing from commit", () => {
    const runtime = fixture();
    try {
      const snapshot = runtime.service.createSnapshot(snapshotRequest(), {
        captureRevision: 7,
        sourceReferences,
        observedAt,
      }).snapshot;
      runtime.service.recordEpisodes(snapshot.snapshotId, [{ episodeId: "episode-1" }], observedAt);
      const previewCommand = previewRequest(snapshot);
      const enqueued = runtime.service.enqueueCandidatePreview(previewCommand);
      expect(runtime.service.enqueueCandidatePreview(previewCommand)).toMatchObject({ status: "EXISTING" });
      const claim = runtime.jobs.claimNext("worker-preview");
      if (claim.status !== "ACQUIRED") throw new Error("preview job was not acquired");
      const previewResult = runtime.service.completeCandidatePreview({
        jobId: claim.claim.jobId,
        effectKey: jobEffectKey(previewCommand.idempotencyKey, "candidate-preview"),
        status: "READY",
        candidates: [{
          candidateId: "candidate-1",
          episodeIds: ["episode-1"],
          compilerVersion: snapshot.compilerVersion,
          subjectKey: "project.extraction.snapshot-worker",
          kind: "IMPLEMENTATION",
          title: "Durable extraction",
          summary: "Separate candidate preview from policy commit.",
          confidence: 0.9,
          scope: "PROJECT",
          evidenceVerdict: "SUPPORTS",
          policyDecision: "PUBLISH",
          policyReasonCodes: ["EVIDENCE_SUPPORTED"],
        }],
        diagnostics: [],
        createdAt: observedAt,
        expiresAt: "2026-08-04T08:30:00.000Z",
      });
      runtime.jobs.succeed(claim.claim);
      expect(previewResult.status).toBe("CREATED");
      expect(runtime.service.completeCandidatePreview({
        jobId: claim.claim.jobId,
        effectKey: jobEffectKey(previewCommand.idempotencyKey, "candidate-preview"),
        status: "READY",
        candidates: previewResult.preview.candidates,
        diagnostics: [],
        createdAt: observedAt,
        expiresAt: "2026-08-04T08:30:00.000Z",
      }).status).toBe("EXISTING");

      expect(() => runtime.service.recordKnowledgeVersion({
        snapshotId: snapshot.snapshotId,
        candidateId: "candidate-1",
        knowledgeId: "knowledge-before-policy",
        version: 1,
        observedAt: "2026-08-04T08:05:30.000Z",
      })).toThrow(/durable policy commit/);

      const commitCommand = commitRequest(snapshot, previewResult.preview.previewId, previewResult.preview.revision);
      runtime.service.enqueuePolicyCommit(commitCommand);
      const commitClaim = runtime.jobs.claimNext("worker-commit");
      if (commitClaim.status !== "ACQUIRED") throw new Error("commit job was not acquired");
      expect(() => runtime.service.completePolicyCommit({
        jobId: commitClaim.claim.jobId,
        effectKey: jobEffectKey(commitCommand.idempotencyKey, "candidate-policy-commit"),
        decisions: [{ candidateId: "candidate-1", disposition: "REJECT", reasonCodes: ["EVIDENCE_SUPPORTED"] }],
        createdAt: "2026-08-04T08:06:00.000Z",
      })).toThrow(/immutable candidate preview/);
      const commit = runtime.service.completePolicyCommit({
        jobId: commitClaim.claim.jobId,
        effectKey: jobEffectKey(commitCommand.idempotencyKey, "candidate-policy-commit"),
        decisions: [{ candidateId: "candidate-1", disposition: "PUBLISH", reasonCodes: ["EVIDENCE_SUPPORTED"] }],
        createdAt: "2026-08-04T08:06:00.000Z",
      });
      runtime.jobs.succeed(commitClaim.claim);
      expect(commit.status).toBe("CREATED");
      expect(runtime.service.getCandidatePreviewForSnapshot(snapshot.snapshotId)).toEqual(previewResult.preview);
      expect(runtime.service.getPolicyCommitForPreview(previewResult.preview.previewId)).toEqual(commit.commit);
      expect(runtime.service.getProvenance({ root: { type: "CANDIDATE", candidateId: "candidate-1" }, limit: 10 }))
        .toMatchObject({ upstream: [{ relationType: "EPISODE_COMPILED_CANDIDATE" }], downstream: [] });

      runtime.service.recordKnowledgeVersion({
        snapshotId: snapshot.snapshotId,
        candidateId: "candidate-1",
        knowledgeId: "knowledge-1",
        version: 2,
        observedAt: "2026-08-04T08:07:00.000Z",
      });
      expect(runtime.service.getProvenance({
        root: { type: "KNOWLEDGE_VERSION", knowledge: { id: "knowledge-1", version: 2 } },
        limit: 10,
      })).toMatchObject({
        upstream: [{ relationType: "CANDIDATE_PUBLISHED_AS", from: { candidateId: "candidate-1" } }],
        completeness: "PARTIAL_UNSUPPORTED_EVENT_TYPES",
        unsupportedEventTypes: ["future_tool_event_v2"],
      });
      expect(enqueued.status).toBe("CREATED");
    } finally {
      runtime.close();
    }
  });

  it("rejects unbound keys, stale preview revisions and output drift on replay", () => {
    const runtime = fixture();
    try {
      const snapshot = runtime.service.createSnapshot(snapshotRequest(), {
        captureRevision: 7,
        sourceReferences,
        observedAt,
      }).snapshot;
      runtime.service.recordEpisodes(snapshot.snapshotId, [{ episodeId: "episode-1" }], observedAt);
      const previewCommand = previewRequest(snapshot);
      expect(() => runtime.service.enqueueCandidatePreview({ ...previewCommand, idempotencyKey: "candidate:preview:unbound-key" }))
        .toThrow(ExtractionConflictError);
      runtime.service.enqueueCandidatePreview(previewCommand);
      const claim = runtime.jobs.claimNext("worker-preview");
      if (claim.status !== "ACQUIRED") throw new Error("preview job was not acquired");
      const baseCompletion = {
        jobId: claim.claim.jobId,
        effectKey: jobEffectKey(previewCommand.idempotencyKey, "candidate-preview"),
        status: "READY" as const,
        candidates: [{
          candidateId: "candidate-1",
          episodeIds: ["episode-1"],
          compilerVersion: snapshot.compilerVersion,
          subjectKey: "project.extraction.snapshot-worker",
          kind: "IMPLEMENTATION" as const,
          title: "Durable extraction",
          summary: "Separate candidate preview from policy commit.",
          confidence: 0.9,
          scope: "PROJECT" as const,
          evidenceVerdict: "SUPPORTS" as const,
          policyDecision: "PUBLISH" as const,
          policyReasonCodes: ["EVIDENCE_SUPPORTED"],
        }],
        diagnostics: [],
        createdAt: observedAt,
        expiresAt: "2026-08-04T08:30:00.000Z",
      };
      const preview = runtime.service.completeCandidatePreview(baseCompletion).preview;
      const candidate = baseCompletion.candidates[0];
      if (candidate === undefined) throw new Error("candidate fixture is missing");
      expect(() => runtime.service.completeCandidatePreview({
        ...baseCompletion,
        candidates: [{ ...candidate, summary: "different output" }],
      })).toThrow(ExtractionConflictError);
      expect(() => runtime.service.enqueuePolicyCommit(commitRequest(snapshot, preview.previewId, preview.revision + 1)))
        .toThrow(ExtractionStaleRevisionError);
    } finally {
      runtime.close();
    }
  });

  it("recovers a queued preview job after every SQLite connection restarts", () => {
    const runtime = fixture();
    const snapshot = runtime.service.createSnapshot(snapshotRequest(), {
      captureRevision: 7,
      sourceReferences,
      observedAt,
    }).snapshot;
    const request = previewRequest(snapshot);
    const queued = runtime.service.enqueueCandidatePreview(request);
    runtime.store.close();
    runtime.jobs.close();
    const jobs = new SqliteDurableJobStore(runtime.filename, { clock, idFactory: () => "job-after-restart" });
    const store = new SessionExtractionStore(runtime.filename);
    try {
      const recovered = new SessionExtractionService(store, jobs, { clock });
      expect(recovered.enqueueCandidatePreview(request)).toMatchObject({
        status: "EXISTING",
        job: { snapshot: { jobId: queued.job.snapshot.jobId, status: "QUEUED" } },
      });
      expect(jobs.claimNext("worker-after-restart")).toMatchObject({
        status: "ACQUIRED",
        claim: { jobId: queued.job.snapshot.jobId, jobType: "CANDIDATE_PREVIEW" },
      });
    } finally {
      store.close();
      jobs.close();
      rmSync(dirname(runtime.filename), { recursive: true, force: true });
    }
  });
});

describe("bounded bidirectional provenance and storage recovery", () => {
  it("paginates stable direct edges and traces session/event to knowledge in reverse", () => {
    const runtime = fixture();
    try {
      const snapshot = runtime.service.createSnapshot(snapshotRequest(), {
        captureRevision: 7,
        sourceReferences,
        observedAt,
      }).snapshot;
      const first = runtime.service.getProvenance({ root: { type: "SNAPSHOT", snapshotId: snapshot.snapshotId, revision: 1 }, limit: 1 });
      expect(first.completeness).toBe("TRUNCATED");
      expect(first.nextCursor).toBeDefined();
      if (first.nextCursor === undefined) throw new Error("truncated provenance cursor is missing");
      const second = runtime.service.getProvenance({
        root: { type: "SNAPSHOT", snapshotId: snapshot.snapshotId, revision: 1 },
        limit: 10,
        afterEdgeId: first.nextCursor,
      });
      const firstIds = [...first.upstream, ...first.downstream].map((edge) => edge.edgeId);
      const secondIds = [...second.upstream, ...second.downstream].map((edge) => edge.edgeId);
      expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
      expect(runtime.service.getProvenance({ root: { type: "EVENT", sessionId: snapshot.sessionId, eventId: "event-1", turnId: "turn-1", sourceSequence: 1 }, limit: 10 }))
        .toMatchObject({
          upstream: [{ relationType: "TURN_CONTAINS_EVENT" }],
          downstream: [{ relationType: "SNAPSHOT_INCLUDES_EVENT" }],
        });
    } finally {
      runtime.close();
    }
  });

  it("rejects a database from a newer migration and corrupted durable JSON", () => {
    const runtime = fixture();
    const snapshot = runtime.service.createSnapshot(snapshotRequest(), {
      captureRevision: 7,
      sourceReferences,
      observedAt,
    }).snapshot;
    runtime.store.close();
    const database = new DatabaseSync(runtime.filename);
    database.prepare("UPDATE extraction_snapshots SET payload_json = ? WHERE snapshot_id = ?")
      .run("{}", snapshot.snapshotId);
    database.close();
    const reopened = new SessionExtractionStore(runtime.filename);
    expect(() => reopened.getSnapshot(snapshot.snapshotId)).toThrow(/integrity verification/);
    reopened.close();
    const migration = new DatabaseSync(runtime.filename);
    migration.prepare("UPDATE session_extraction_meta SET version = 99 WHERE component = 'session-extraction'").run();
    migration.close();
    expect(() => new SessionExtractionStore(runtime.filename)).toThrow(/newer than supported/);
    runtime.jobs.close();
    rmSync(dirname(runtime.filename), { recursive: true, force: true });
  });
});
