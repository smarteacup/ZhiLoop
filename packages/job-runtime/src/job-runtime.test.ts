import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  DurableJobWorker,
  JobIdempotencyConflictError,
  JobLeaseLostError,
  JobStaleRevisionError,
  JobStateConflictError,
  MAX_JOB_JSON_BYTES,
  NonRetryableJobError,
  RetryableJobError,
  SqliteDurableJobStore,
  jobEffectKey,
  parseStoredJobJson,
  serializeJobJson,
} from "./index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

async function fixture(options: { readonly leaseMs?: number; readonly retryBaseMs?: number; readonly random?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "zhiloop-job-runtime-"));
  directories.push(directory);
  const database = join(directory, "jobs.sqlite");
  let time = Date.parse("2026-08-03T12:00:00.000Z");
  let nextId = 0;
  const clock = () => new Date(time);
  const create = () => new SqliteDurableJobStore(database, {
    clock,
    idFactory: () => `job-${++nextId}`,
    random: () => options.random ?? 0.5,
    defaultLeaseMs: options.leaseMs ?? 100,
    retryPolicy: { baseDelayMs: options.retryBaseMs ?? 100, maxDelayMs: 1_000, jitterRatio: 0.2 },
  });
  return {
    database,
    clock,
    create,
    advance(milliseconds: number) { time += milliseconds; },
  };
}

function enqueue(store: SqliteDurableJobStore, suffix = "one", maxAttempts = 3) {
  return store.enqueue({
    jobType: "BACKFILL",
    idempotencyKey: `backfill:session:${suffix}:revision:1`,
    input: { sessionId: `session-${suffix}`, range: { from: 0, to: 10 } },
    maxAttempts,
  });
}

