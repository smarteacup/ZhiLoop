import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { KnowledgeAsset, KnowledgeCandidate } from "@zhiloop/domain";
import { EvolutionJobRuntime, type KnowledgeRepairDraftJobInput } from "@zhiloop/evolution-job-runtime";
import { JobCancellationRequestedError, type JobExecutionContext, type NonRetryableJobError } from "@zhiloop/job-runtime";
import { SqliteKnowledgeFreshnessStore } from "@zhiloop/knowledge-freshness";
import { SqliteKnowledgeRepairDraftStore } from "@zhiloop/knowledge-repair-drafts";
import { SqliteKnowledgeVerificationStore, type KnowledgeVerificationRunSummary } from "@zhiloop/knowledge-verification";
import { describe, expect, it } from "vitest";

import { createKnowledgeRepairDraftHandler } from "./repair.js";

const NOW = "2026-08-19T03:00:00.000Z";
const CONTENT_HASH = "c".repeat(64);

function candidate(): KnowledgeCandidate {
  return { schemaVersion: 1, candidateId: "candidate-repair-source", compilerVersion: "compiler-1", status: "PROPOSED",
    subjectKey: "project.module.repair", kind: "IMPLEMENTATION",
    scopeHint: { level: "PROJECT", projectId: "project-1", reasonCodes: ["PROJECT"] },
    title: "Old implementation", summary: "OldSymbol implements the flow", body: "OldSymbol implements the flow.",
    sourceEpisodes: ["episode-1"], confidence: 0.9, createdAt: NOW, correlationId: "correlation-1",
    assertions: [{ assertionId: "assertion-old-symbol", candidateId: "candidate-repair-source", kind: "SYMBOL_EXISTS",
      parameters: { projectId: "project-1", symbol: "OldSymbol", path: "src/old.ts" }, createdAt: NOW }], evidenceHints: [] };
}

function asset(source: KnowledgeCandidate): KnowledgeAsset {
  return { schemaVersion: 1, id: "asset-repair", subjectKey: source.subjectKey, kind: source.kind,
    scope: { level: "PROJECT", projectId: "project-1" }, version: 1, status: "VERIFIED", title: source.title,
    summary: source.summary, body: source.body, aliases: [], keywords: [], applicability: [], nonApplicability: [],
    symbols: ["OldSymbol"], relations: [], evidence: [{ evidenceId: "evidence-old", verdict: "SUPPORTS" }],
    confidence: source.confidence, sourceEpisodes: source.sourceEpisodes, contentHash: CONTENT_HASH,
    correlationId: source.correlationId, createdAt: NOW, updatedAt: NOW };
}

function run(overrides: Partial<KnowledgeVerificationRunSummary> = {}): KnowledgeVerificationRunSummary {
  return { schemaVersion: 1, runId: "vrun-repair", requestId: "vreq-repair", purpose: "FRESHNESS",
    projectId: "project-1", subjectKey: "project.module.repair", candidateId: "candidate-repair-source",
    knowledgeVersion: { assetId: "asset-repair", assetVersion: 1 }, codeRevision: "git-current",
    codeRevisionCapability: "READY", status: "COMPLETED", qualifyingProof: false,
    results: [{ assertionId: "assertion-old-symbol", assertionKind: "SYMBOL_EXISTS", status: "REFUTED",
      reasonCodes: ["SYMBOL_NOT_FOUND"], evidenceId: "evidence-refuted" }], startedAt: NOW, completedAt: NOW, ...overrides };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "zhiloop-repair-handler-"));
  const freshness = new SqliteKnowledgeFreshnessStore(join(root, "freshness.sqlite"));
  const source = candidate();
  freshness.project({ asset: asset(source), candidate: source, projectId: "project-1", observedAt: NOW,
    verificationResults: [{ assertionId: "assertion-old-symbol", assertionKind: "SYMBOL_EXISTS", verifierId: "symbol-v1",
      status: "SUPPORTED", target: "OldSymbol", observedAt: NOW, reasonCodes: ["SYMBOL_FOUND"] }] });
  freshness.transition({ assetId: "asset-repair", assetVersion: 1, expectedRevision: 0, projectId: "project-1",
    status: "CONFLICT", codeRevision: "git-current", reasonCodes: ["ASSERTION_REFUTED"],
    affectedAssertionIds: ["assertion-old-symbol"], updatedAt: NOW });
  const verification = new SqliteKnowledgeVerificationStore(join(root, "verification.sqlite"));
  verification.appendRun(run());
  const drafts = new SqliteKnowledgeRepairDraftStore(join(root, "drafts.sqlite"));
  const input: KnowledgeRepairDraftJobInput = { schemaVersion: 1, jobType: "KNOWLEDGE_REPAIR_DRAFT",
    projectId: "project-1", assetId: "asset-repair", assetVersion: 1, conflictRunId: "vrun-repair" };
  return { root, freshness, verification, drafts, input };
}

