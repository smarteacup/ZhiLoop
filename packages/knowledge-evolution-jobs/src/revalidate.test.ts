import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { KnowledgeAsset, KnowledgeCandidate } from "@zhiloop/domain";
import { EvolutionJobRuntime, type KnowledgeRevalidateJobInput } from "@zhiloop/evolution-job-runtime";
import { GitKnowledgeChangeSource, type GitProcessPort } from "@zhiloop/knowledge-change-intake";
import { SqliteKnowledgeFreshnessStore, type FreshnessRevalidationPort } from "@zhiloop/knowledge-freshness";

import { createKnowledgeRevalidateHandler } from "./revalidate.js";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

function temporary(name: string): string { const value = mkdtempSync(join(tmpdir(), name)); cleanup.push(value); return value; }

class FakeGit implements GitProcessPort {
  head = "a".repeat(40);
  status = "";
  async run(_cwd: string, args: readonly string[]): Promise<string> {
    if (args[0] === "rev-parse") return `${this.head}\n`;
    if (args[0] === "status") return this.status;
    if (args[0] === "diff" || args[0] === "ls-files") return "";
    throw new Error("unexpected git operation");
  }
}

const at = "2026-08-19T00:00:00.000Z";

function projection(assetId: string, path: string) {
  const candidateId = `candidate-${assetId}`;
  const assertionId = `assertion-${assetId}`;
  const candidate: KnowledgeCandidate = {
    schemaVersion: 1, candidateId, compilerVersion: "compiler-v1", status: "PROPOSED",
    subjectKey: `implementation.${assetId}`, kind: "IMPLEMENTATION",
    scopeHint: { level: "PROJECT", projectId: "project-1", reasonCodes: [] }, title: assetId,
    summary: `Track ${path}`, body: `${path} exists`, sourceEpisodes: ["episode-1"], confidence: 0.9,
    assertions: [{ assertionId, candidateId, kind: "SYMBOL_EXISTS",
      parameters: { projectId: "project-1", symbol: `Symbol${assetId}`, path }, createdAt: at }],
    evidenceHints: [], createdAt: at, correlationId: `correlation-${assetId}`,
  };
  const asset: KnowledgeAsset = {
    schemaVersion: 1, id: assetId, subjectKey: candidate.subjectKey, kind: candidate.kind,
    scope: { level: "PROJECT", projectId: "project-1" }, version: 1, status: "IMPLEMENTED",
    title: candidate.title, summary: candidate.summary, body: candidate.body, aliases: [], keywords: [], applicability: [],
    nonApplicability: [], symbols: [], relations: [], evidence: [{ evidenceId: `evidence-${assetId}`, verdict: "SUPPORTS" }],
    confidence: 0.9, sourceEpisodes: ["episode-1"], contentHash: `content-${assetId}`,
    correlationId: candidate.correlationId, createdAt: at, updatedAt: at,
  };
  return { asset, candidate, verificationResults: [{ assertionId, assertionKind: "SYMBOL_EXISTS" as const,
    status: "SUPPORTED" as const, target: `file:${path}`, observedAt: at, reasonCodes: ["FILE_EXISTS"], evidence: {
      evidenceId: `evidence-${assetId}`, assertionId, type: "CODE_SYMBOL" as const, verdict: "SUPPORTS" as const,
      sourceRef: `file:${path}`, projectId: "project-1", observedAt: at, correlationId: candidate.correlationId,
    } }], projectId: "project-1", observedAt: at };
}

