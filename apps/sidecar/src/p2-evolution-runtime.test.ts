import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { SqliteKnowledgeFreshnessStore } from "@zhiloop/knowledge-freshness";
import type { EvolutionJobProjection } from "@zhiloop/evolution-job-runtime";

import { P2EvolutionRuntime, normalizeP2EvolutionRuntimeConfiguration } from "./p2-evolution-runtime.js";
import type { P2CandidatePreviewPort } from "./p2-preview-coordinator.js";
import type { P2ProductionComposition } from "./p2-production.js";
import type { P2SidecarRuntime } from "./p2-runtime.js";

const directories: string[] = [];

function repository(): { readonly root: string; readonly state: string } {
  const workspace = mkdtempSync(join(tmpdir(), "zhiloop-evolution-sidecar-"));
  directories.push(workspace);
  const root = join(workspace, "repository");
  const state = join(workspace, "state");
  mkdirSync(root);
  mkdirSync(state);
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  writeFileSync(join(root, "source.ts"), "export const value = 1;\n");
  execFileSync("git", ["-C", root, "add", "source.ts"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "initial"]);
  return { root, state };
}

function runtime(state: string, options: { readonly configuration?: ConstructorParameters<typeof P2EvolutionRuntime>[0]["configuration"];
  readonly onJob?: (job: EvolutionJobProjection) => void } = {}): { runtime: P2EvolutionRuntime; freshness: SqliteKnowledgeFreshnessStore } {
  const freshness = new SqliteKnowledgeFreshnessStore(join(state, "freshness.sqlite"));
  const preview: P2CandidatePreviewPort = {
    pipelineIdentity: () => ({ compilerVersion: "compiler-v1", promptVersion: "prompt-v1",
      policyHash: "policy-v1", configurationHash: "config-v1" }),
    plan: async () => ({ status: "INELIGIBLE", reasonCode: "NO_EXTRACTABLE_EVENTS" }),
    coordinate: async () => ({ status: "INELIGIBLE", reasonCode: "NO_EXTRACTABLE_EVENTS" }),
  };
  const p2 = {
    service: () => ({ listSnapshots: () => ({ items: [] }), getSnapshot: () => undefined }),
    candidatePreviewJobForSnapshot: () => undefined,
  } as unknown as P2SidecarRuntime;
  const production = { verification: { verifyBatch: async () => { throw new Error("unexpected verification"); } } } as unknown as Pick<P2ProductionComposition, "verification">;
  return { freshness, runtime: new P2EvolutionRuntime({ stateDirectory: state, freshnessStore: freshness,
    production, preview, p2Runtime: p2, configuration: { workerPollIntervalMs: 60_000, ...options.configuration },
    ...(options.onJob === undefined ? {} : { onJob: options.onJob }) }) };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

describe("P2EvolutionRuntime", () => {
  it("validates the full runtime and gate budget before composition", () => {
    expect(normalizeP2EvolutionRuntimeConfiguration()).toMatchObject({ enabled: true, leaseMs: 30_000,
      heartbeatMs: 5_000, freshnessGateDeadlineMs: 150, freshnessGateMaxTargetedItems: 0 });
    expect(() => normalizeP2EvolutionRuntimeConfiguration({ leaseMs: 100, heartbeatMs: 100 })).toThrow("HEARTBEAT");
    expect(() => normalizeP2EvolutionRuntimeConfiguration({ freshnessGateDeadlineMs: 201 })).toThrow("GATE_DEADLINE");
    expect(() => normalizeP2EvolutionRuntimeConfiguration({ changeDebounceMs: 2_000, fallbackScanIntervalMs: 1_000 }))
      .toThrow("FALLBACK");
    expect(() => normalizeP2EvolutionRuntimeConfiguration({ freshnessGateDeadlineMs: 100,
      freshnessGateMinimumRemainingMs: 101 })).toThrow("GATE_MINIMUM");
    const invalid: readonly [Partial<Parameters<typeof normalizeP2EvolutionRuntimeConfiguration>[0]>, string][] = [
      [{ enabled: "yes" as never }, "ENABLED_INVALID"],
      [{ workerPollIntervalMs: 99 }, "WORKER_POLL_INTERVAL_MS_INVALID"],
      [{ changeDebounceMs: -1 }, "CHANGE_DEBOUNCE_MS_INVALID"],
      [{ fallbackScanIntervalMs: 99 }, "FALLBACK_SCAN_INTERVAL_MS_INVALID"],
      [{ leaseMs: 9 }, "LEASE_MS_INVALID"],
      [{ heartbeatMs: 3_600_000 }, "HEARTBEAT_MS_INVALID"],
      [{ maxAttempts: 0 }, "MAX_ATTEMPTS_INVALID"],
      [{ revalidationPageSize: 1.5 }, "REVALIDATION_PAGE_SIZE_INVALID"],
      [{ maxAffectedPerJob: 100_001 }, "MAX_AFFECTED_PER_JOB_INVALID"],
      [{ freshnessGateMaxItems: 0 }, "GATE_MAX_ITEMS_INVALID"],
      [{ freshnessGateMaxTargetedItems: 21 }, "GATE_MAX_TARGETED_ITEMS_INVALID"],
      [{ freshnessGateMinimumRemainingMs: 201 }, "GATE_MINIMUM_REMAINING_MS_INVALID"],
    ];
    for (const [value, reason] of invalid) expect(() => normalizeP2EvolutionRuntimeConfiguration(value)).toThrow(reason);
  });

  it("supports disabled lifecycle, deterministic compensation and fail-closed post-close access", async () => {
    const { root, state } = repository();
    const fixture = runtime(state, { configuration: { enabled: false } });
    fixture.runtime.observeProject("project-1", root);
    expect(fixture.runtime.state()).toMatchObject({ status: "DISABLED", activeJobs: 0 });
    expect(await fixture.runtime.start()).toBe(true);
    expect(await fixture.runtime.start()).toBe(false);
    await fixture.runtime.trigger();
    const request = { projectId: "project-1", assetId: "asset-1", assetVersion: 1,
      reasonCode: "FRESHNESS_CODE_REVISION_MISMATCH" } as const;
    expect(fixture.runtime.schedule(request)).toMatch(/^evolution-compensation-[a-f0-9]{64}$/u);
    expect(fixture.runtime.schedule(request)).toBe(fixture.runtime.schedule(request));
    expect(fixture.runtime.schedule({ ...request, projectId: "unknown" })).not.toBe(fixture.runtime.schedule(request));
    const rollback = await fixture.runtime.applyConfiguration({ enabled: false, changeDebounceMs: 500,
      fallbackScanIntervalMs: 60_000, maxAffectedPerJob: 10_000 });
    await rollback();
    await rollback();
    await fixture.runtime.close();
    await fixture.runtime.close();
    expect(() => fixture.runtime.state()).toThrow("RUNTIME_CLOSED");
    expect(() => fixture.runtime.jobs()).toThrow("RUNTIME_CLOSED");
    expect(() => fixture.runtime.read("project-1")).toThrow("RUNTIME_CLOSED");
    expect(() => fixture.runtime.schedule(request)).toThrow("RUNTIME_CLOSED");
    fixture.freshness.close();
  });

  it("projects durable enqueue and operator cancellation without exposing payloads", async () => {
    const { state } = repository();
    const projected: EvolutionJobProjection[] = [];
    const fixture = runtime(state, { configuration: { enabled: false }, onJob: (job) => projected.push(job) });
    const created = fixture.runtime.enqueue({ schemaVersion: 1, jobType: "KNOWLEDGE_COMPILE", sessionId: "session-1",
      sourceRange: { from: 1, to: 2 }, pipelineHash: "a".repeat(64) }, 3);
    const jobId = created.job.snapshot.jobId;
    expect(fixture.runtime.getJob(jobId)).toMatchObject({ jobId, status: "QUEUED" });
    expect(fixture.runtime.listJobs(1)).toHaveLength(1);
    expect(fixture.runtime.jobs().attempts(jobId)).toEqual([]);
    const current = fixture.runtime.getJob(jobId)!;
    expect(fixture.runtime.cancel({ jobId, expectedRevision: current.revision, idempotencyKey: "cancel-evolution-job-0001" }))
      .toMatchObject({ disposition: "APPLIED", job: { status: "CANCELLED" } });
    const cancelled = fixture.runtime.getJob(jobId)!;
    expect(() => fixture.runtime.retry({ jobId, expectedRevision: cancelled.revision, idempotencyKey: "retry-evolution-job-0001" }))
      .toThrow("only retry-wait or retryable failed jobs");
    expect(projected.map((job) => job.status)).toEqual(["QUEUED", "CANCELLED"]);
    await fixture.runtime.start();
    expect(projected.at(-1)?.status).toBe("CANCELLED");
    await fixture.runtime.close();
    fixture.freshness.close();
  });

  it("recovers Git intake, executes revalidation durably, advances baseline last, and restarts current", async () => {
    const { root, state } = repository();
    const first = runtime(state);
    first.runtime.observeProject("project-1", root);
    await first.runtime.start();
    writeFileSync(join(root, "source.ts"), "export const value = 2;\n");
    expect(first.runtime.schedule({ projectId: "project-1", assetId: "asset-1", assetVersion: 1,
      reasonCode: "FRESHNESS_CODE_REVISION_MISMATCH" })).toMatch(/^evolution-compensation-/u);
    await first.runtime.trigger();
    expect(first.runtime.listJobs()).toEqual([expect.objectContaining({ jobType: "KNOWLEDGE_REVALIDATE", status: "SUCCEEDED",
      projectId: "project-1", checkpointPhase: "BASELINE_ACKNOWLEDGED" })]);
    expect(first.runtime.read("project-1")?.codeRevision).toMatch(/^git:/u);
    expect(first.runtime.state()).toMatchObject({ status: "READY", activeJobs: 0, failedWorkerCycles: 0 });
    await first.runtime.close();
    first.freshness.close();

    const recovered = runtime(state);
    await recovered.runtime.start();
    expect(recovered.runtime.state()).toMatchObject({ status: "READY" });
    expect(recovered.runtime.listJobs()).toHaveLength(1);
    await recovered.runtime.close();
    recovered.freshness.close();
  });

  it("hot-swaps intake only after validation and preserves observed projects", async () => {
    const { root, state } = repository();
    const fixture = runtime(state);
    fixture.runtime.observeProject("project-1", root);
    await fixture.runtime.start();
    const rollback = await fixture.runtime.applyConfiguration({ enabled: true, changeDebounceMs: 100,
      fallbackScanIntervalMs: 10_000, maxAffectedPerJob: 100 });
    expect(fixture.runtime.read("project-1")?.projectId).toBe("project-1");
    await rollback();
    expect(fixture.runtime.state().status).toBe("READY");
    await fixture.runtime.close();
    fixture.freshness.close();
  });

  it("keeps polling while enabled and stops rescheduling after close", async () => {
    const { state } = repository();
    const fixture = runtime(state, { configuration: { workerPollIntervalMs: 100 } });
    await fixture.runtime.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 140));
    expect(fixture.runtime.state().completedWorkerCycles).toBeGreaterThanOrEqual(2);
    await fixture.runtime.close();
    fixture.freshness.close();
  });
});
