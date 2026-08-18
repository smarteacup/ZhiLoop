import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  JobIdempotencyConflictError,
  JobLeaseLostError,
  NonRetryableJobError,
  RetryableJobError,
  SqliteDurableJobStore,
  type JobHandler,
} from "@zhiloop/job-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EvolutionJobCapabilityError,
  EvolutionJobRuntime,
  evolutionJobIdempotencyKey,
  evolutionJobInputHash,
  parseEvolutionJobInput,
  type KnowledgeCompileJobInput,
  type KnowledgeRevalidateJobInput,
  type EvolutionJobInput,
} from "./index.js";

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const sha = (character: string): string => character.repeat(64);
const compileInput = (): KnowledgeCompileJobInput => ({
  schemaVersion: 1,
  jobType: "KNOWLEDGE_COMPILE",
  sessionId: "session-1",
  sourceRange: { from: 1, to: 10 },
  pipelineHash: sha("a"),
});
const revalidateInput = (): KnowledgeRevalidateJobInput => ({
  schemaVersion: 1,
  jobType: "KNOWLEDGE_REVALIDATE",
  projectId: "project-1",
  repositoryRoot: "/workspace/project-1",
  sourceRef: "git:head:dirty",
  changeSetHash: sha("b"),
  recipeSelectionHash: sha("c"),
});

function directory(name: string): string {
  const value = mkdtempSync(join(tmpdir(), name));
  directories.push(value);
  return value;
}

function runtime(root: string, handlers: Partial<Record<"KNOWLEDGE_COMPILE" | "KNOWLEDGE_REVALIDATE", JobHandler>>, options: {
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
  readonly maxDelayMs?: number;
} = {}): EvolutionJobRuntime {
  return new EvolutionJobRuntime(join(root, "jobs.sqlite"), {
    workerId: "worker-1",
    handlers,
    leaseMs: 100,
    heartbeatMs: 25,
    store: {
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory }),
      random: () => 0,
      retryPolicy: { baseDelayMs: 10, maxDelayMs: options.maxDelayMs ?? 10, jitterRatio: 0 },
    },
  });
}