class FakeVerifier implements FreshnessRevalidationPort {
  readonly calls: string[][] = [];
  failAssetOnce: string | undefined;
  incomplete = false;
  async verifyBatch(input: Parameters<FreshnessRevalidationPort["verifyBatch"]>[0]) {
    const ids = input.items.map((item) => item.assetId);
    this.calls.push(ids);
    if (this.failAssetOnce !== undefined && ids.includes(this.failAssetOnce)) {
      this.failAssetOnce = undefined;
      throw new Error("VERIFIER_TEMPORARILY_UNAVAILABLE");
    }
    const results = Object.fromEntries(input.items.map((item) => [item.assetId, this.incomplete ? [] : item.assertionIds.map((assertionId) => {
      const assertion = item.candidate.assertions.find((value) => value.assertionId === assertionId)!;
      return { assertionId, assertionKind: assertion.kind, status: "SUPPORTED" as const, target: `recipe:${assertionId}`,
        observedAt: input.changes.observedAt, reasonCodes: ["SUPPORTED"] };
    })]));
    return { projectId: input.projectId, codeRevision: input.changes.sourceRef,
      observedAt: input.changes.observedAt, results };
  }
}

async function fixture(assetCount = 2) {
  const root = temporary("zhiloop-revalidate-project-");
  const state = temporary("zhiloop-revalidate-state-");
  const git = new FakeGit();
  const source = new GitKnowledgeChangeSource(join(state, "git.sqlite"), { process: git, clock: () => new Date(at) });
  source.observe("project-1", root);
  await source.scan();
  const freshness = new SqliteKnowledgeFreshnessStore(join(state, "freshness.sqlite"));
  const paths: string[] = [];
  for (let index = 1; index <= assetCount; index += 1) {
    const path = `src/file-${index}.ts`;
    paths.push(path);
    freshness.project(projection(`asset-${index}`, path));
  }
  git.status = paths.map((path) => ` M ${path}\0`).join("");
  const change = (await source.scan())[0]!;
  const observation = source.getObservation(change.sourceRef, "project-1")!;
  const input: KnowledgeRevalidateJobInput = { schemaVersion: 1, jobType: "KNOWLEDGE_REVALIDATE", projectId: "project-1",
    repositoryRoot: root, sourceRef: change.sourceRef, changeSetHash: observation.observationHash,
    recipeSelectionHash: "b".repeat(64) };
  return { root, state, git, source, freshness, change, observation, input };
}

