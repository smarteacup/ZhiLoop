import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtractionSnapshot, JobSnapshot, P2ControlRequest } from "@zhiloop/control-api";
import type { KnowledgeWorkerCheckpoint, KnowledgeWorkerRunRequest } from "@zhiloop/knowledge-worker-runtime";
import { snapshotIdempotencyKey } from "@zhiloop/session-extraction";
import { afterEach, describe, expect, it } from "vitest";

import {
  P2CapabilityUnavailableError,
  P2SidecarRuntime,
  p2CommitRequest,
  p2PreviewRequest,
  type P2KnowledgeWorkerComposition,
} from "./p2-runtime.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

type SnapshotRequest = Extract<P2ControlRequest, { readonly type: "extraction.snapshot.create" }>;

function snapshotRequest(overrides: Partial<SnapshotRequest> = {}): SnapshotRequest {
  const base = {
    schemaVersion: 1 as const,
    requestId: "snapshot-request-1",
    type: "extraction.snapshot.create" as const,
    sessionId: "session-1",
    expectedCaptureRevision: 1,
    transcriptIdentityHash: hash("transcript-1"),
    sourceSequence: { from: 1, to: 1 },
    cursor: { byteOffset: 100, lineNumber: 1 },
    completeness: { status: "PARTIAL_SNAPSHOT" as const, sourceClosed: false, unsupportedEventTypes: [] },
    compilerVersion: "compiler-v1",
    policyHash: hash("policy-v1"),
    configurationHash: hash("configuration-v1"),
  };
  const request = { ...base, ...overrides };
  return { ...request, idempotencyKey: snapshotIdempotencyKey(request) };
}

function workerCheckpoint(
  snapshot: ExtractionSnapshot,
  status: "AWAITING_COMMIT" | "RETRYABLE" | "FAILED" | "COMPLETED",
): KnowledgeWorkerCheckpoint {
  const now = new Date().toISOString();
  const candidate = {
    schemaVersion: 1,
    candidateId: "candidate-1",
    compilerVersion: snapshot.compilerVersion,
    status: "PROPOSED",
    subjectKey: "project.arch.decision",
    kind: "DECISION",
    scopeHint: { level: "PROJECT", reasonCodes: [] },
    title: "Use a durable outbox",
    summary: "Publication resumes from a durable policy boundary.",
    body: "Publication resumes from a durable policy boundary.",
    sourceEpisodes: ["episode-1"],
    confidence: 0.9,
    createdAt: now,
    correlationId: "correlation-1",
    assertions: [{
      assertionId: "assertion-1",
      kind: "USER_ACCEPTED",
      parameters: { statementRef: "statement-1" },
    }],
    evidenceHints: [],
  };
  const policy = {
    candidate,
    currentStatus: "PROPOSED",
    scope: { scope: { level: "PROJECT", projectId: "project-1" }, projectSpecificSignals: [], reasonCodes: [] },
    verificationResults: [{
      assertionId: "assertion-1",
      assertionKind: "USER_ACCEPTED",
      status: "SUPPORTED",
      target: "statement-1",
      observedAt: now,
      reasonCodes: ["USER_ACCEPTED"],
    }],
    decision: {
      action: "APPLY",
      interaction: "NONE",
      currentStatus: "PROPOSED",
      targetStatus: "ACCEPTED",
      transitionPath: ["PROPOSED", "ACCEPTED"],
      effectiveScope: { level: "PROJECT", projectId: "project-1" },
      shouldPublish: true,
      evidenceIds: [],
      reasonCodes: ["EVIDENCE_SUPPORTED"],
    },
  };
  return {
    schemaVersion: 1,
    workId: `work-${snapshot.snapshotId}`,
    identityHash: hash(snapshot.identityHash),
    revision: status === "COMPLETED" ? 3 : 2,
    status,
    createdAt: now,
    updatedAt: now,
    stages: (status === "FAILED" || status === "RETRYABLE" ? {
      COMPILE: {
        status: "FAILED",
        attempts: 5,
        error: { code: "COMPILER_ADAPTER_UNAVAILABLE", message: "offline", retryable: true, occurredAt: now },
      },
    } : {}) as KnowledgeWorkerCheckpoint["stages"],
    payload: {
      episodes: [{ episodeId: "episode-1", status: "COMPLETED" }] as never,
      policies: [policy] as never,
      outbox: [{
        candidateId: "candidate-1",
        asset: { id: "knowledge-1", version: 1 },
        ...(status === "COMPLETED" ? { markdown: {} } : {}),
      }] as never,
    },
  };
}