describe("durable job identity and persistence", () => {
  it("migrates a version 2 queue to prioritized claims without losing queued work", async () => {
    const test = await fixture();
    const store = test.create();
    const existing = enqueue(store, "migration-v2").job.snapshot;
    store.close();

    const legacy = new DatabaseSync(test.database);
    legacy.exec(`
      DROP INDEX durable_jobs_claim_idx;
      ALTER TABLE durable_jobs DROP COLUMN priority;
      CREATE INDEX durable_jobs_claim_idx
        ON durable_jobs(status, next_attempt_at_ms, lease_expires_at_ms, created_at_ms, job_id);
      UPDATE durable_job_meta SET version=2 WHERE component='job-runtime';
    `);
    legacy.close();

    const migrated = test.create();
    expect(migrated.get(existing.jobId)).toMatchObject({ snapshot: { jobId: existing.jobId, status: "QUEUED" } });
    const database = new DatabaseSync(test.database);
    const meta = database.prepare("SELECT version FROM durable_job_meta WHERE component='job-runtime'").get() as { version: number };
    const index = database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='durable_jobs_claim_idx'").get() as { sql: string };
    database.close();
    expect(meta.version).toBe(3);
    expect(index.sql).toContain("priority DESC");
    expect(migrated.claimNext("worker", 100)).toMatchObject({ status: "ACQUIRED", claim: { jobId: existing.jobId } });
    migrated.close();
  });

  it("claims interactive work ahead of normal and background backlog", async () => {
    const test = await fixture();
    const store = test.create();
    const background = store.enqueue({ jobType: "BACKFILL", idempotencyKey: "priority:background",
      input: { id: "background" }, maxAttempts: 3, priority: "BACKGROUND" }).job.snapshot;
    test.advance(1);
    const normal = enqueue(store, "normal").job.snapshot;
    test.advance(1);
    const interactive = store.enqueue({ jobType: "BACKFILL", idempotencyKey: "priority:interactive",
      input: { id: "interactive" }, maxAttempts: 3, priority: "INTERACTIVE" }).job.snapshot;

    const order = [interactive.jobId, normal.jobId, background.jobId];
    for (const jobId of order) {
      const claimed = store.claimNext("worker", 100);
      expect(claimed).toMatchObject({ status: "ACQUIRED", claim: { jobId } });
      if (claimed.status === "ACQUIRED") store.succeed(claimed.claim);
    }
    store.close();
  });

  it("promotes an existing background job when an interactive caller requests the same work", async () => {
    const test = await fixture();
    const store = test.create();
    store.enqueue({ jobType: "BACKFILL", idempotencyKey: "priority:promote",
      input: { id: "same" }, maxAttempts: 3, priority: "BACKGROUND" });
    const normal = enqueue(store, "normal-after-background").job.snapshot;
    expect(store.enqueue({ jobType: "BACKFILL", idempotencyKey: "priority:promote",
      input: { id: "same" }, maxAttempts: 3, priority: "INTERACTIVE" })).toMatchObject({ status: "EXISTING" });
    const claimed = store.claimNext("worker", 100);
    expect(claimed).toMatchObject({ status: "ACQUIRED" });
    if (claimed.status !== "ACQUIRED") throw new Error("expected promoted claim");
    expect(claimed.claim.jobId).not.toBe(normal.jobId);
    store.close();
  });

  it("returns the original durable job for a semantic duplicate and rejects a conflicting key", async () => {
    const test = await fixture();
    const store = test.create();
    const first = store.enqueue({
      jobType: "BACKFILL",
      idempotencyKey: "backfill:session:stable:revision:1",
      input: { a: 1, b: 2 },
      maxAttempts: 3,
    });
    const duplicate = store.enqueue({
      jobType: "BACKFILL",
      idempotencyKey: "backfill:session:stable:revision:1",
      input: { b: 2, a: 1 },
      maxAttempts: 3,
    });
    expect(first.status).toBe("CREATED");
    expect(store.getByIdempotencyKey("backfill:session:stable:revision:1")?.snapshot.jobId).toBe(first.job.snapshot.jobId);
    expect(duplicate).toMatchObject({ status: "EXISTING", job: { snapshot: { jobId: first.job.snapshot.jobId } } });
    expect(() => store.enqueue({
      jobType: "BACKFILL",
      idempotencyKey: "backfill:session:stable:revision:1",
      input: { a: 2, b: 1 },
      maxAttempts: 3,
    })).toThrow(JobIdempotencyConflictError);
    store.close();
    if (process.platform !== "win32") expect((await stat(test.database)).mode & 0o777).toBe(0o600);
  });

  it("preserves the idempotency reservation across process restart", async () => {
    const test = await fixture();
    let store = test.create();
    const first = enqueue(store, "restart-idempotency");
    store.close();
    store = test.create();
    expect(enqueue(store, "restart-idempotency")).toMatchObject({
      status: "EXISTING",
      job: { snapshot: { jobId: first.job.snapshot.jobId, status: "QUEUED" } },
    });
    store.close();
  });

  it("rebuilds projections with bounded stable pages and optional status filtering after restart", async () => {
    const test = await fixture();
    let store = test.create();
    enqueue(store, "list-one");
    enqueue(store, "list-two");
    enqueue(store, "list-three");
    const firstPage = store.list({ limit: 2 });
    expect(firstPage.items.map(({ jobId }) => jobId)).toEqual(["job-1", "job-2"]);
    expect(firstPage.items[0]).not.toHaveProperty("input");
    expect(firstPage.next).toEqual({ createdAt: "2026-08-03T12:00:00.000Z", jobId: "job-2" });
    store.close();

    store = test.create();
    const secondPage = store.list({ limit: 2, ...(firstPage.next === undefined ? {} : { after: firstPage.next }) });
    expect(secondPage.items.map(({ jobId }) => jobId)).toEqual(["job-3"]);
    expect(secondPage.next).toBeUndefined();
    const claim = store.claimNext("worker", 100);
    if (claim.status !== "ACQUIRED") throw new Error("expected claim");
    store.succeed(claim.claim);
    expect(store.list({ limit: 10, statuses: ["QUEUED"] }).items.map(({ jobId }) => jobId)).toEqual(["job-2", "job-3"]);
    expect(() => store.list({ limit: 0 })).toThrow("limit");
    expect(() => store.list({ limit: 1, after: { createdAt: "invalid", jobId: "job-1" } })).toThrow("createdAt");
    store.close();

    const database = new DatabaseSync(test.database, { readOnly: true });
    expect(database.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    database.close();
  });

  it("rejects unbounded policy and non-JSON or oversized scheduling inputs", async () => {
    const test = await fixture();
    expect(() => new SqliteDurableJobStore(test.database, { defaultLeaseMs: 0 })).toThrow("leaseMs");
    expect(() => new SqliteDurableJobStore(test.database, { retryPolicy: { baseDelayMs: 0 } })).toThrow("baseDelayMs");
    const store = test.create();
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => store.enqueue({
      jobType: "BACKFILL",
      idempotencyKey: "backfill:session:cyclic:revision:1",
      input: cyclic,
      maxAttempts: 3,
    })).toThrow("cyclic");
    expect(() => enqueue(store, "attempts", 1_001)).toThrow("maxAttempts");
    store.close();
  });

  it("canonicalizes supported JSON and rejects unsafe values, depth, size and integrity mismatches", () => {
    const serialized = serializeJobJson({ values: [null, true, "ok", 2], nested: Object.create(null) as object });
    expect(serialized.json).toBe('{"nested":{},"values":[null,true,"ok",2]}');
    expect(parseStoredJobJson(serialized.json, serialized.hash)).toEqual({ nested: {}, values: [null, true, "ok", 2] });
    expect(() => parseStoredJobJson(serialized.json, "0".repeat(64))).toThrow("integrity");
    expect(() => serializeJobJson(Number.POSITIVE_INFINITY)).toThrow("non-finite");
    expect(() => serializeJobJson(undefined)).toThrow("non-JSON");
    expect(() => serializeJobJson(new Date())).toThrow("non-JSON object");
    let deep: unknown = null;
    for (let index = 0; index < 66; index += 1) deep = [deep];
    expect(() => serializeJobJson(deep)).toThrow("depth limit");
    expect(() => serializeJobJson("x".repeat(MAX_JOB_JSON_BYTES))).toThrow("byte limit");
    expect(() => jobEffectKey("stable", "")).toThrow("step is invalid");
  });

  it("validates identifiers, policy sources and closed-store access", async () => {
    const test = await fixture();
    expect(() => new SqliteDurableJobStore(test.database, {
      retryPolicy: { baseDelayMs: 100, maxDelayMs: 99 },
    })).toThrow("maxDelayMs");
    expect(() => new SqliteDurableJobStore(test.database, {
      retryPolicy: { jitterRatio: 2 },
    })).toThrow("jitterRatio");
    const store = test.create();
    expect(() => store.enqueue({ jobType: "bad", idempotencyKey: "valid:key", input: {}, maxAttempts: 1 })).toThrow("jobType");
    expect(() => store.enqueue({ jobType: "BACKFILL", idempotencyKey: "", input: {}, maxAttempts: 1 })).toThrow("idempotencyKey");
    expect(store.get("missing")).toBeUndefined();
    expect(() => store.claimNext("bad\nworker", 100)).toThrow("workerId");
    store.close();
    store.close();
    expect(() => store.get("job-1")).toThrow("closed");
  });
});