describe("KNOWLEDGE_REVALIDATE durable handler", () => {
  it("processes a stable multi-page target set and acknowledges only after all effects", async () => {
    const value = await fixture(3);
    const verifier = new FakeVerifier();
    const runtime = new EvolutionJobRuntime(join(value.state, "jobs.sqlite"), { workerId: "worker-1", handlers: {
      KNOWLEDGE_REVALIDATE: createKnowledgeRevalidateHandler({ source: value.source, store: value.freshness, verifier, pageSize: 1 }),
    } });
    try {
      const enqueued = runtime.enqueue(value.input, 3);
      expect(await runtime.runOnce()).toMatchObject({ status: "SUCCEEDED" });
      expect(verifier.calls).toEqual([["asset-1"], ["asset-2"], ["asset-3"]]);
      expect(value.source.baseline("project-1")?.revision).toBe(2);
      expect(runtime.get(enqueued.job.snapshot.jobId)).toMatchObject({ status: "SUCCEEDED", progress: 1,
        checkpointPhase: "BASELINE_ACKNOWLEDGED" });
      for (let index = 1; index <= 3; index += 1) {
        expect(value.freshness.getState(`asset-${index}`)).toMatchObject({ status: "CONFLICT", codeRevision: value.change.sourceRef });
        expect(value.freshness.listStateEvents(`asset-${index}`, 1)).toHaveLength(1);
      }
    } finally { runtime.close(); value.freshness.close(); value.source.close(); }
  });

  it("resumes after a middle-page failure without duplicating completed effects", async () => {
    const value = await fixture(2);
    const verifier = new FakeVerifier();
    verifier.failAssetOnce = "asset-2";
    let milliseconds = Date.parse(at);
    const jobFile = join(value.state, "jobs.sqlite");
    const options = { clock: () => new Date(milliseconds), random: () => 0,
      retryPolicy: { baseDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 } };
    const handler = createKnowledgeRevalidateHandler({ source: value.source, store: value.freshness, verifier, pageSize: 1 });
    const first = new EvolutionJobRuntime(jobFile, { workerId: "worker-1", handlers: { KNOWLEDGE_REVALIDATE: handler }, store: options });
    first.enqueue(value.input, 3);
    expect(await first.runOnce()).toMatchObject({ status: "RETRY_WAIT" });
    expect(value.source.baseline("project-1")?.revision).toBe(1);
    expect(value.freshness.listStateEvents("asset-1", 1)).toHaveLength(1);
    first.close();
    milliseconds += 10;
    const second = new EvolutionJobRuntime(jobFile, { workerId: "worker-2", handlers: { KNOWLEDGE_REVALIDATE: handler }, store: options });
    try {
      expect(await second.runOnce()).toMatchObject({ status: "SUCCEEDED" });
      expect(verifier.calls).toEqual([["asset-1"], ["asset-2"], ["asset-2"]]);
      expect(value.freshness.listStateEvents("asset-1", 1)).toHaveLength(1);
      expect(value.source.baseline("project-1")?.revision).toBe(2);
    } finally { second.close(); value.freshness.close(); value.source.close(); }
  });

  it("projects RECIPE_MISSING as UNKNOWN and completes without verifier output", async () => {
    const value = await fixture(1);
    const verifier = new FakeVerifier();
    const runtime = new EvolutionJobRuntime(join(value.state, "jobs.sqlite"), { workerId: "worker-1", handlers: {
      KNOWLEDGE_REVALIDATE: createKnowledgeRevalidateHandler({ source: value.source, store: value.freshness, verifier,
        recipes: { resolve: () => undefined } }),
    } });
    try {
      runtime.enqueue(value.input, 2);
      expect(await runtime.runOnce()).toMatchObject({ status: "SUCCEEDED" });
      expect(verifier.calls).toEqual([]);
      expect(value.freshness.getState("asset-1")).toMatchObject({ status: "UNKNOWN", reasonCodes: ["RECIPE_MISSING"] });
      expect(value.source.baseline("project-1")?.revision).toBe(2);
    } finally { runtime.close(); value.freshness.close(); value.source.close(); }
  });

  it("fails terminally on incomplete verification and leaves the baseline recoverable", async () => {
    const value = await fixture(1);
    const verifier = new FakeVerifier();
    verifier.incomplete = true;
    const runtime = new EvolutionJobRuntime(join(value.state, "jobs.sqlite"), { workerId: "worker-1", handlers: {
      KNOWLEDGE_REVALIDATE: createKnowledgeRevalidateHandler({ source: value.source, store: value.freshness, verifier }),
    } });
    try {
      runtime.enqueue(value.input, 2);
      expect(await runtime.runOnce()).toMatchObject({ status: "FAILED", job: { snapshot: {
        lastFailure: { code: "REVALIDATE_INVARIANT_FAILED", retryable: false },
      } } });
      expect(value.source.baseline("project-1")?.revision).toBe(1);
      expect(value.source.listPending()).toHaveLength(1);
    } finally { runtime.close(); value.freshness.close(); value.source.close(); }
  });

  it("recovers when the process fails after a Freshness effect but before its page checkpoint", async () => {
    const value = await fixture(1);
    const verifier = new FakeVerifier();
    let failAfterEffect = true;
    const store = {
      freezeAffectedSnapshot: value.freshness.freezeAffectedSnapshot.bind(value.freshness),
      getAffectedSnapshot: value.freshness.getAffectedSnapshot.bind(value.freshness),
      readAffectedSnapshotPage: value.freshness.readAffectedSnapshotPage.bind(value.freshness),
      get: value.freshness.get.bind(value.freshness), getState: value.freshness.getState.bind(value.freshness),
      transitionWithEffect: (...args: Parameters<SqliteKnowledgeFreshnessStore["transitionWithEffect"]>) => {
        const result = value.freshness.transitionWithEffect(...args);
        if (failAfterEffect) { failAfterEffect = false; throw new Error("PROCESS_EXIT_AFTER_EFFECT"); }
        return result;
      },
    };
    let milliseconds = Date.parse(at);
    const runtime = new EvolutionJobRuntime(join(value.state, "jobs.sqlite"), { workerId: "worker-1", handlers: {
      KNOWLEDGE_REVALIDATE: createKnowledgeRevalidateHandler({ source: value.source, store, verifier }),
    }, store: { clock: () => new Date(milliseconds), random: () => 0,
      retryPolicy: { baseDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 } } });
    try {
      runtime.enqueue(value.input, 3);
      expect(await runtime.runOnce()).toMatchObject({ status: "RETRY_WAIT" });
      expect(value.freshness.listStateEvents("asset-1", 1)).toHaveLength(1);
      expect(value.source.baseline("project-1")?.revision).toBe(1);
      milliseconds += 10;
      expect(await runtime.runOnce()).toMatchObject({ status: "SUCCEEDED" });
      expect(value.freshness.listStateEvents("asset-1", 1)).toHaveLength(1);
      expect(value.source.baseline("project-1")?.revision).toBe(2);
    } finally { runtime.close(); value.freshness.close(); value.source.close(); }
  });

  it("recovers when baseline acknowledgement commits before the job checkpoint", async () => {
    const value = await fixture(1);
    const verifier = new FakeVerifier();
    let failAfterAcknowledgement = true;
    const source = {
      getObservation: value.source.getObservation.bind(value.source),
      changeSet: value.source.changeSet.bind(value.source),
      acknowledgeSource: (...args: Parameters<GitKnowledgeChangeSource["acknowledgeSource"]>) => {
        const result = value.source.acknowledgeSource(...args);
        if (failAfterAcknowledgement) { failAfterAcknowledgement = false; throw new Error("PROCESS_EXIT_AFTER_ACK"); }
        return result;
      },
    };
    let milliseconds = Date.parse(at);
    const runtime = new EvolutionJobRuntime(join(value.state, "jobs.sqlite"), { workerId: "worker-1", handlers: {
      KNOWLEDGE_REVALIDATE: createKnowledgeRevalidateHandler({ source, store: value.freshness, verifier }),
    }, store: { clock: () => new Date(milliseconds), random: () => 0,
      retryPolicy: { baseDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 } } });
    try {
      runtime.enqueue(value.input, 3);
      expect(await runtime.runOnce()).toMatchObject({ status: "RETRY_WAIT" });
      expect(value.source.baseline("project-1")?.revision).toBe(2);
      milliseconds += 10;
      expect(await runtime.runOnce()).toMatchObject({ status: "SUCCEEDED" });
      expect(value.source.baseline("project-1")?.revision).toBe(2);
      expect(value.freshness.listStateEvents("asset-1", 1)).toHaveLength(1);
    } finally { runtime.close(); value.freshness.close(); value.source.close(); }
  });

  it("does not acknowledge or inject an old revision when the repository changes during verification", async () => {
    const value = await fixture(1);
    let changed = false;
    const verifier: FreshnessRevalidationPort = { verifyBatch: async () => {
      if (!changed) {
        changed = true;
        value.git.status = " M src/newer.ts\0";
        await value.source.scan();
      }
      throw new Error("FRESHNESS_VERIFICATION_REVISION_MISMATCH");
    } };
    const runtime = new EvolutionJobRuntime(join(value.state, "jobs.sqlite"), { workerId: "worker-1", handlers: {
      KNOWLEDGE_REVALIDATE: createKnowledgeRevalidateHandler({ source: value.source, store: value.freshness, verifier }),
    } });
    try {
      runtime.enqueue(value.input, 3);
      expect(await runtime.runOnce()).toMatchObject({ status: "FAILED", job: { snapshot: {
        lastFailure: { code: "REVALIDATE_INVARIANT_FAILED", retryable: false },
      } } });
      expect(value.source.baseline("project-1")?.revision).toBe(1);
      expect(value.source.listPending()).toHaveLength(2);
      expect(value.freshness.listStateEvents("asset-1", 1)).toEqual([]);
    } finally { runtime.close(); value.freshness.close(); value.source.close(); }
  });
});