function knowledgeWorker(options: { failCommitOnce?: boolean; failPreview?: boolean } = {}): P2KnowledgeWorkerComposition {
  let commitCalls = 0;
  let snapshot: ExtractionSnapshot | undefined;
  return {
    requestFor: (value) => {
      snapshot = value;
      return { workId: `work-${value.snapshotId}` } as KnowledgeWorkerRunRequest;
    },
    runtime: {
      run: async (_request, runOptions) => {
        if (snapshot === undefined) throw new Error("requestFor was not called");
        if (runOptions?.executionMode === "PREVIEW_ONLY") {
          return workerCheckpoint(snapshot, options.failPreview === true ? "RETRYABLE" : "AWAITING_COMMIT");
        }
        if (runOptions?.executionMode !== "SAFE_AUTO_PUBLICATION"
          || runOptions.publicationAuthorization?.kind !== "EXPLICIT_COMMIT"
          || runOptions.publicationAuthorization.authorizationId.length === 0) {
          throw new Error("commit did not provide stable publication authorization");
        }
        commitCalls += 1;
        return workerCheckpoint(snapshot, options.failCommitOnce === true && commitCalls === 1 ? "RETRYABLE" : "COMPLETED");
      },
    },
  };
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error("timed out waiting for P2 background work");
}

async function runtimeFixture(directory: string, worker?: P2KnowledgeWorkerComposition) {
  return await P2SidecarRuntime.create({
    stateDirectory: directory,
    pollIntervalMs: 100,
    ...(worker === undefined ? {} : { knowledgeWorker: worker }),
    projectJob: () => undefined,
    snapshotSource: {
      observe: async (request) => ({
        captureRevision: request.expectedCaptureRevision,
        sourceReferences: [{ eventId: "event-1", turnId: "turn-1", sourceSequence: 1 }],
        observedAt: new Date().toISOString(),
      }),
    },
  });
}

