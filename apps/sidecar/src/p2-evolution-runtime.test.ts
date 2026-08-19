import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { SqliteKnowledgeFreshnessStore } from "@zhiloop/knowledge-freshness";
import type { EvolutionJobProjection } from "@zhiloop/evolution-job-runtime";
import { SqliteKnowledgeRepairDraftStore, type CreateKnowledgeRepairDraftInput } from "@zhiloop/knowledge-repair-drafts";
import type { KnowledgeCandidate } from "@zhiloop/domain";
import type { CodeGraphProcessPort } from "@zhiloop/codegraph-adapter";

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
  readonly alertConfiguration?: ConstructorParameters<typeof P2EvolutionRuntime>[0]["alertConfiguration"];
  readonly onJob?: (job: EvolutionJobProjection) => void; readonly asset?: Readonly<Record<string, unknown>>;
  readonly recipe?: Readonly<Record<string, unknown>>; readonly runs?: readonly Readonly<Record<string, unknown>>[];
  readonly codeGraphProcess?: CodeGraphProcessPort } = {}): { runtime: P2EvolutionRuntime;
    freshness: SqliteKnowledgeFreshnessStore; setRegistryRevision: (revision: number) => void } {
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
  let registryRevision = 0;
  const production = { verification: { verifyBatch: async () => { throw new Error("unexpected verification"); } },
    verificationStore: { getRun: () => undefined, getRecipe: () => options.recipe, listRuns: () => options.runs ?? [] },
    registry: { get activeIndexVersion() { return registryRevision; }, listAssets: () => [],
      getAsset: (id: string) => options.asset?.["id"] === id ? { asset: options.asset, indexVersion: 4 } : undefined } } as unknown as
    Pick<P2ProductionComposition, "verification" | "verificationStore" | "registry">;
  return { freshness, setRegistryRevision: (revision) => { registryRevision = revision; },
    runtime: new P2EvolutionRuntime({ stateDirectory: state, freshnessStore: freshness,
    production, preview, p2Runtime: p2, configuration: { workerPollIntervalMs: 60_000, ...options.configuration },
    ...(options.codeGraphProcess === undefined ? {} : { codeGraphProcess: options.codeGraphProcess }),
    ...(options.alertConfiguration === undefined ? {} : { alertConfiguration: options.alertConfiguration }),
    ...(options.onJob === undefined ? {} : { onJob: options.onJob }) }) };
}

const NOW = "2026-08-19T07:00:00.000Z";

function repairCandidate(candidateId = "candidate-source"): KnowledgeCandidate {
  return { schemaVersion: 1, candidateId, compilerVersion: "compiler-v1", status: "PROPOSED",
    subjectKey: "project.module.behavior", kind: "IMPLEMENTATION",
    scopeHint: { level: "PROJECT", projectId: "project-1", reasonCodes: ["PROJECT_MATCH"] },
    title: "旧实现", summary: "旧实现摘要", body: "旧实现正文", sourceEpisodes: ["episode-1"], confidence: 0.9,
    createdAt: NOW, correlationId: "correlation-1", assertions: [{ assertionId: "assertion-source", candidateId,
      kind: "SYMBOL_EXISTS", parameters: { projectId: "project-1", symbol: "OldSymbol", path: "source.ts" }, createdAt: NOW }],
    evidenceHints: [] };
}