describe("lease fencing, heartbeat and restart recovery", () => {
  it("prevents duplicate claims, takes over an expired lease, and fences the stale worker", async () => {
    const test = await fixture({ leaseMs: 100 });
    const firstStore = test.create();
    const secondStore = test.create();
    enqueue(firstStore);
    const first = firstStore.claimNext("worker-a", 100);
    expect(first.status).toBe("ACQUIRED");
    expect(secondStore.claimNext("worker-b", 100)).toEqual({ status: "EMPTY" });
    test.advance(100);
    const takeover = secondStore.claimNext("worker-b", 100);
    expect(takeover).toMatchObject({ status: "ACQUIRED", claim: { fencingToken: 2, snapshot: { attempt: 2 } } });
    if (first.status !== "ACQUIRED") throw new Error("expected first claim");
    expect(() => firstStore.heartbeat(first.claim, 100)).toThrow(JobLeaseLostError);
    expect(() => firstStore.saveCheckpoint(first.claim, { stale: true }, 0.2)).toThrow(JobLeaseLostError);
    expect(() => firstStore.succeed(first.claim)).toThrow(JobLeaseLostError);
    expect(secondStore.listAttempts(first.claim.jobId).items.map(({ status }) => status)).toEqual(["LEASE_LOST", "RUNNING"]);
    firstStore.close();
    secondStore.close();
  });

  it("extends an active lease with heartbeat before another worker can recover it", async () => {
    const test = await fixture({ leaseMs: 100 });
    const store = test.create();
    const peer = test.create();
    enqueue(store);
    const claim = store.claimNext("worker-a", 100);
    if (claim.status !== "ACQUIRED") throw new Error("expected claim");
    test.advance(80);
    expect(store.heartbeat(claim.claim, 100).leaseExpiresAt).toBe("2026-08-03T12:00:00.180Z");
    test.advance(30);
    expect(peer.claimNext("worker-b", 100)).toEqual({ status: "EMPTY" });
    test.advance(71);
    expect(peer.claimNext("worker-b", 100)).toMatchObject({ status: "ACQUIRED", claim: { fencingToken: 2 } });
    store.close();
    peer.close();
  });

  it("resumes the latest integrity-checked checkpoint after process restart", async () => {
    const test = await fixture({ leaseMs: 100 });
    let store = test.create();
    enqueue(store, "checkpoint");
    const first = store.claimNext("worker-a", 100);
    if (first.status !== "ACQUIRED") throw new Error("expected first claim");
    expect(store.saveCheckpoint(first.claim, { byteOffset: 42 }, 0.4)).toMatchObject({ revision: 1, progress: 0.4 });
    expect(store.saveCheckpoint(first.claim, { byteOffset: 84 }, 0.8)).toMatchObject({ revision: 2, progress: 0.8 });
    expect(store.get(first.claim.jobId)?.snapshot.revision).toBe(3);
    store.close();

    test.advance(100);
    store = test.create();
    const recovered = store.claimNext("worker-restart", 100);
    expect(recovered).toMatchObject({
      status: "ACQUIRED",
      claim: { fencingToken: 2, checkpoint: { revision: 2, progress: 0.8, data: { byteOffset: 84 } } },
    });
    store.close();
  });
});

