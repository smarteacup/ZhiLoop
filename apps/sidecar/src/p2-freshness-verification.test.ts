import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { KnowledgeAsset, KnowledgeCandidate } from "@zhiloop/domain";
import { SqliteKnowledgeFreshnessStore } from "@zhiloop/knowledge-freshness";
import {
  GitProjectRevisionPort,
  KnowledgeVerificationService,
  SqliteKnowledgeVerificationStore,
  type KnowledgeVerificationBatch,
} from "@zhiloop/knowledge-verification";

import { GitKnowledgeChangeSource, P2FreshnessRuntime, ProductionFreshnessVerifier } from "./p2-freshness-runtime.js";

const cleanup: string[] = [];
const at = "2026-08-19T00:00:00.000Z";
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
afterEach(() => { for (const root of cleanup.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("P2 Freshness shared production verifier", () => {
  it("rejects invalid Git change-source lifecycle operations", async () => {
    const source = new GitKnowledgeChangeSource(":memory:");
    expect(() => source.observe("", "/tmp/project")).toThrow("GIT_CHANGESET_PROJECT_INVALID");
    expect(() => source.observe("project-1", "relative/project")).toThrow("GIT_CHANGESET_PROJECT_INVALID");
    source.observe("project-1", "/tmp/project-a");
    source.observe("project-1", "/tmp/project-a");
    expect(() => source.observe("project-1", "/tmp/project-b")).toThrow("GIT_CHANGESET_PROJECT_ROOT_CONFLICT");
    expect(() => source.acknowledge({ projectId: "project-1", changedPaths: ["a.ts"], changedSymbols: [], changedConfigs: [],
      changedDependencies: [], sourceRef: "git:missing", observedAt: at })).toThrow("GIT_CHANGESET_ACK_CONFLICT");
    source.close();
    source.close();
    expect(() => source.observe("project-2", "/tmp/project-a")).toThrow("Git change source is closed");
    await expect(source.scan()).rejects.toThrow("Git change source is closed");
  });

  it("bounds batch concurrency while avoiding serial verification", async () => {
    let active = 0;
    let peak = 0;
    let calls = 0;
    const verifier = new ProductionFreshnessVerifier({
      verifyBatch: async (request): Promise<KnowledgeVerificationBatch> => {
        calls += 1;
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { schemaVersion: 1, runId: `run-${calls}`, requestId: `request-${calls}`, purpose: request.purpose,
          projectId: request.project.projectId, codeRevision: "git:head:status", codeRevisionCapability: "READY",
          observedAt: request.requestedAt, results: [] };
      },
    });
    verifier.observe("project-1", "/tmp/project-1");
    const candidate: KnowledgeCandidate = { schemaVersion: 1, candidateId: "candidate-1", compilerVersion: "compiler-v1", status: "PROPOSED",
      subjectKey: "implementation.runtime.file", kind: "IMPLEMENTATION", scopeHint: { level: "PROJECT", projectId: "project-1", reasonCodes: [] },
      title: "Runtime file", summary: "Track runtime", body: "Runtime", sourceEpisodes: ["episode-1"], confidence: 0.9,
      assertions: [{ assertionId: "assertion-1", candidateId: "candidate-1", kind: "FILE_CONTAINS",
        parameters: { path: "runtime.txt", expected: "Runtime", matchMode: "EXACT" }, createdAt: at }],
      evidenceHints: [], createdAt: at, correlationId: "correlation-1" };
    const items = Array.from({ length: 9 }, (_, index) => ({ assetId: `asset-${index}`, assetVersion: 1, candidate, assertionIds: [] }));
    await verifier.verifyBatch({ projectId: "project-1", changes: { projectId: "project-1", changedPaths: ["runtime.txt"],
      changedSymbols: [], changedConfigs: [], changedDependencies: [], sourceRef: "git:head:status", observedAt: at }, items });
    expect(calls).toBe(9);
    expect(peak).toBe(4);
  });

  it("revalidates a changed file through the shared service and records a conflict without re-executing anything", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "zhiloop-freshness-verification-repo-"));
    const state = mkdtempSync(path.join(tmpdir(), "zhiloop-freshness-verification-state-"));
    cleanup.push(root, state);
    writeFileSync(path.join(root, "runtime.txt"), "value=1\n");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["add", "runtime.txt"], { cwd: root });
    execFileSync("git", ["-c", "user.name=ZhiLoop", "-c", "user.email=zhiloop@example.invalid", "commit", "-m", "baseline"], { cwd: root, stdio: "ignore" });
    const project = { projectId: "project-1", repositoryRoot: root, portable: false } as const;
    const candidate: KnowledgeCandidate = { schemaVersion: 1, candidateId: "candidate-1", compilerVersion: "compiler-v1", status: "PROPOSED",
      subjectKey: "implementation.runtime.file", kind: "IMPLEMENTATION", scopeHint: { level: "PROJECT", projectId: "project-1", reasonCodes: [] },
      title: "Runtime file", summary: "Track the current value", body: "value remains one", sourceEpisodes: ["episode-1"], confidence: 0.9,
      assertions: [{ assertionId: "assertion-file", candidateId: "candidate-1", kind: "FILE_CONTAINS",
        parameters: { path: "runtime.txt", expected: "value=1", matchMode: "EXACT" }, createdAt: at }], evidenceHints: [],
      createdAt: at, correlationId: "correlation-1" };
    const asset: KnowledgeAsset = { schemaVersion: 1, id: "asset-1", subjectKey: candidate.subjectKey, kind: candidate.kind,
      scope: { level: "PROJECT", projectId: "project-1" }, version: 1, status: "IMPLEMENTED", title: candidate.title, summary: candidate.summary,
      body: candidate.body, aliases: [], keywords: [], applicability: [], nonApplicability: [], symbols: [], relations: [], evidence: [], confidence: 0.9,
      sourceEpisodes: ["episode-1"], contentHash: sha("asset"), correlationId: candidate.correlationId, createdAt: at, updatedAt: at };
    const verificationStore = new SqliteKnowledgeVerificationStore(path.join(state, "knowledge-verification.sqlite"));
    const verification = new KnowledgeVerificationService({ revisions: new GitProjectRevisionPort(), store: verificationStore, timeoutMs: 5_000 });
    const baseline = await verification.verify({ candidate, project, requestedAt: at, purpose: "CANDIDATE" });
    const freshnessStore = new SqliteKnowledgeFreshnessStore(path.join(state, "knowledge-freshness.sqlite"));
    freshnessStore.project({ asset: { ...asset, evidence: baseline.flatMap((item) => item.evidence === undefined ? []
      : [{ evidenceId: item.evidence.evidenceId, verdict: item.evidence.verdict }]) }, candidate, verificationResults: baseline,
      projectId: "project-1", observedAt: at });
    const runtime = new P2FreshnessRuntime({ statePath: path.join(state, "git-baseline.sqlite"), store: freshnessStore, verification,
      configuration: { enabled: true, changeDebounceMs: 100, fallbackScanIntervalMs: 10_000, maxAffectedPerJob: 10 } });
    try {
      runtime.observeProject("project-1", root);
      await runtime.trigger();
      writeFileSync(path.join(root, "runtime.txt"), "value=2\n");
      await runtime.trigger();
      expect(freshnessStore.getState("asset-1")).toMatchObject({ status: "CONFLICT", affectedAssertionIds: ["assertion-file"] });
      expect(runtime.state()).toMatchObject({ completedRuns: 1, failedRuns: 0 });
    } finally {
      await runtime.close(); freshnessStore.close(); verificationStore.close();
    }
  });

  it("keeps knowledge unchanged and degrades the runtime when verification fails", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "zhiloop-freshness-failure-repo-"));
    const state = mkdtempSync(path.join(tmpdir(), "zhiloop-freshness-failure-state-"));
    cleanup.push(root, state);
    writeFileSync(path.join(root, "runtime.txt"), "value=1\n");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["add", "runtime.txt"], { cwd: root });
    execFileSync("git", ["-c", "user.name=ZhiLoop", "-c", "user.email=zhiloop@example.invalid", "commit", "-m", "baseline"], { cwd: root, stdio: "ignore" });
    const candidate: KnowledgeCandidate = { schemaVersion: 1, candidateId: "candidate-failure", compilerVersion: "compiler-v1", status: "PROPOSED",
      subjectKey: "implementation.runtime.failure", kind: "IMPLEMENTATION", scopeHint: { level: "PROJECT", projectId: "project-1", reasonCodes: [] },
      title: "Runtime file", summary: "Track the current value", body: "value remains one", sourceEpisodes: ["episode-1"], confidence: 0.9,
      assertions: [{ assertionId: "assertion-failure", candidateId: "candidate-failure", kind: "FILE_CONTAINS",
        parameters: { path: "runtime.txt", expected: "value=1", matchMode: "EXACT" }, createdAt: at }], evidenceHints: [],
      createdAt: at, correlationId: "correlation-failure" };
    const evidence = { evidenceId: "evidence-failure", assertionId: "assertion-failure", type: "FILE_CONTENT" as const,
      verdict: "SUPPORTS" as const, sourceRef: "file:runtime.txt", projectId: "project-1", observedAt: at,
      correlationId: candidate.correlationId };
    const asset: KnowledgeAsset = { schemaVersion: 1, id: "asset-failure", subjectKey: candidate.subjectKey, kind: candidate.kind,
      scope: { level: "PROJECT", projectId: "project-1" }, version: 1, status: "IMPLEMENTED", title: candidate.title, summary: candidate.summary,
      body: candidate.body, aliases: [], keywords: [], applicability: [], nonApplicability: [], symbols: [], relations: [], evidence: [evidence],
      confidence: 0.9, sourceEpisodes: ["episode-1"], contentHash: sha("failure-asset"), correlationId: candidate.correlationId,
      createdAt: at, updatedAt: at };
    const freshnessStore = new SqliteKnowledgeFreshnessStore(path.join(state, "knowledge-freshness.sqlite"));
    freshnessStore.project({ asset, candidate, verificationResults: [{ assertionId: "assertion-failure", assertionKind: "FILE_CONTAINS",
      verifierId: "repository-file-v1", status: "SUPPORTED", target: "file:runtime.txt", observedAt: at,
      reasonCodes: ["FILE_CONTENT_MATCHED"], evidence }], projectId: "project-1", observedAt: at });
    const runtime = new P2FreshnessRuntime({ statePath: path.join(state, "git-baseline.sqlite"), store: freshnessStore,
      verification: { verifyBatch: async () => { throw new Error("verification unavailable"); } },
      configuration: { enabled: true, changeDebounceMs: 100, fallbackScanIntervalMs: 10_000, maxAffectedPerJob: 10 } });
    try {
      runtime.start();
      runtime.observeProject("project-1", root);
      await runtime.trigger();
      const before = freshnessStore.getState("asset-failure");
      writeFileSync(path.join(root, "runtime.txt"), "value=2\n");
      await runtime.trigger();
      expect(runtime.state()).toMatchObject({ status: "DEGRADED", failedRuns: 1, pendingProjects: 1 });
      expect(freshnessStore.getState("asset-failure")).toEqual(before);
    } finally {
      await runtime.close(); freshnessStore.close();
    }
  });
});