describe("P2SidecarRuntime", () => {
  it("serializes preview and policy commit, then recovers a retryable publication outbox", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zhiloop-p2-sidecar-"));
    directories.push(directory);
    const runtime = await runtimeFixture(directory, knowledgeWorker({ failCommitOnce: true }));
    await runtime.start();
    try {
      const created = await runtime.createSnapshot(snapshotRequest());
      const replay = await runtime.createSnapshot(snapshotRequest({ requestId: "snapshot-replay" }));
      expect(created.status).toBe("CREATED");
      expect(replay.status).toBe("EXISTING");

      await runtime.enqueueCandidatePreview(p2PreviewRequest(created.snapshot, "preview-request"));
      const preview = await waitFor(() => runtime.service().getCandidatePreviewForSnapshot(created.snapshot.snapshotId));
      expect(preview.candidates[0]).toMatchObject({ policyDecision: "PUBLISH", evidenceVerdict: "SUPPORTS" });

      await runtime.enqueuePolicyCommit(p2CommitRequest(created.snapshot, preview.previewId, preview.revision, "commit-request"));
      const commit = await waitFor(() => runtime.service().getPolicyCommitForPreview(preview.previewId));
      expect(commit.decisions).toEqual(preview.candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        disposition: candidate.policyDecision,
        reasonCodes: candidate.policyReasonCodes,
      })));
      const provenance = await waitFor(() => {
        const value = runtime.service().getProvenance({ root: { type: "CANDIDATE", candidateId: "candidate-1" }, limit: 20 });
        return value.downstream.some(({ relationType }) => relationType === "CANDIDATE_PUBLISHED_AS") ? value : undefined;
      });
      expect(provenance.downstream).toEqual(expect.arrayContaining([
        expect.objectContaining({ relationType: "CANDIDATE_PUBLISHED_AS" }),
      ]));
    } finally {
      await runtime.close();
    }
  });

  it("restores a queued manual preview after every P2 SQLite component restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zhiloop-p2-restart-"));
    directories.push(directory);
    const first = await runtimeFixture(directory, knowledgeWorker());
    await first.start();
    const created = await first.createSnapshot(snapshotRequest());
    await first.enqueueCandidatePreview(p2PreviewRequest(created.snapshot, "preview-before-restart"));
    await first.close();

    const reopened = await runtimeFixture(directory, knowledgeWorker());
    await reopened.start();
    try {
      const preview = await waitFor(() => reopened.service().getCandidatePreviewForSnapshot(created.snapshot.snapshotId));
      expect(preview.status).toBe("READY");
    } finally {
      await reopened.close();
    }
  });

  it("keeps manual snapshots and provenance ready while truthfully rejecting an unconfigured compiler", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zhiloop-p2-unconfigured-"));
    directories.push(directory);
    const runtime = await runtimeFixture(directory);
    await runtime.start();
    try {
      const created = await runtime.createSnapshot(snapshotRequest());
      expect(runtime.state()).toMatchObject({ extraction: "READY", provenance: "READY", knowledgeCompile: "NOT_CONFIGURED" });
      await expect(runtime.enqueueCandidatePreview(p2PreviewRequest(created.snapshot, "preview-unconfigured")))
        .rejects.toBeInstanceOf(P2CapabilityUnavailableError);
    } finally {
      await runtime.close();
    }
  });

  it("projects a terminal compiler failure without fabricating a candidate preview", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zhiloop-p2-failure-"));
    directories.push(directory);
    const projected: JobSnapshot[] = [];
    const runtime = await P2SidecarRuntime.create({
      stateDirectory: directory,
      knowledgeWorker: knowledgeWorker({ failPreview: true }),
      projectJob: (snapshot) => { projected.push(snapshot); },
      snapshotSource: {
        observe: async (request) => ({
          captureRevision: request.expectedCaptureRevision,
          sourceReferences: [{ eventId: "event-1", turnId: "turn-1", sourceSequence: 1 }],
          observedAt: new Date().toISOString(),
        }),
      },
    });
    await runtime.start();
    try {
      const created = await runtime.createSnapshot(snapshotRequest());
      const job = await runtime.enqueueCandidatePreview(p2PreviewRequest(created.snapshot, "preview-failed"));
      const failed = await waitFor(
        () => projected.find((snapshot) => snapshot.jobId === job.jobId && snapshot.status === "FAILED"),
        8_000,
      );
      expect(failed.lastFailure?.retryable).toBe(true);
      expect(failed.lastFailure?.code).toBe("COMPILER_ADAPTER_UNAVAILABLE");
      expect(runtime.candidatePreviewJobForSnapshot(created.snapshot.snapshotId)).toMatchObject({
        jobId: job.jobId,
        status: "FAILED",
        attempt: failed.attempt,
        lastFailure: failed.lastFailure,
      });
      expect(runtime.hasJob(job.jobId)).toBe(true);
      if (failed.revision === undefined) throw new Error("failed job revision is missing");
      await expect(runtime.retryJob({
        jobId: job.jobId,
        expectedRevision: failed.revision,
        idempotencyKey: "operator:retry:p2-runtime",
      })).resolves.toMatchObject({ disposition: "APPLIED", job: { status: "QUEUED" } });
      expect(runtime.service().getCandidatePreviewForSnapshot(created.snapshot.snapshotId)).toBeUndefined();
    } finally {
      await runtime.close();
    }
  }, 10_000);

  it("rejects a stale source revision before it can persist a snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zhiloop-p2-stale-"));
    directories.push(directory);
    const runtime = await P2SidecarRuntime.create({
      stateDirectory: directory,
      projectJob: () => undefined,
      snapshotSource: {
        observe: async () => ({ captureRevision: 2, sourceReferences: [], observedAt: new Date().toISOString() }),
      },
    });
    await runtime.start();
    try {
      await expect(runtime.createSnapshot(snapshotRequest())).rejects.toThrow("capture revision changed");
      expect(runtime.service().listSnapshots({ limit: 10 }).items).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });
});