describe("Evolution job contracts", () => {
  it("parses strict immutable inputs and creates stable bounded identities", () => {
    const parsed = parseEvolutionJobInput(compileInput());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed.jobType).toBe("KNOWLEDGE_COMPILE");
    if (parsed.jobType !== "KNOWLEDGE_COMPILE") throw new Error("compile input was not preserved");
    expect(Object.isFrozen(parsed.sourceRange)).toBe(true);
    expect(evolutionJobInputHash(parsed)).toMatch(/^[a-f0-9]{64}$/u);
    expect(evolutionJobIdempotencyKey(parsed)).toBe(evolutionJobIdempotencyKey(compileInput()));
    expect(evolutionJobIdempotencyKey(parsed).length).toBeLessThanOrEqual(200);
  });

  it("rejects unknown fields, traversal-like identifiers, invalid roots, ranges, hashes and versions", () => {
    expect(() => parseEvolutionJobInput({ ...compileInput(), prompt: "secret" })).toThrow("FIELDS_INVALID");
    expect(() => parseEvolutionJobInput({ ...compileInput(), sessionId: "../secret" })).toThrow("SESSION_ID_INVALID");
    expect(() => parseEvolutionJobInput({ ...compileInput(), sessionId: ".." })).toThrow("SESSION_ID_INVALID");
    expect(() => parseEvolutionJobInput({ ...compileInput(), sourceRange: { from: 2, to: 1 } })).toThrow("SOURCE_RANGE_INVALID");
    expect(() => parseEvolutionJobInput({ ...revalidateInput(), repositoryRoot: "relative" })).toThrow("REPOSITORY_ROOT_INVALID");
    expect(() => parseEvolutionJobInput({ ...revalidateInput(), changeSetHash: "bad" })).toThrow("CHANGE_SET_HASH_INVALID");
    expect(() => parseEvolutionJobInput({ schemaVersion: 1, jobType: "CODEGRAPH_INITIALIZE", projectId: "p", repositoryRoot: "/repo",
      repositoryIdentity: sha("d"), adapterVersion: "bad version" })).toThrow("ADAPTER_VERSION_INVALID");
  });

  it("validates every durable job shape and rejects malformed scalar boundaries", () => {
    const inputs: readonly EvolutionJobInput[] = [
      revalidateInput(),
      { schemaVersion: 1, jobType: "KNOWLEDGE_REPAIR_DRAFT", projectId: "p", assetId: "asset-1",
        assetVersion: 1, conflictRunId: "conflict-1" },
      { schemaVersion: 1, jobType: "CODEGRAPH_INITIALIZE", projectId: "p", repositoryRoot: "/repo",
        repositoryIdentity: sha("d"), adapterVersion: "0.9.4" },
      { schemaVersion: 1, jobType: "LEGACY_KNOWLEDGE_MIGRATION", migrationVersion: "v1", projectId: "p", pageCursor: "0" },
    ];
    for (const input of inputs) {
      expect(parseEvolutionJobInput(input)).toEqual(input);
      expect(evolutionJobIdempotencyKey(input)).toMatch(new RegExp(`^evolution:${input.jobType.toLowerCase()}:`));
    }

    const invalid: readonly [unknown, string][] = [
      [null, "INPUT_INVALID"],
      [[], "INPUT_INVALID"],
      [{ schemaVersion: 2, jobType: "KNOWLEDGE_COMPILE" }, "INPUT_INVALID"],
      [{ schemaVersion: 1, jobType: "FUTURE_JOB" }, "INPUT_INVALID"],
      [{ ...compileInput(), sessionId: "" }, "SESSION_ID_INVALID"],
      [{ ...compileInput(), sessionId: "a\nsecret" }, "SESSION_ID_INVALID"],
      [{ ...compileInput(), pipelineHash: sha("A") }, "PIPELINE_HASH_INVALID"],
      [{ ...compileInput(), sourceRange: null }, "SOURCE_RANGE_INVALID"],
      [{ ...compileInput(), sourceRange: { from: 0, to: 1 } }, "SOURCE_RANGE_INVALID"],
      [{ ...compileInput(), sourceRange: { from: 1, to: 1, extra: true } }, "FIELDS_INVALID"],
      [{ ...revalidateInput(), repositoryRoot: "/repo/../secret" }, "REPOSITORY_ROOT_INVALID"],
      [{ ...revalidateInput(), sourceRef: "" }, "SOURCE_REF_INVALID"],
      [{ ...revalidateInput(), recipeSelectionHash: "bad" }, "RECIPE_SELECTION_HASH_INVALID"],
      [{ schemaVersion: 1, jobType: "KNOWLEDGE_REPAIR_DRAFT", projectId: "p", assetId: ".",
        assetVersion: 1, conflictRunId: "c" }, "ASSET_ID_INVALID"],
      [{ schemaVersion: 1, jobType: "KNOWLEDGE_REPAIR_DRAFT", projectId: "p", assetId: "a",
        assetVersion: Number.MAX_SAFE_INTEGER + 1, conflictRunId: "c" }, "ASSET_VERSION_INVALID"],
      [{ schemaVersion: 1, jobType: "CODEGRAPH_INITIALIZE", projectId: "p", repositoryRoot: "/repo",
        repositoryIdentity: "bad", adapterVersion: "1" }, "REPOSITORY_IDENTITY_INVALID"],
      [{ schemaVersion: 1, jobType: "LEGACY_KNOWLEDGE_MIGRATION", migrationVersion: "bad version",
        projectId: "p", pageCursor: "0" }, "MIGRATION_VERSION_INVALID"],
      [{ schemaVersion: 1, jobType: "LEGACY_KNOWLEDGE_MIGRATION", migrationVersion: "v1",
        projectId: "p", pageCursor: ".." }, "PAGE_CURSOR_INVALID"],
    ];
    for (const [input, code] of invalid) expect(() => parseEvolutionJobInput(input)).toThrow(code);
  });
});