describe("retry and side-effect idempotency", () => {
  it("applies revision-bound idempotent cancellation at queued and running safe boundaries", async () => {
    const test = await fixture();
    const store = test.create();
    const queued = enqueue(store, "operator-cancel").job.snapshot;
    expect(queued.revision).toBe(0);
    const command = { jobId: queued.jobId, expectedRevision: 0, idempotencyKey: "operator:cancel:job:one" };
    expect(store.cancel(command)).toMatchObject({
      action: "CANCEL", disposition: "APPLIED", job: { status: "CANCELLED", revision: 1 },
    });
    expect(store.cancel(command)).toMatchObject({
      action: "CANCEL", disposition: "REPLAYED", job: { status: "CANCELLED", revision: 1 },
    });
    expect(() => store.cancel({ ...command, idempotencyKey: "operator:cancel:job:two" })).toThrow(JobStaleRevisionError);
    expect(() => store.cancel({ ...command, expectedRevision: 1 })).toThrow(JobIdempotencyConflictError);

    const runningJob = enqueue(store, "operator-running").job.snapshot;
    const claim = store.claimNext("worker", 100);
    if (claim.status !== "ACQUIRED" || claim.claim.jobId !== runningJob.jobId) throw new Error("expected running job claim");
    expect(store.cancel({
      jobId: runningJob.jobId,
      expectedRevision: claim.claim.snapshot.revision as number,
      idempotencyKey: "operator:cancel:running:one",
    })).toMatchObject({ disposition: "APPLIED", job: { status: "RUNNING", revision: 2, cancellation: { status: "REQUESTED" } } });
    expect(store.acknowledgeCancellation(claim.claim).snapshot).toMatchObject({ status: "CANCELLED", revision: 3 });
    store.close();
  });

  it("requeues the same retryable failed job once without changing its stable effect identity", async () => {
    const test = await fixture();
    const store = test.create();
    enqueue(store, "operator-retry", 1);
    const first = store.claimNext("worker", 100);
    if (first.status !== "ACQUIRED") throw new Error("expected first claim");
    const effectKey = jobEffectKey(first.claim.idempotencyKey, "capture");
    const failed = store.fail(first.claim, { code: "SOURCE_UNAVAILABLE", retryable: true }).snapshot;
    expect(failed).toMatchObject({ status: "FAILED", revision: 2, attempt: 1, maxAttempts: 1 });
    const command = {
      jobId: failed.jobId,
      expectedRevision: failed.revision as number,
      idempotencyKey: "operator:retry:failed:one",
    };
    expect(store.manualRetry(command)).toMatchObject({
      action: "RETRY", disposition: "APPLIED", job: { status: "QUEUED", revision: 3, attempt: 1, maxAttempts: 2 },
    });
    expect(store.manualRetry(command).disposition).toBe("REPLAYED");
    const second = store.claimNext("worker", 100);
    if (second.status !== "ACQUIRED") throw new Error("expected second claim");
    expect(second.claim.snapshot).toMatchObject({ attempt: 2, revision: 4 });
    expect(jobEffectKey(second.claim.idempotencyKey, "capture")).toBe(effectKey);
    store.close();
  });

  it("rejects retry for successful, cancelled, and non-retryable terminal jobs", async () => {
    const test = await fixture();
    const store = test.create();
    enqueue(store, "operator-nonretryable", 2);
    const claim = store.claimNext("worker", 100);
    if (claim.status !== "ACQUIRED") throw new Error("expected claim");
    const failed = store.fail(claim.claim, { code: "INVALID_INPUT", retryable: false }).snapshot;
    expect(() => store.manualRetry({
      jobId: failed.jobId,
      expectedRevision: failed.revision as number,
      idempotencyKey: "operator:retry:rejected:one",
    })).toThrow(JobStateConflictError);

    const cancelled = enqueue(store, "operator-cancelled").job.snapshot;
    const cancelledResult = store.cancel({
      jobId: cancelled.jobId,
      expectedRevision: cancelled.revision as number,
      idempotencyKey: "operator:cancel:before:retry",
    }).job;
    expect(() => store.manualRetry({
      jobId: cancelledResult.jobId,
      expectedRevision: cancelledResult.revision as number,
      idempotencyKey: "operator:retry:cancelled:one",
    })).toThrow(JobStateConflictError);

    enqueue(store, "operator-succeeded");
    const successClaim = store.claimNext("worker", 100);
    if (successClaim.status !== "ACQUIRED") throw new Error("expected successful claim");
    const succeeded = store.succeed(successClaim.claim).snapshot;
    expect(() => store.manualRetry({
      jobId: succeeded.jobId,
      expectedRevision: succeeded.revision as number,
      idempotencyKey: "operator:retry:succeeded:one",
    })).toThrow(JobStateConflictError);
    store.close();
  });

  it("uses bounded exponential backoff and becomes terminal after max attempts", async () => {
    const test = await fixture({ retryBaseMs: 100 });
    const store = test.create();
    enqueue(store, "retry", 3);
    const first = store.claimNext("worker", 100);
    if (first.status !== "ACQUIRED") throw new Error("expected first claim");
    expect(store.fail(first.claim, { code: "SOURCE_UNAVAILABLE", retryable: true }).snapshot)
      .toMatchObject({ status: "RETRY_WAIT", nextAttemptAt: "2026-08-03T12:00:00.100Z" });
    test.advance(99);
    expect(store.claimNext("worker", 100)).toEqual({ status: "EMPTY" });
    test.advance(1);
    const second = store.claimNext("worker", 100);
    if (second.status !== "ACQUIRED") throw new Error("expected second claim");
    expect(store.fail(second.claim, { code: "SOURCE_UNAVAILABLE", retryable: true }).snapshot)
      .toMatchObject({ status: "RETRY_WAIT", nextAttemptAt: "2026-08-03T12:00:00.300Z" });
    test.advance(200);
    const third = store.claimNext("worker", 100);
    if (third.status !== "ACQUIRED") throw new Error("expected third claim");
    expect(store.fail(third.claim, { code: "SOURCE_UNAVAILABLE", retryable: true }).snapshot)
      .toMatchObject({ status: "FAILED", reasonCode: "JOB_MAX_ATTEMPTS_EXHAUSTED", attempt: 3 });
    expect(store.claimNext("worker", 100)).toEqual({ status: "EMPTY" });
    store.close();
  });

  it("orders eligible queued and retry jobs by ready time so one failure cannot starve the queue", async () => {
    const test = await fixture({ retryBaseMs: 100 });
    const store = test.create();
    enqueue(store, "failing");
    const failing = store.claimNext("worker", 100);
    if (failing.status !== "ACQUIRED") throw new Error("expected failing claim");
    store.fail(failing.claim, { code: "SOURCE_UNAVAILABLE", retryable: true });

    test.advance(50);
    const queued = enqueue(store, "queued").job.snapshot;
    test.advance(50);

    const fair = store.claimNext("worker", 100);
    expect(fair).toMatchObject({ status: "ACQUIRED", claim: { jobId: queued.jobId } });
    if (fair.status !== "ACQUIRED") throw new Error("expected queued claim");
    store.succeed(fair.claim);
    expect(store.claimNext("worker", 100)).toMatchObject({
      status: "ACQUIRED",
      claim: { jobId: failing.claim.jobId },
    });
    store.close();
  });

  it("applies deterministic bounded jitter to the retry deadline", async () => {
    const test = await fixture({ retryBaseMs: 100, random: 0 });
    const store = test.create();
    enqueue(store, "jitter");
    const claim = store.claimNext("worker", 100);
    if (claim.status !== "ACQUIRED") throw new Error("expected claim");
    expect(store.fail(claim.claim, { code: "SOURCE_UNAVAILABLE", retryable: true }).snapshot.nextAttemptAt)
      .toBe("2026-08-03T12:00:00.080Z");
    store.close();
  });

  it("rejects malformed failures and random sources outside the bounded range", async () => {
    const test = await fixture({ random: 2 });
    const store = test.create();
    enqueue(store, "bad-random");
    const claim = store.claimNext("worker", 100);
    if (claim.status !== "ACQUIRED") throw new Error("expected claim");
    expect(() => store.fail(claim.claim, { code: "bad-code", retryable: true })).toThrow("failure code");
    expect(() => store.fail(claim.claim, { code: "SOURCE_UNAVAILABLE", retryable: true })).toThrow("random source");
    store.close();
  });

  it("provides a stable effect key so restart after a side effect does not duplicate an idempotent sink", async () => {
    const test = await fixture({ leaseMs: 100 });
    const effects = new Map<string, number>();
    const apply = (key: string) => effects.set(key, (effects.get(key) ?? 0) + (effects.has(key) ? 0 : 1));
    let store = test.create();
    const queued = enqueue(store, "effect");
    const first = store.claimNext("worker-crash", 100);
    if (first.status !== "ACQUIRED") throw new Error("expected first claim");
    const firstEffectKey = jobEffectKey(first.claim.idempotencyKey, "append-ledger-batch");
    apply(firstEffectKey);
    store.close(); // Simulated crash after the downstream effect and before local settlement.

    test.advance(100);
    store = test.create();
    const recovered = store.claimNext("worker-restart", 100);
    if (recovered.status !== "ACQUIRED") throw new Error("expected recovered claim");
    const recoveredEffectKey = jobEffectKey(recovered.claim.idempotencyKey, "append-ledger-batch");
    apply(recoveredEffectKey);
    expect(recoveredEffectKey).toBe(firstEffectKey);
    expect(effects.get(firstEffectKey)).toBe(1);
    expect(store.succeed(recovered.claim).snapshot).toMatchObject({ jobId: queued.job.snapshot.jobId, status: "SUCCEEDED" });
    store.close();
  });
});