function directContext(input: unknown, checkpoint?: unknown): JobExecutionContext {
  return { jobId: "job-direct", jobType: "KNOWLEDGE_REPAIR_DRAFT", attemptId: "attempt-direct", attempt: 1,
    fencingToken: 1, idempotencyKey: "direct-key", input: input as never, signal: new AbortController().signal,
    getCheckpoint: () => checkpoint === undefined ? undefined : ({ data: checkpoint } as never),
    saveCheckpoint: () => ({ data: checkpoint } as never), heartbeat: () => ({ leaseExpiresAt: NOW, cancellationRequested: false }),
    isCancellationRequested: () => false, throwIfCancellationRequested: () => undefined,
    effectKey: () => "e".repeat(64) };
}

describe("KNOWLEDGE_REPAIR_DRAFT durable handler", () => {
  it("persists one pending traceable draft and reuses it after restart", async () => {
    const value = setup();
    const filename = join(value.root, "jobs.sqlite");
    let clock = Date.parse(NOW); let failAfterCreate = true;
    const draftPort = { ...value.drafts,
      create: (...args: Parameters<SqliteKnowledgeRepairDraftStore["create"]>) => {
        const result = value.drafts.create(...args);
        if (failAfterCreate) { failAfterCreate = false; throw new Error("PROCESS_EXIT_AFTER_DRAFT"); }
        return result;
      },
      get: value.drafts.get.bind(value.drafts), getByConflict: value.drafts.getByConflict.bind(value.drafts),
      list: value.drafts.list.bind(value.drafts), attachCandidate: value.drafts.attachCandidate.bind(value.drafts),
      dismiss: value.drafts.dismiss.bind(value.drafts), fail: value.drafts.fail.bind(value.drafts),
      promote: value.drafts.promote.bind(value.drafts) };
    const handler = createKnowledgeRepairDraftHandler({ freshness: value.freshness, verification: value.verification, drafts: draftPort });
    const options = { clock: () => new Date(clock), random: () => 0,
      retryPolicy: { baseDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 } };
    const first = new EvolutionJobRuntime(filename, { workerId: "repair-worker-1", handlers: { KNOWLEDGE_REPAIR_DRAFT: handler }, store: options });
    first.enqueue(value.input, 3);
    expect(await first.runOnce()).toMatchObject({ status: "RETRY_WAIT" });
    expect(value.drafts.list({ limit: 10 }).items).toHaveLength(1);
    first.close(); clock += 10;
    const second = new EvolutionJobRuntime(filename, { workerId: "repair-worker-2", handlers: { KNOWLEDGE_REPAIR_DRAFT: handler }, store: options });
    expect(await second.runOnce()).toMatchObject({ status: "SUCCEEDED" });
    const stored = value.drafts.getByConflict("asset-repair", 1, "vrun-repair")!;
    expect(stored).toMatchObject({ status: "PENDING", inheritedAuthorization: false, sourceKnowledge: {
      contentHash: CONTENT_HASH, lifecycleStatus: "VERIFIED", candidate: { candidateId: "candidate-repair-source" } },
    conflict: { runId: "vrun-repair", codeRevision: "git-current" },
    changedAssertions: [{ assertionId: "assertion-old-symbol", verificationStatus: "UNSUPPORTED" }] });
    expect(value.freshness.get("asset-repair", 1)?.assetContentHash).toBe(CONTENT_HASH);
    expect(second.list({ limit: 10 }).items[0]).toMatchObject({ status: "SUCCEEDED", checkpointPhase: "DRAFT_PERSISTED" });
    second.close(); value.drafts.close(); value.verification.close(); value.freshness.close();
  });

  it.each([
    ["non-conflict", (value: ReturnType<typeof setup>) => value.freshness.transition({ assetId: "asset-repair", assetVersion: 1,
      expectedRevision: 1, projectId: "project-1", status: "FRESH", codeRevision: "git-current-2", reasonCodes: [],
      affectedAssertionIds: [], updatedAt: "2026-08-19T03:01:00.000Z" }), "REPAIR_SOURCE_NOT_CONFLICT"],
    ["wrong-project", (value: ReturnType<typeof setup>) => {
      value.verification.close();
      value.verification = new SqliteKnowledgeVerificationStore(join(value.root, "verification-other.sqlite"));
      value.verification.appendRun(run({ projectId: "project-other" }));
    }, "REPAIR_RUN_IDENTITY_MISMATCH"],
    ["no-refuted-assertion", (value: ReturnType<typeof setup>) => {
      value.verification.close();
      value.verification = new SqliteKnowledgeVerificationStore(join(value.root, "verification-supported.sqlite"));
      value.verification.appendRun(run({ results: [{ assertionId: "assertion-old-symbol", assertionKind: "SYMBOL_EXISTS",
        status: "SUPPORTED", reasonCodes: ["SYMBOL_FOUND"] }] }));
    }, "REPAIR_REFUTED_ASSERTION_MISSING"],
  ])("fails terminally for %s without creating a draft", async (_name, mutate, code) => {
    const value = setup(); mutate(value);
    const runtime = new EvolutionJobRuntime(join(value.root, "negative-jobs.sqlite"), { workerId: "repair-negative",
      handlers: { KNOWLEDGE_REPAIR_DRAFT: createKnowledgeRepairDraftHandler({ freshness: value.freshness,
        verification: value.verification, drafts: value.drafts }) } });
    runtime.enqueue(value.input, 2);
    expect(await runtime.runOnce()).toMatchObject({ status: "FAILED", job: { snapshot: { lastFailure: { code, retryable: false } } } });
    expect(value.drafts.list({ limit: 10 }).items).toEqual([]);
    runtime.close(); value.drafts.close(); value.verification.close(); value.freshness.close();
  });

  it("validates checkpoint replay and preserves stable error classification", async () => {
    const value = setup(); let saved: unknown;
    const handler = createKnowledgeRepairDraftHandler({ freshness: value.freshness, verification: value.verification,
      drafts: value.drafts });
    const first = { ...directContext(value.input), saveCheckpoint: (data: unknown) => { saved = data; return { data } as never; } };
    await handler(first);
    expect(saved).toMatchObject({ phase: "DRAFT_PERSISTED", conflictRunId: "vrun-repair" });
    await expect(handler(directContext(value.input, saved))).resolves.toBeUndefined();
    for (const corrupt of [null, { schemaVersion: 1, phase: "BAD", draftId: "repair_bad", conflictRunId: "vrun-repair" }]) {
      await expect(handler(directContext(value.input, corrupt))).rejects.toMatchObject({ code: "REPAIR_CHECKPOINT_CORRUPT" });
    }
    await expect(handler(directContext({ schemaVersion: 1, jobType: "KNOWLEDGE_COMPILE", sessionId: "session-1",
      sourceRange: { from: 1, to: 1 }, pipelineHash: "a".repeat(64) })))
      .rejects.toMatchObject({ code: "REPAIR_JOB_INPUT_INVALID" });
    await expect(handler(directContext({ ...value.input, assetVersion: 2 })))
      .rejects.toMatchObject({ code: "REPAIR_SOURCE_MISSING" });
    const revisionMismatch = createKnowledgeRepairDraftHandler({ freshness: value.freshness,
      verification: { getRun: () => run({ codeRevision: "git-other" }) }, drafts: value.drafts });
    await expect(revisionMismatch(directContext(value.input))).rejects.toMatchObject({ code: "REPAIR_RUN_REVISION_MISMATCH" });
    await expect(handler({ ...directContext(value.input), throwIfCancellationRequested: () => {
      throw new JobCancellationRequestedError();
    } })).rejects.toBeInstanceOf(JobCancellationRequestedError);
    const mismatch = { ...(saved as Record<string, unknown>), draftId: `repair_${"f".repeat(64)}` };
    await expect(handler(directContext(value.input, mismatch))).rejects.toMatchObject({ code: "REPAIR_CHECKPOINT_DRAFT_MISMATCH" });
    const brokenDrafts = { create: () => { throw new Error("REPAIR_DRAFT_PAYLOAD_INVALID"); },
      get: value.drafts.get.bind(value.drafts), getByConflict: value.drafts.getByConflict.bind(value.drafts),
      list: value.drafts.list.bind(value.drafts), attachCandidate: value.drafts.attachCandidate.bind(value.drafts),
      dismiss: value.drafts.dismiss.bind(value.drafts), fail: value.drafts.fail.bind(value.drafts),
      promote: value.drafts.promote.bind(value.drafts) };
    const broken = createKnowledgeRepairDraftHandler({ freshness: value.freshness, verification: value.verification, drafts: brokenDrafts });
    await expect(broken(directContext(value.input))).rejects.toEqual(expect.objectContaining<Partial<NonRetryableJobError>>({
      code: "REPAIR_INVARIANT_FAILED" }));
    const unavailable = createKnowledgeRepairDraftHandler({ freshness: value.freshness, verification: value.verification,
      drafts: { ...brokenDrafts, create: () => { throw new Error("SQLITE_BUSY"); } } });
    await expect(unavailable(directContext(value.input))).rejects.toMatchObject({ code: "REPAIR_STORE_UNAVAILABLE" });
    value.drafts.close(); value.verification.close(); value.freshness.close();
  });
});