describe("EvolutionJobRuntime", () => {
  it("deduplicates canonical input and rejects an idempotency fingerprint conflict", () => {
    const root = directory("zhiloop-evolution-jobs-");
    const subject = runtime(root, { KNOWLEDGE_COMPILE: async () => undefined }, { idFactory: () => "job-1" });
    try {
      const first = subject.enqueue(compileInput(), 3);
      const second = subject.enqueue(compileInput(), 3);
      expect(first.status).toBe("CREATED");
      expect(second.status).toBe("EXISTING");
      expect(second.job.snapshot.jobId).toBe(first.job.snapshot.jobId);
      expect(() => subject.enqueue(compileInput(), 4)).toThrow(JobIdempotencyConflictError);
    } finally { subject.close(); }
  });

  it("rejects unregistered future capabilities before persistence", () => {
    const root = directory("zhiloop-evolution-capability-");
    const subject = runtime(root, { KNOWLEDGE_COMPILE: async () => undefined });
    try {
      expect(() => subject.enqueue({ schemaVersion: 1, jobType: "CODEGRAPH_INITIALIZE", projectId: "project-1",
        repositoryRoot: "/workspace/project-1", repositoryIdentity: sha("d"), adapterVersion: "0.9.4" }, 3))
        .toThrow(EvolutionJobCapabilityError);
      expect(subject.list({ limit: 10 }).items).toEqual([]);
      expect(subject.capabilities()).toContainEqual({ jobType: "CODEGRAPH_INITIALIZE", status: "NOT_CONFIGURED",
        reasonCode: "EVOLUTION_JOB_HANDLER_NOT_CONFIGURED" });
    } finally { subject.close(); }
  });

  it("projects every registered job identity without leaking invalid checkpoint data", async () => {
    const root = directory("zhiloop-evolution-all-projections-");
    const inputs: readonly EvolutionJobInput[] = [
      compileInput(),
      revalidateInput(),
      { schemaVersion: 1, jobType: "KNOWLEDGE_REPAIR_DRAFT", projectId: "p", assetId: "asset-1",
        assetVersion: 2, conflictRunId: "conflict-1" },
      { schemaVersion: 1, jobType: "CODEGRAPH_INITIALIZE", projectId: "p", repositoryRoot: "/repo",
        repositoryIdentity: sha("d"), adapterVersion: "0.9.4" },
      { schemaVersion: 1, jobType: "LEGACY_KNOWLEDGE_MIGRATION", migrationVersion: "v1", projectId: "p", pageCursor: "cursor-1" },
    ];
    const handler: JobHandler = async (context) => { context.saveCheckpoint({ phase: "lowercase-is-not-public" }, 0.5); };
    const handlers = Object.fromEntries(inputs.map((input) => [input.jobType, handler]));
    let sequence = 0;
    const subject = new EvolutionJobRuntime(join(root, "jobs.sqlite"), {
      workerId: "worker-1", handlers, leaseMs: 100, heartbeatMs: 25,
      store: { idFactory: () => `job-${++sequence}`, random: () => 0 },
    });
    try {
      const ids = inputs.map((input) => subject.enqueue(input, 2).job.snapshot.jobId);
      for (let index = 0; index < ids.length; index += 1) await subject.runOnce();
      expect(ids.map((id) => subject.get(id)?.entityRef)).toEqual([
        "session:session-1:1-10", "git:head:dirty", "asset-1@2", sha("d"), "v1:cursor-1",
      ]);
      expect(ids.map((id) => subject.get(id)?.checkpointPhase)).toEqual([undefined, undefined, undefined, undefined, undefined]);
      expect(subject.get("missing")).toBeUndefined();
    } finally { subject.close(); }
  });

  it("runs a registered handler and exposes only bounded operational projection data", async () => {
    const root = directory("zhiloop-evolution-projection-");
    const handler = vi.fn<JobHandler>(async (context) => { context.saveCheckpoint({ phase: "VERIFY_PAGE", privateBody: "must-not-project" }, 0.5); });
    const subject = runtime(root, { KNOWLEDGE_REVALIDATE: handler }, { idFactory: () => "job-1" });
    try {
      const created = subject.enqueue(revalidateInput(), 3);
      await expect(subject.runOnce()).resolves.toMatchObject({ status: "SUCCEEDED" });
      const projected = subject.get(created.job.snapshot.jobId);
      expect(projected).toMatchObject({ jobType: "KNOWLEDGE_REVALIDATE", status: "SUCCEEDED", progress: 1,
        attempt: 1, maxAttempts: 3, projectId: "project-1", sourceRef: "git:head:dirty", checkpointPhase: "VERIFY_PAGE" });
      expect(JSON.stringify(projected)).not.toContain("must-not-project");
      expect(subject.list({ limit: 1 }).items).toEqual([projected]);
      expect(subject.attempts(created.job.snapshot.jobId)).toHaveLength(1);
    } finally { subject.close(); }
  });

  it("persists jobs across restart and closes idempotently", async () => {
    const root = directory("zhiloop-evolution-restart-");
    const first = runtime(root, { KNOWLEDGE_COMPILE: async () => undefined }, { idFactory: () => "job-1" });
    const jobId = first.enqueue(compileInput(), 2).job.snapshot.jobId;
    first.close();
    first.close();
    expect(first.capabilities()).toEqual(expect.arrayContaining([expect.objectContaining({ status: "DEGRADED",
      reasonCode: "EVOLUTION_JOB_RUNTIME_CLOSED" })]));
    expect(() => first.get(jobId)).toThrow("RUNTIME_CLOSED");
    const second = runtime(root, { KNOWLEDGE_COMPILE: async () => undefined });
    try {
      expect(second.get(jobId)).toMatchObject({ jobId, status: "QUEUED" });
      await expect(second.runOnce()).resolves.toMatchObject({ status: "SUCCEEDED" });
    } finally { second.close(); }
  });

  it("records retry wait, exhaustion, non-retryable failure and revision-bound cancellation", async () => {
    const root = directory("zhiloop-evolution-failure-");
    let now = Date.parse("2026-08-19T00:00:00.000Z");
    const retrying = runtime(root, { KNOWLEDGE_COMPILE: async () => { throw new RetryableJobError("TEMPORARY_FAILURE"); } },
      { clock: () => new Date(now), idFactory: () => "job-retry" });
    const retryId = retrying.enqueue(compileInput(), 2).job.snapshot.jobId;
    await expect(retrying.runOnce()).resolves.toMatchObject({ status: "RETRY_WAIT" });
    expect(retrying.get(retryId)).toMatchObject({ status: "RETRY_WAIT", attempt: 1, nextAttemptAt: "2026-08-19T00:00:00.010Z" });
    now += 10;
    await expect(retrying.runOnce()).resolves.toMatchObject({ status: "FAILED" });
    expect(retrying.get(retryId)).toMatchObject({ status: "FAILED", attempt: 2,
      lastFailure: { code: "TEMPORARY_FAILURE", retryable: true } });
    retrying.close();

    const terminalRoot = directory("zhiloop-evolution-terminal-");
    const terminal = runtime(terminalRoot, { KNOWLEDGE_COMPILE: async () => { throw new NonRetryableJobError("INVALID_INPUT"); } },
      { idFactory: () => "job-terminal" });
    await terminal.runOnce(); // empty is harmless
    const terminalId = terminal.enqueue(compileInput(), 3).job.snapshot.jobId;
    await expect(terminal.runOnce()).resolves.toMatchObject({ status: "FAILED" });
    expect(terminal.get(terminalId)).toMatchObject({ status: "FAILED", attempt: 1, lastFailure: { code: "INVALID_INPUT", retryable: false } });
    terminal.close();

    const cancelRoot = directory("zhiloop-evolution-cancel-");
    const cancel = runtime(cancelRoot, { KNOWLEDGE_COMPILE: async () => undefined }, { idFactory: () => "job-cancel" });
    const queued = cancel.enqueue(compileInput(), 3).job.snapshot;
    expect(cancel.cancel({ jobId: queued.jobId, expectedRevision: queued.revision ?? 0, idempotencyKey: "cancel-job-cancel-0001" }))
      .toMatchObject({ disposition: "APPLIED", job: { status: "CANCELLED" } });
    cancel.close();
  });

  it("lets a later claim fence an expired attempt and rejects the stale reference", () => {
    const root = directory("zhiloop-evolution-fencing-");
    let now = Date.parse("2026-08-19T00:00:00.000Z");
    const filename = join(root, "jobs.sqlite");
    const store = new SqliteDurableJobStore(filename, { clock: () => new Date(now), defaultLeaseMs: 100,
      idFactory: () => "job-1", retryPolicy: { baseDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 } });
    try {
      store.enqueue({ jobType: "KNOWLEDGE_COMPILE", idempotencyKey: evolutionJobIdempotencyKey(compileInput()), input: compileInput(), maxAttempts: 3 });
      const first = store.claimNext("worker-1", 100);
      expect(first.status).toBe("ACQUIRED");
      if (first.status !== "ACQUIRED") throw new Error("first claim missing");
      now += 101;
      const second = store.claimNext("worker-2", 100);
      expect(second.status).toBe("ACQUIRED");
      if (second.status !== "ACQUIRED") throw new Error("second claim missing");
      expect(second.claim.fencingToken).toBeGreaterThan(first.claim.fencingToken);
      expect(() => store.saveCheckpoint(first.claim, { phase: "STALE" }, 0.5)).toThrow(JobLeaseLostError);
      store.saveCheckpoint(second.claim, { phase: "CURRENT" }, 0.5);
    } finally { store.close(); }
  });

  it("validates list bounds and rejects corrupt persisted JSON on restart", () => {
    const root = directory("zhiloop-evolution-corruption-");
    const filename = join(root, "jobs.sqlite");
    const subject = runtime(root, { KNOWLEDGE_COMPILE: async () => undefined }, { idFactory: () => "job-1" });
    const jobId = subject.enqueue(compileInput(), 3).job.snapshot.jobId;
    expect(() => subject.list({ limit: 0 })).toThrow("between 1 and 1000");
    subject.close();
    const store = new SqliteDurableJobStore(filename);
    store.close();
    const database = new DatabaseSync(filename);
    database.prepare("UPDATE durable_jobs SET input_json = ? WHERE job_id = ?").run("{}", jobId);
    database.close();
    const reopened = runtime(root, { KNOWLEDGE_COMPILE: async () => undefined });
    try { expect(() => reopened.get(jobId)).toThrow("integrity verification"); }
    finally { reopened.close(); }
  });

  it("rejects unknown handler names before opening a database", () => {
    const root = directory("zhiloop-evolution-unknown-handler-");
    expect(() => new EvolutionJobRuntime(join(root, "jobs.sqlite"), {
      workerId: "worker-1", handlers: { FUTURE_JOB: async () => undefined } as never,
    })).toThrow("HANDLER_TYPE_INVALID");
  });

  it("closes the opened store when worker option validation fails", () => {
    const root = directory("zhiloop-evolution-constructor-");
    const filename = join(root, "jobs.sqlite");
    expect(() => new EvolutionJobRuntime(filename, {
      workerId: "worker-1", handlers: { KNOWLEDGE_COMPILE: async () => undefined }, leaseMs: 100, heartbeatMs: 100,
    })).toThrow("heartbeatMs");
    expect(() => rmSync(filename)).not.toThrow();
  });
});