describe("worker classification and cancellation boundaries", () => {
  it("validates timing, stays idle without work, and fails work without a registered handler", async () => {
    const test = await fixture();
    const store = test.create();
    expect(() => new DurableJobWorker(store, {}, { workerId: "worker", leaseMs: 9 })).toThrow("leaseMs");
    expect(() => new DurableJobWorker(store, {}, { workerId: "worker", leaseMs: 100, heartbeatMs: 100 })).toThrow("heartbeatMs");
    const worker = new DurableJobWorker(store, {}, { workerId: "worker", leaseMs: 100, heartbeatMs: 20 });
    await expect(worker.runOnce()).resolves.toEqual({ status: "IDLE" });
    const aborted = new AbortController();
    aborted.abort();
    await expect(worker.runOnce(aborted.signal)).resolves.toEqual({ status: "IDLE" });
    enqueue(store, "missing-handler");
    await expect(worker.runOnce()).resolves.toMatchObject({ status: "FAILED", job: { snapshot: { reasonCode: "JOB_NON_RETRYABLE_FAILURE" } } });
    store.close();
  });

  it("exposes bounded execution helpers and rejects invalid error codes", async () => {
    const test = await fixture();
    const store = test.create();
    enqueue(store, "context");
    const worker = new DurableJobWorker(store, {
      BACKFILL: async (context) => {
        expect(context.getCheckpoint()).toBeUndefined();
        expect(context.isCancellationRequested()).toBe(false);
        expect(context.heartbeat()).toMatchObject({ cancellationRequested: false });
        expect(context.effectKey("write")).toBe(jobEffectKey(context.idempotencyKey, "write"));
        throw new NonRetryableJobError("bad code");
      },
    }, { workerId: "worker", leaseMs: 100, heartbeatMs: 20 });
    await expect(worker.runOnce()).resolves.toMatchObject({
      status: "FAILED",
      job: { snapshot: { lastFailure: { code: "JOB_NON_RETRYABLE_FAILURE", retryable: false } } },
    });
    store.close();
  });

  it("persists non-retryable failures without scheduling another attempt", async () => {
    const test = await fixture();
    const store = test.create();
    enqueue(store, "schema");
    const worker = new DurableJobWorker(store, {
      BACKFILL: async () => { throw new NonRetryableJobError("SCHEMA_INVALID"); },
    }, { workerId: "worker", leaseMs: 100, heartbeatMs: 20 });
    await expect(worker.runOnce()).resolves.toMatchObject({ status: "FAILED", job: { snapshot: { attempt: 1 } } });
    expect(store.claimNext("worker", 100)).toEqual({ status: "EMPTY" });
    expect(store.listAttempts("job-1").items[0]).toMatchObject({
      status: "TERMINAL_FAILED",
      failure: { code: "SCHEMA_INVALID", retryable: false },
    });
    store.close();
  });

  it("lets a running handler acknowledge cancellation only at its explicit safe boundary", async () => {
    const test = await fixture();
    const store = test.create();
    enqueue(store, "cancel-running");
    const worker = new DurableJobWorker(store, {
      BACKFILL: async (context) => {
        expect(store.requestCancellation(context.jobId).status).toBe("REQUESTED");
        context.saveCheckpoint({ safeOffset: 0 }, 0);
        context.throwIfCancellationRequested();
      },
    }, { workerId: "worker", leaseMs: 100, heartbeatMs: 20 });
    const result = await worker.runOnce();
    expect(result).toMatchObject({
      status: "CANCELLED",
      job: { snapshot: { status: "CANCELLED", cancellation: { status: "ACKNOWLEDGED" } } },
    });
    store.close();
  });

  it("propagates a requested cancellation through the handler signal at a heartbeat boundary", async () => {
    const test = await fixture();
    const store = test.create();
    const queued = enqueue(store, "cancel-signal");
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const worker = new DurableJobWorker(store, {
      BACKFILL: async (context) => {
        started();
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
        });
      },
    }, { workerId: "worker", leaseMs: 100, heartbeatMs: 20 });

    const running = worker.runOnce();
    await didStart;
    expect(store.requestCancellation(queued.job.snapshot.jobId).status).toBe("REQUESTED");
    await expect(running).resolves.toMatchObject({
      status: "CANCELLED",
      job: { snapshot: { status: "CANCELLED", cancellation: { status: "ACKNOWLEDGED" } } },
    });
    store.close();
  });

  it("cancels waiting work immediately but rejects a late running cancellation after success", async () => {
    const test = await fixture();
    const store = test.create();
    const waiting = enqueue(store, "cancel-waiting");
    expect(store.requestCancellation(waiting.job.snapshot.jobId)).toMatchObject({
      status: "CANCELLED",
      job: { snapshot: { status: "CANCELLED", attempt: 0 } },
    });

    const running = enqueue(store, "cancel-late");
    const claim = store.claimNext("worker", 100);
    if (claim.status !== "ACQUIRED") throw new Error("expected claim");
    expect(claim.claim.jobId).toBe(running.job.snapshot.jobId);
    expect(store.requestCancellation(claim.claim.jobId).status).toBe("REQUESTED");
    expect(store.succeed(claim.claim).snapshot).toMatchObject({
      status: "SUCCEEDED",
      cancellation: { status: "REJECTED" },
    });
    expect(store.requestCancellation(claim.claim.jobId).status).toBe("ALREADY_TERMINAL");
    store.close();
  });

  it("supports repeated and explicitly rejected running cancellation", async () => {
    const test = await fixture();
    const store = test.create();
    enqueue(store, "reject-cancel");
    const claim = store.claimNext("worker", 100);
    if (claim.status !== "ACQUIRED") throw new Error("expected claim");
    expect(() => store.acknowledgeCancellation(claim.claim)).toThrow("not requested");
    expect(store.requestCancellation(claim.claim.jobId).status).toBe("REQUESTED");
    expect(store.requestCancellation(claim.claim.jobId).status).toBe("ALREADY_REQUESTED");
    expect(store.heartbeat(claim.claim, 100).cancellationRequested).toBe(true);
    expect(store.rejectCancellation(claim.claim).snapshot.cancellation).toMatchObject({ status: "REJECTED" });
    expect(store.requestCancellation(claim.claim.jobId).status).toBe("REJECTED");
    expect(store.succeed(claim.claim).snapshot.status).toBe("SUCCEEDED");
    expect(() => store.requestCancellation("missing")).toThrow("not found");
    store.close();
  });

  it("settles a failure as cancellation when cancellation wins at the safe boundary", async () => {
    const test = await fixture();
    const store = test.create();
    enqueue(store, "cancel-failure");
    const claim = store.claimNext("worker", 100);
    if (claim.status !== "ACQUIRED") throw new Error("expected claim");
    store.requestCancellation(claim.claim.jobId);
    expect(store.fail(claim.claim, { code: "SOURCE_UNAVAILABLE", retryable: true }).snapshot).toMatchObject({
      status: "CANCELLED",
      cancellation: { status: "ACKNOWLEDGED" },
    });
    store.close();
  });

  it("does not start another attempt when a cancelled worker disappears before acknowledgement", async () => {
    const test = await fixture({ leaseMs: 100 });
    let store = test.create();
    const queued = enqueue(store, "cancel-crash");
    const claim = store.claimNext("worker", 100);
    if (claim.status !== "ACQUIRED") throw new Error("expected claim");
    expect(store.requestCancellation(claim.claim.jobId).status).toBe("REQUESTED");
    store.close();
    test.advance(100);
    store = test.create();
    expect(store.claimNext("worker-restart", 100)).toEqual({ status: "EMPTY" });
    expect(store.get(queued.job.snapshot.jobId)?.snapshot).toMatchObject({
      status: "CANCELLED",
      attempt: 1,
      cancellation: { status: "ACKNOWLEDGED" },
    });
    store.close();
  });

  it("classifies retryable handler failures and resumes them in a later cycle", async () => {
    const test = await fixture({ retryBaseMs: 100 });
    const store = test.create();
    enqueue(store, "worker-retry");
    let attempts = 0;
    const worker = new DurableJobWorker(store, {
      BACKFILL: async () => {
        attempts += 1;
        if (attempts === 1) throw new RetryableJobError("SOURCE_UNAVAILABLE");
      },
    }, { workerId: "worker", leaseMs: 100, heartbeatMs: 20 });
    await expect(worker.runOnce()).resolves.toMatchObject({ status: "RETRY_WAIT" });
    test.advance(100);
    await expect(worker.runOnce()).resolves.toMatchObject({ status: "SUCCEEDED" });
    expect(attempts).toBe(2);
    store.close();
  });

  it("abandons an externally stopped attempt without extending its lease forever", async () => {
    const test = await fixture({ leaseMs: 100 });
    const store = test.create();
    enqueue(store, "shutdown");
    const controller = new AbortController();
    const worker = new DurableJobWorker(store, {
      BACKFILL: async (context) => {
        controller.abort(new Error("worker shutting down"));
        expect(context.signal.aborted).toBe(true);
      },
    }, { workerId: "worker", leaseMs: 100, heartbeatMs: 20 });
    await expect(worker.runOnce(controller.signal)).resolves.toMatchObject({ status: "ABANDONED", jobId: "job-1" });
    expect(store.get("job-1")?.snapshot.status).toBe("RUNNING");
    test.advance(100);
    expect(store.claimNext("worker-restart", 100)).toMatchObject({ status: "ACQUIRED", claim: { fencingToken: 2 } });
    store.close();
  });

  it("returns lease lost when another worker fences the handler before settlement", async () => {
    const test = await fixture({ leaseMs: 100 });
    const store = test.create();
    const peer = test.create();
    enqueue(store, "worker-fenced");
    const worker = new DurableJobWorker(store, {
      BACKFILL: async (context) => {
        test.advance(100);
        expect(peer.claimNext("peer", 100)).toMatchObject({ status: "ACQUIRED" });
        context.heartbeat();
      },
    }, { workerId: "worker", leaseMs: 100, heartbeatMs: 20 });
    await expect(worker.runOnce()).resolves.toMatchObject({ status: "LEASE_LOST", jobId: "job-1" });
    store.close();
    peer.close();
  });
});