function repairInput(): CreateKnowledgeRepairDraftInput {
  const candidate = repairCandidate();
  return { projectId: "project-1", sourceKnowledge: { assetId: "asset-1", assetVersion: 3,
    contentHash: "a".repeat(64), lifecycleStatus: "VERIFIED", candidate },
  conflict: { runId: "verification-conflict-1", codeRevision: "git:changed", completedAt: NOW },
  changedAssertions: [{ assertionId: candidate.assertions[0]!.assertionId, assertionKind: "SYMBOL_EXISTS",
    verificationStatus: "UNSUPPORTED", reasonCodes: ["SYMBOL_NOT_FOUND"] }],
  reasonCodes: ["ASSERTION_UNSUPPORTED"], createdAt: NOW };
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
    expect(fixture.runtime.state().capabilities).toContainEqual(expect.objectContaining({ jobType: "KNOWLEDGE_REPAIR_DRAFT", status: "READY" }));
    expect(fixture.runtime.listRepairDrafts({ limit: 10 }).items).toEqual([]);
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
    expect(() => fixture.runtime.listRepairDrafts({ limit: 10 })).toThrow("RUNTIME_CLOSED");
    expect(() => fixture.runtime.listOperationalAlerts({ limit: 10 })).toThrow("RUNTIME_CLOSED");
    fixture.freshness.close();
  });

  it("persists a sanitized permanent-failure alert when its producer switch is enabled", async () => {
    const { state } = repository();
    const fixture = runtime(state, { configuration: { enabled: true, maxAttempts: 1 }, alertConfiguration: {
      enabled: true, onPermanentJobFailure: true, onCodeGraphUnavailable: false, onStaleKnowledgeDetected: false,
    } });
    fixture.runtime.enqueue({ schemaVersion: 1, jobType: "KNOWLEDGE_REPAIR_DRAFT", projectId: "project-1",
      assetId: "missing-asset", assetVersion: 1, conflictRunId: "missing-run" }, 1);
    await fixture.runtime.start();
    const alerts = fixture.runtime.listOperationalAlerts({ limit: 10 }).items;
    expect(alerts).toEqual([expect.objectContaining({ type: "PERMANENT_JOB_FAILURE", severity: "CRITICAL",
      occurrenceCount: 1, deliveryState: "LOCAL_ONLY" })]);
    expect(JSON.stringify(alerts)).not.toMatch(/source\.ts|unexpected verification/u);
    await fixture.runtime.close();
    fixture.freshness.close();
  });

  it("composes side-effect-free operations and paged alert projections with independent operator state", async () => {
    const { state } = repository(); const fixture = runtime(state, { configuration: { enabled: true, maxAttempts: 1 }, alertConfiguration: {
      enabled: true, onPermanentJobFailure: true, onCodeGraphUnavailable: false, onStaleKnowledgeDetected: false,
    } });
    for (const assetId of ["missing-a", "missing-b"]) fixture.runtime.enqueue({ schemaVersion: 1,
      jobType: "KNOWLEDGE_REPAIR_DRAFT", projectId: "project-1", assetId, assetVersion: 1,
      conflictRunId: `run-${assetId}` }, 1);
    await fixture.runtime.start();
    const beforeJobs = fixture.runtime.listJobs().map((job) => `${job.jobId}:${job.revision}:${job.status}`);
    const snapshot = fixture.runtime.operationsSnapshot();
    expect(snapshot.sections).toHaveLength(8); expect(snapshot.sections.find((item) => item.area === "REPAIR"))
      .toMatchObject({ status: "FAILED", failed: 2 });
    expect(fixture.runtime.listJobs().map((job) => `${job.jobId}:${job.revision}:${job.status}`)).toEqual(beforeJobs);
    const first = fixture.runtime.listOperationalAlertsForConsole({ limit: 1 });
    expect(first).toMatchObject({ bounded: true, items: [{ severity: "CRITICAL", diagnostic: { retryable: false } }] });
    const second = fixture.runtime.listOperationalAlertsForConsole({ limit: 1, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1); expect(second.items[0]?.alertId).not.toBe(first.items[0]?.alertId);
    expect(() => fixture.runtime.listOperationalAlertsForConsole({ limit: 1, cursor: "tampered" })).toThrow("CURSOR_INVALID");
    const alert = first.items[0]!;
    expect(alert).toMatchObject({ revision: 0, alertRevision: 1 });
    const acknowledged = fixture.runtime.acknowledgeOperationalAlert({ alertId: alert.alertId, expectedRevision: 0,
      idempotencyKey: "console-alert-ack-0001", requestedAt: "2026-08-19T07:01:00.000Z" });
    expect(fixture.runtime.acknowledgeOperationalAlert({ alertId: alert.alertId, expectedRevision: 0,
      idempotencyKey: "console-alert-ack-0001", requestedAt: "2026-08-19T07:01:30.000Z" })).toEqual(acknowledged);
    expect(fixture.runtime.suppressOperationalAlert({ alertId: alert.alertId, expectedRevision: acknowledged.operatorState.revision,
      idempotencyKey: "console-alert-suppress-0001", requestedAt: "2026-08-19T07:02:00.000Z",
      suppressedUntil: "2026-08-19T08:02:00.000Z" }).operatorState).toMatchObject({ revision: 2 });
    expect(fixture.runtime.listOperationalAlertsForConsole({ projectId: "other-project", limit: 10 }).items).toEqual([]);
    await fixture.runtime.close(); fixture.freshness.close();
  });

  it("projects knowledge evolution and submits a revision-bound proposed repair candidate idempotently", async () => {
    const { root, state } = repository();
    const asset = { schemaVersion: 1, id: "asset-1", version: 3, scope: { level: "PROJECT", projectId: "project-1" } };
    const recipe = { recipeVersion: "evidence-recipe-v1", assertionsHash: "b".repeat(64), assertions: [{ assertionId: "assertion-source" }], createdAt: NOW };
    const fixture = runtime(state, { configuration: { enabled: false }, asset, recipe, runs: [{ runId: "run-current",
      purpose: "FRESHNESS", projectId: "project-1", codeRevision: "git:current", graphRevision: "graph:current",
      qualifyingProof: true, status: "COMPLETED", results: [{ assertionId: "assertion-source",
        assertionKind: "SYMBOL_EXISTS", status: "SUPPORTED", reasonCodes: [], evidenceId: "evidence-1" }], completedAt: NOW }] });
    fixture.runtime.observeProject("project-1", root);
    const external = new SqliteKnowledgeRepairDraftStore(join(state, "knowledge-repair-drafts.sqlite"));
    const draft = external.create(repairInput()).draft; external.close();
    expect(fixture.runtime.knowledgeEvolution("asset-1")).toMatchObject({ knowledgeVersion: 3, projectId: "project-1",
      repairDrafts: [{ draftId: draft.draftId, status: "PENDING" }],
      verificationRuns: [{ graphRevision: "graph:current", results: [{ evidenceId: "evidence-1" }] }],
      revalidationAction: { enabled: false, reasonCode: "KNOWLEDGE_EVOLUTION_DISABLED" } });
    expect(() => fixture.runtime.knowledgeEvolution("missing")).toThrow("NOT_FOUND");
    await expect(fixture.runtime.revalidateKnowledge({ knowledgeId: "asset-1", expectedKnowledgeVersion: 2,
      expectedFreshnessRevision: 0, idempotencyKey: "revalidate-stale-0001", requestedAt: NOW })).rejects.toThrow("REVISION_CONFLICT");
    const command = { draftId: draft.draftId, expectedRevision: 0, idempotencyKey: "repair-submit-0001",
      title: "新实现", summary: "新实现摘要", body: "新实现正文", requestedAt: "2026-08-19T07:03:00.000Z" };
    const submitted = await fixture.runtime.submitRepairCandidate(command);
    expect(submitted.draft).toMatchObject({ status: "READY", revision: 1,
      proposedCandidate: { title: "新实现" } });
    expect(submitted.draft.proposedCandidate?.candidateId).toMatch(/^repair-candidate-/u);
    expect(await fixture.runtime.submitRepairCandidate({ ...command, requestedAt: "2026-08-19T07:04:00.000Z" })).toEqual(submitted);
    await expect(fixture.runtime.submitRepairCandidate({ ...command, title: "冲突内容" })).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    await expect(fixture.runtime.submitRepairCandidate({ ...command, idempotencyKey: "repair-submit-stale-0002" }))
      .rejects.toThrow("REVISION_CONFLICT");
    await fixture.runtime.close(); fixture.freshness.close();
  });

  it("revalidates an eligible knowledge item, distinguishes no-change from queued work, and replays receipts", async () => {
    const { root, state } = repository();
    const asset = { schemaVersion: 1, id: "asset-1", version: 3, scope: { level: "PROJECT", projectId: "project-1" } };
    const recipe = { recipeVersion: "evidence-recipe-v1", assertionsHash: "b".repeat(64),
      assertions: [{ assertionId: "assertion-source" }], createdAt: NOW };
    const fixture = runtime(state, { asset, recipe });
    fixture.runtime.observeProject("project-1", root);
    await fixture.runtime.start();
    const unchangedCommand = { knowledgeId: "asset-1", expectedKnowledgeVersion: 3, expectedFreshnessRevision: 0,
      idempotencyKey: "revalidate-current-0001", requestedAt: "2026-08-19T07:10:00.000Z" };
    const unchanged = await fixture.runtime.revalidateKnowledge(unchangedCommand);
    expect(unchanged).toMatchObject({ disposition: "NO_CHANGES", reasonCode: "CODE_REVISION_ALREADY_CURRENT" });
    expect(await fixture.runtime.revalidateKnowledge({ ...unchangedCommand, requestedAt: "2026-08-19T07:11:00.000Z" }))
      .toEqual(unchanged);

    writeFileSync(join(root, "source.ts"), "export const value = 2;\n");
    const queued = await fixture.runtime.revalidateKnowledge({ ...unchangedCommand,
      idempotencyKey: "revalidate-changed-0002", requestedAt: "2026-08-19T07:12:00.000Z" });
    expect(queued).toMatchObject({ disposition: "QUEUED", reasonCode: "KNOWLEDGE_REVALIDATION_QUEUED",
      job: { jobType: "KNOWLEDGE_REVALIDATE" } });
    await fixture.runtime.trigger();
    expect(fixture.runtime.knowledgeEvolution("asset-1").jobs).toContainEqual(expect.objectContaining({
      jobId: queued.job?.jobId, status: "SUCCEEDED",
    }));
    await fixture.runtime.close(); fixture.freshness.close();
  });

  it("explains why global, unobserved, recipe-less, and disabled knowledge cannot be revalidated", async () => {
    const { state } = repository();
    const globalFixture = runtime(state, { asset: { schemaVersion: 1, id: "global-asset", version: 1,
      scope: { level: "GLOBAL" } }, configuration: { enabled: true } });
    expect(globalFixture.runtime.knowledgeEvolution("global-asset").revalidationAction)
      .toMatchObject({ enabled: false, reasonCode: "PROJECT_SCOPE_REQUIRED" });
    await expect(globalFixture.runtime.revalidateKnowledge({ knowledgeId: "global-asset", expectedKnowledgeVersion: 1,
      expectedFreshnessRevision: 0, idempotencyKey: "revalidate-global-0001", requestedAt: NOW }))
      .rejects.toThrow("PROJECT_SCOPE_REQUIRED");
    await globalFixture.runtime.close(); globalFixture.freshness.close();

    const other = repository();
    const recipeLess = runtime(other.state, { asset: { schemaVersion: 1, id: "recipe-less", version: 1,
      scope: { level: "PROJECT", projectId: "project-1" } }, configuration: { enabled: true } });
    recipeLess.runtime.observeProject("project-1", other.root);
    expect(recipeLess.runtime.knowledgeEvolution("recipe-less").revalidationAction.reasonCode)
      .toBe("VERIFICATION_RECIPE_MISSING");
    await expect(recipeLess.runtime.revalidateKnowledge({ knowledgeId: "recipe-less", expectedKnowledgeVersion: 1,
      expectedFreshnessRevision: 0, idempotencyKey: "revalidate-recipe-less-0001", requestedAt: NOW }))
      .rejects.toThrow("VERIFICATION_RECIPE_MISSING");
    await recipeLess.runtime.close(); recipeLess.freshness.close();
  });

  it("initializes CodeGraph through a durable job and replays a successful commit after preview expiry", async () => {
    const { root, state } = repository(); let initialized = false; const calls: string[][] = [];
    const processPort: CodeGraphProcessPort = { run: async (request) => {
      calls.push([...request.args]);
      if (request.args[0] === "--version") return { exitCode: 0, stdout: "0.9.3\n", stderr: "", timedOut: false, outputExceeded: false };
      if (request.args[0] === "init") { initialized = true; return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false, outputExceeded: false }; }
      if (request.args[0] === "status") return { exitCode: 0, stdout: JSON.stringify(initialized
        ? { initialized: true, fileCount: 2, nodeCount: 4, edgeCount: 3, dbSizeBytes: 100, backend: "sqlite",
          nodesByKind: { function: 4 }, languages: ["ts"], pendingChanges: { added: 0, modified: 0, removed: 0 } }
        : { initialized: false }), stderr: "", timedOut: false, outputExceeded: false };
      if (request.args[0] === "query") return { exitCode: 0, stdout: "[]", stderr: "", timedOut: false, outputExceeded: false };
      return { exitCode: 1, stdout: "", stderr: "redacted", timedOut: false, outputExceeded: false };
    } };
    const fixture = runtime(state, { configuration: { enabled: false }, codeGraphProcess: processPort });
    fixture.runtime.observeProject("project-1", root);
    const preview = await fixture.runtime.previewCodeGraphInitialization("project-1", "2026-08-19T08:00:00.000Z");
    const command = { projectId: "project-1", previewId: preview.previewId,
      repositoryIdentity: preview.repositoryIdentity, expectedRevision: preview.expectedRevision,
      idempotencyKey: "codegraph-commit-runtime-0001", requestedAt: "2026-08-19T08:01:00.000Z" };
    const committed = fixture.runtime.commitCodeGraphInitialization(command);
    expect(committed.job).toMatchObject({ jobType: "CODEGRAPH_INITIALIZE", status: "QUEUED" });
    await fixture.runtime.trigger();
    const codeGraphPage = await fixture.runtime.listCodeGraphProjects();
    expect(codeGraphPage.items[0]?.latestJob?.lastFailure).toBeUndefined();
    expect(codeGraphPage.items[0]).toMatchObject({ status: "READY", revision: 1,
      latestJob: { jobId: committed.job.jobId, status: "SUCCEEDED" } });
    const replayed = fixture.runtime.commitCodeGraphInitialization({ ...command, requestedAt: "2026-08-19T09:00:00.000Z" });
    expect(replayed.job.jobId).toBe(committed.job.jobId);
    expect(calls.map((call) => call[0])).toEqual(expect.arrayContaining(["--version", "status", "init", "query"]));
    await fixture.runtime.close(); fixture.freshness.close();
  });

  it("keeps CodeGraph list projection bounded, server-owned, and free of initialization writes", async () => {
    const first = repository(); const second = repository(); const fixture = runtime(first.state, { configuration: { enabled: false } });
    fixture.runtime.observeProject("project-b", second.root); fixture.runtime.observeProject("project-a", first.root);
    const page = await fixture.runtime.listCodeGraphProjects(1);
    expect(page).toMatchObject({ bounded: true, revision: 0, items: [{ projectId: "project-a", status: "NOT_CONFIGURED" }] });
    expect(fixture.runtime.observedProjects().map((item) => item.projectId)).toEqual(["project-a", "project-b"]);
    expect(() => fixture.runtime.getRepairDraft("missing-draft")).not.toThrow();
    await fixture.runtime.close(); fixture.freshness.close();
  });

  it("runs an empty legacy migration through preview, durable commit and rollback", async () => {
    const { root, state } = repository(); const fixture = runtime(state, { configuration: { enabled: true } });
    fixture.runtime.observeProject("project-1", root);
    const preview = fixture.runtime.previewLegacyMigration("project-1", "2026-08-19T06:00:00.000Z");
    expect(preview).toMatchObject({ status: "READY", scannedCount: 0, migratableCount: 0 });
    expect(fixture.runtime.listLegacyMigrations("project-1")).toEqual([preview]);
    expect(fixture.runtime.listLegacyMigrationItems(preview.migrationId)).toEqual({ items: [] });
    const committed = fixture.runtime.commitLegacyMigration({ migrationId: preview.migrationId, expectedRevision: 0,
      idempotencyKey: "commit-migration-empty", updatedAt: "2026-08-19T06:01:00.000Z" });
    expect(committed).toMatchObject({ preview: { status: "COMMITTING", revision: 1 },
      job: { jobType: "LEGACY_KNOWLEDGE_MIGRATION", status: "QUEUED", entityRef: preview.migrationId } });
    fixture.setRegistryRevision(1);
    expect(fixture.runtime.commitLegacyMigration({ migrationId: preview.migrationId, expectedRevision: 0,
      idempotencyKey: "commit-migration-empty", updatedAt: "2026-08-19T06:01:00.000Z" })).toEqual(committed);
    fixture.setRegistryRevision(0);
    await fixture.runtime.start();
    expect(fixture.runtime.getLegacyMigration(preview.migrationId)).toMatchObject({ status: "COMPLETED", revision: 2 });
    const rolledBack = await fixture.runtime.rollbackLegacyMigration({ migrationId: preview.migrationId, expectedRevision: 2,
      idempotencyKey: "rollback-migration-empty", updatedAt: "2026-08-19T06:02:00.000Z" });
    expect(rolledBack).toMatchObject({ status: "ROLLED_BACK", rollbackConflictCount: 0 });
    await fixture.runtime.close(); fixture.freshness.close();
  });

  it("marks a terminal legacy migration failed and persists a sanitized migration alert", async () => {
    const { root, state } = repository();
    const fixture = runtime(state, { configuration: { enabled: true, maxAttempts: 1 }, alertConfiguration: {
      enabled: true, onPermanentJobFailure: true, onCodeGraphUnavailable: false, onStaleKnowledgeDetected: false,
    } });
    fixture.runtime.observeProject("project-1", root);
    const preview = fixture.runtime.previewLegacyMigration("project-1", "2026-08-19T06:10:00.000Z");
    fixture.runtime.commitLegacyMigration({ migrationId: preview.migrationId, expectedRevision: preview.revision,
      idempotencyKey: "commit-migration-terminal-failure", updatedAt: "2026-08-19T06:11:00.000Z" });
    fixture.setRegistryRevision(1);
    await fixture.runtime.start();
    expect(fixture.runtime.getLegacyMigration(preview.migrationId)).toMatchObject({ status: "FAILED",
      failureCode: "LEGACY_MIGRATION_REGISTRY_REVISION_CONFLICT" });
    const alerts = fixture.runtime.listOperationalAlerts({ limit: 10 }).items;
    expect(alerts).toEqual([expect.objectContaining({ type: "MIGRATION_FAILED", severity: "CRITICAL",
      projectId: "project-1", entityRef: preview.migrationId, reasonCodes: ["LEGACY_MIGRATION_REGISTRY_REVISION_CONFLICT"] })]);
    expect(JSON.stringify(alerts)).not.toMatch(/source\.ts|unexpected verification|knowledgeBody|rawPrompt/u);
    await fixture.runtime.close(); fixture.freshness.close();
  });

  it("fails closed for unobserved projects, stale previews and unknown migration commands", async () => {
    const { root, state } = repository(); const fixture = runtime(state, { configuration: { enabled: false } });
    expect(() => fixture.runtime.previewLegacyMigration("project-1", "2026-08-19T06:20:00.000Z"))
      .toThrow("LEGACY_MIGRATION_PROJECT_UNOBSERVED");
    fixture.runtime.observeProject("project-1", root);
    const preview = fixture.runtime.previewLegacyMigration("project-1", "2026-08-19T06:20:00.000Z");
    fixture.setRegistryRevision(1);
    expect(() => fixture.runtime.commitLegacyMigration({ migrationId: preview.migrationId, expectedRevision: 0,
      idempotencyKey: "commit-stale-registry", updatedAt: "2026-08-19T06:21:00.000Z" }))
      .toThrow("LEGACY_MIGRATION_REGISTRY_REVISION_CONFLICT");
    fixture.setRegistryRevision(0);
    expect(() => fixture.runtime.commitLegacyMigration({ migrationId: preview.migrationId, expectedRevision: 1,
      idempotencyKey: "commit-stale-preview", updatedAt: "2026-08-19T06:21:00.000Z" }))
      .toThrow("LEGACY_MIGRATION_REVISION_CONFLICT");
    expect(() => fixture.runtime.commitLegacyMigration({ migrationId: "migration-missing", expectedRevision: 0,
      idempotencyKey: "commit-missing-preview", updatedAt: "2026-08-19T06:21:00.000Z" }))
      .toThrow("LEGACY_MIGRATION_NOT_FOUND");
    await expect(fixture.runtime.rollbackLegacyMigration({ migrationId: "migration-missing", expectedRevision: 0,
      idempotencyKey: "rollback-missing-preview", updatedAt: "2026-08-19T06:21:00.000Z" }))
      .rejects.toThrow("LEGACY_MIGRATION_NOT_FOUND");
    expect(() => fixture.runtime.listLegacyMigrations("project-1", 0)).toThrow("LEGACY_MIGRATION_LIST_LIMIT_INVALID");
    await fixture.runtime.close(); fixture.freshness.close();
  });

  it("projects durable enqueue and operator cancellation without exposing payloads", async () => {
    const { state } = repository();
    const projected: EvolutionJobProjection[] = [];
    const fixture = runtime(state, { configuration: { enabled: false }, onJob: (job) => projected.push(job) });
    const created = fixture.runtime.enqueue({ schemaVersion: 1, jobType: "KNOWLEDGE_COMPILE", sessionId: "session-1",
      sourceRange: { from: 1, to: 2 }, pipelineHash: "a".repeat(64) }, 3);
    const jobId = created.job.snapshot.jobId;
    expect(fixture.runtime.getJob(jobId)).toMatchObject({ jobId, status: "QUEUED" });
    expect(fixture.runtime.operationsSnapshot().sections.find((item) => item.area === "COMPILE"))
      .toMatchObject({ status: "RUNNING", queued: 1, reasonCode: "COMPILE_IN_PROGRESS" });
    expect(fixture.runtime.listJobs(1)).toHaveLength(1);
    expect(fixture.runtime.jobs().attempts(jobId)).toEqual([]);
    const current = fixture.runtime.getJob(jobId)!;
    expect(fixture.runtime.cancel({ jobId, expectedRevision: current.revision, idempotencyKey: "cancel-evolution-job-0001" }))
      .toMatchObject({ disposition: "APPLIED", job: { status: "CANCELLED" } });
    expect(fixture.runtime.operationsSnapshot().sections.find((item) => item.area === "COMPILE"))
      .toMatchObject({ status: "READY", queued: 0, reasonCode: "COMPILE_READY" });
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
