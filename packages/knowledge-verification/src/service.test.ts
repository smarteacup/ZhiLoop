import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CodeIntelligenceCapability, CodeIntelligencePort } from "@zhiloop/code-intelligence";
import type { LedgerEventRecord } from "@zhiloop/conversation-ledger";
import type { EventEnvelope, KnowledgeAssertion, KnowledgeCandidate, ProjectContext } from "@zhiloop/domain";
import { snapshotCommandHash, snapshotTestId } from "@zhiloop/evidence-probes";

import { KnowledgeVerificationError, KnowledgeVerificationService } from "./service.js";
import type {
  KnowledgeVerificationRunSummary,
  KnowledgeVerificationStore,
  ProjectRevisionPort,
  StoredVerificationRecipe,
  SupportingProofRef,
} from "./types.js";

const time = "2026-08-19T00:00:00.000Z";
const cleanup: string[] = [];

afterEach(() => { for (const root of cleanup.splice(0)) rmSync(root, { recursive: true, force: true }); });

class MemoryStore implements KnowledgeVerificationStore {
  readonly runs: KnowledgeVerificationRunSummary[] = [];
  proofs: SupportingProofRef[] = [];
  saveRecipe(): StoredVerificationRecipe { throw new Error("not used"); }
  getRecipe(): StoredVerificationRecipe | undefined { return undefined; }
  appendRun(summary: KnowledgeVerificationRunSummary): KnowledgeVerificationRunSummary { this.runs.push(summary); return summary; }
  getRun(): KnowledgeVerificationRunSummary | undefined { return undefined; }
  listRuns(): readonly KnowledgeVerificationRunSummary[] { return this.runs; }
  listSupportingProofs(): readonly SupportingProofRef[] { return this.proofs; }
}

class ScriptedRevisions implements ProjectRevisionPort {
  constructor(private readonly revisions: string[]) {}
  async capture() { const revision = this.revisions.shift(); if (revision === undefined) throw new Error("unexpected revision call");
    return { revision, capability: "READY" as const, reasonCode: "GIT_REVISION_READY" }; }
}

function codePort(capabilities?: CodeIntelligenceCapability[]): CodeIntelligencePort {
  const ready: CodeIntelligenceCapability = { provider: "CODEGRAPH", status: "READY", reasonCode: "CODEGRAPH_READY",
    providerVersion: "0.9.4", indexRevision: `cg_${"a".repeat(64)}` };
  const queue = capabilities ?? [];
  return {
    capabilities: async () => queue.shift() ?? ready,
    findSymbols: async () => ({ capability: ready, facts: [{ symbol: "Runtime", qualifiedName: "Runtime", kind: "class",
      path: "src/runtime.ts", startLine: 1, endLine: 5, language: "typescript", exported: true }] }),
    callers: async () => ({ capability: ready, facts: [] }),
    trace: async () => ({ capability: ready, facts: [{ from: "entry", to: "leaf", symbols: ["entry", "leaf"], paths: ["src/runtime.ts"] }] }),
    impact: async () => ({ capability: ready, facts: [{ symbol: "Consumer", kind: "class", path: "src/consumer.ts", startLine: 1 }] }),
  };
}

function ledger(sequence: number, eventType: EventEnvelope["eventType"], payload: unknown, eventId: string): LedgerEventRecord {
  return { sequence, storedPayloadHash: "b".repeat(64), redactionCount: 0, payloadPurged: false, insertedAt: time,
    event: { schemaVersion: 1, eventId, source: "codex-app-server", eventType, sessionId: "session-1", occurredAt: time,
      contentHash: "c".repeat(64), correlationId: "correlation-1", payload } };
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "zhiloop-verification-service-")); cleanup.push(root);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { typescript: "6.0.3" } }));
  writeFileSync(path.join(root, "config.json"), JSON.stringify({ retry: 3 }));
  writeFileSync(path.join(root, "fact.txt"), "production evidence hub");
  const project: ProjectContext = { projectId: "project-1", repositoryRoot: root, portable: false };
  const commandHash = snapshotCommandHash("npm test")!;
  const drafts: Array<Omit<KnowledgeAssertion, "assertionId" | "candidateId" | "createdAt">> = [
    { kind: "USER_ACCEPTED", parameters: { statementRef: "statement-1" } },
    { kind: "SYMBOL_EXISTS", parameters: { projectId: "project-1", symbol: "Runtime", path: "src/runtime.ts" } },
    { kind: "CALL_PATH_EXISTS", parameters: { projectId: "project-1", from: "entry", to: "leaf", maxDepth: 3 } },
    { kind: "IMPACT_CONTAINS", parameters: { projectId: "project-1", symbol: "Runtime", impactedSymbol: "Consumer" } },
    { kind: "FILE_CONTAINS", parameters: { path: "fact.txt", expected: "evidence hub", matchMode: "EXACT" } },
    { kind: "DEPENDENCY_PRESENT", parameters: { name: "typescript", versionConstraint: "6.0.3", manifestPath: "package.json" } },
    { kind: "CONFIG_EQUALS", parameters: { key: "retry", expected: "3", path: "config.json" } },
    { kind: "COMMAND_SUCCEEDED", parameters: { commandHash, expectedExitCode: 0 } },
    { kind: "TEST_PASSED", parameters: { testId: snapshotTestId(commandHash), commandHash } },
    { kind: "CROSS_PROJECT_VERIFIED", parameters: { subjectKey: "design.runtime.verification", minimumProjects: 2 } },
  ];
  const assertions = drafts.map((item, index) => ({ ...item, assertionId: `assertion-${index + 1}`, candidateId: "candidate-1", createdAt: time })) as [KnowledgeAssertion, ...KnowledgeAssertion[]];
  const candidate = { schemaVersion: 1, candidateId: "candidate-1", compilerVersion: "compiler-v1", status: "PROPOSED",
    subjectKey: "design.runtime.verification", kind: "IMPLEMENTATION", scopeHint: { level: "PROJECT", projectId: "project-1", reasonCodes: [] },
    title: "Verification", summary: "Evidence", body: "Body must not be persisted in runs", sourceEpisodes: ["episode-1"],
    confidence: 0.9, createdAt: time, correlationId: "correlation-1", assertions, evidenceHints: [] } as KnowledgeCandidate;
  return { root, project, candidate, commandHash };
}

describe("KnowledgeVerificationService", () => {
  it("returns exactly one result for every assertion kind and persists only a bounded summary", async () => {
    const { project, candidate } = fixture();
    const revision = `git:${"a".repeat(40)}:${"b".repeat(64)}`;
    const store = new MemoryStore();
    store.proofs = [
      { runId: "prior-1", canonicalProjectId: "project-1", knowledgeVersion: { assetId: "a-1", assetVersion: 1 }, completedAt: time },
      { runId: "prior-2", canonicalProjectId: "project-2", knowledgeVersion: { assetId: "a-2", assetVersion: 1 }, completedAt: time },
    ];
    const service = new KnowledgeVerificationService({ revisions: new ScriptedRevisions([revision, revision]), store,
      codeIntelligence: codePort(), crossProject: { store, eligibility: { classify: () => "CURRENT" } } });
    const results = await service.verify({ candidate, project, requestedAt: time, purpose: "FRESHNESS",
      knowledgeVersion: { assetId: "asset-1", assetVersion: 1 }, snapshot: { snapshotId: "snapshot-1", sourceVersion: "v1",
        contentHash: createHash("sha256").update("snapshot").digest("hex"), records: [
          ledger(1, "user.prompted", { prompt: "确认" }, "statement-1"),
          ledger(2, "tool.completed", { toolName: "commandExecution", toolInput: { command: "npm test" }, toolResponse: { exitCode: 0, aggregatedOutput: "secret" } }, "tool-1"),
        ] } });
    expect(results).toHaveLength(candidate.assertions.length);
    expect(new Set(results.map((item) => item.assertionKind))).toEqual(new Set(candidate.assertions.map((item) => item.kind)));
    expect(results.filter((item) => item.status !== "SUPPORTED").map((item) => ({ kind: item.assertionKind, status: item.status,
      reasons: item.reasonCodes, target: item.target, evidence: item.evidence }))).toEqual([]);
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({ qualifyingProof: true, codeRevision: revision, graphRevision: expect.stringMatching(/^cg_/u) });
    expect(JSON.stringify(store.runs[0])).not.toMatch(/Body must not|aggregatedOutput|secret/u);
  });

  it("uses assertion selection and keeps historical command/test facts UNKNOWN without a Snapshot", async () => {
    const { project, candidate } = fixture();
    const revision = `git:${"a".repeat(40)}:${"b".repeat(64)}`;
    const store = new MemoryStore();
    const service = new KnowledgeVerificationService({ revisions: new ScriptedRevisions([revision, revision]), store });
    const selected = candidate.assertions.filter((item) => item.kind === "COMMAND_SUCCEEDED" || item.kind === "TEST_PASSED").map((item) => item.assertionId);
    const results = await service.verify({ candidate, project, requestedAt: time, purpose: "FRESHNESS", assertionIds: selected });
    expect(results.map((item) => item.status)).toEqual(["UNKNOWN", "UNKNOWN"]);
    expect(store.runs[0]?.qualifyingProof).toBe(false);
  });

  it("degrades unavailable graph assertions independently from readable local facts", async () => {
    const { project, candidate } = fixture();
    const revision = `git:${"a".repeat(40)}:${"b".repeat(64)}`;
    const store = new MemoryStore();
    const unavailable: CodeIntelligenceCapability = { provider: "CODEGRAPH", status: "UNAVAILABLE", reasonCode: "CODEGRAPH_UNAVAILABLE" };
    const port = codePort([unavailable, unavailable]);
    port.findSymbols = async () => ({ capability: unavailable, facts: [] });
    const service = new KnowledgeVerificationService({ revisions: new ScriptedRevisions([revision, revision]), store, codeIntelligence: port });
    const selected = candidate.assertions.filter((item) => item.kind === "SYMBOL_EXISTS" || item.kind === "FILE_CONTAINS").map((item) => item.assertionId);
    const results = await service.verify({ candidate, project, requestedAt: time, purpose: "CANDIDATE", assertionIds: selected });
    expect(results.map((item) => [item.assertionKind, item.status])).toEqual([["SYMBOL_EXISTS", "UNKNOWN"], ["FILE_CONTAINS", "SUPPORTED"]]);
  });

  it("rejects code or graph revision drift before persistence", async () => {
    const { project, candidate } = fixture();
    const first = `git:${"a".repeat(40)}:${"b".repeat(64)}`;
    const second = `git:${"a".repeat(40)}:${"c".repeat(64)}`;
    const store = new MemoryStore();
    const codeDrift = new KnowledgeVerificationService({ revisions: new ScriptedRevisions([first, second]), store });
    await expect(codeDrift.verify({ candidate, project, requestedAt: time, purpose: "CANDIDATE",
      assertionIds: [candidate.assertions.find((item) => item.kind === "FILE_CONTAINS")!.assertionId] }))
      .rejects.toMatchObject({ code: "CODE_REVISION_CHANGED", retryable: true });
    const graphStore = new MemoryStore();
    const ready = (revision: string): CodeIntelligenceCapability => ({ provider: "CODEGRAPH", status: "READY", reasonCode: "CODEGRAPH_READY", indexRevision: revision });
    const graphDrift = new KnowledgeVerificationService({ revisions: new ScriptedRevisions([first, first]), store: graphStore,
      codeIntelligence: codePort([ready("cg_one"), ready("cg_two")]) });
    await expect(graphDrift.verify({ candidate, project, requestedAt: time, purpose: "CANDIDATE",
      assertionIds: [candidate.assertions.find((item) => item.kind === "SYMBOL_EXISTS")!.assertionId] }))
      .rejects.toMatchObject({ code: "GRAPH_REVISION_CHANGED", retryable: true });
    expect(store.runs).toHaveLength(0);
    expect(graphStore.runs).toHaveLength(0);
  });

  it("uses a new verification identity when the observed code revision changes between retries", async () => {
    const { project, candidate } = fixture();
    const first = `git:${"a".repeat(40)}:${"b".repeat(64)}`;
    const second = `git:${"a".repeat(40)}:${"c".repeat(64)}`;
    const store = new MemoryStore();
    const service = new KnowledgeVerificationService({
      revisions: new ScriptedRevisions([first, first, second, second]),
      store,
    });
    const assertionId = candidate.assertions.find((item) => item.kind === "FILE_CONTAINS")!.assertionId;
    const request = { candidate, project, requestedAt: time, purpose: "CANDIDATE" as const, assertionIds: [assertionId] };

    const initial = await service.verifyBatch(request);
    const retried = await service.verifyBatch(request);

    expect(initial.codeRevision).toBe(first);
    expect(retried.codeRevision).toBe(second);
    expect(retried.requestId).not.toBe(initial.requestId);
    expect(retried.runId).not.toBe(initial.runId);
    expect(store.runs).toHaveLength(2);
  });

  it("honors cancellation and deadline before durable append", async () => {
    const { project, candidate } = fixture();
    const revision = `git:${"a".repeat(40)}:${"b".repeat(64)}`;
    const store = new MemoryStore();
    const controller = new AbortController(); controller.abort();
    const service = new KnowledgeVerificationService({ revisions: new ScriptedRevisions([revision]), store });
    await expect(service.verify({ candidate, project, requestedAt: time, purpose: "CANDIDATE" }, { signal: controller.signal }))
      .rejects.toBeInstanceOf(KnowledgeVerificationError);
    await expect(service.verify({ candidate, project, requestedAt: time, purpose: "CANDIDATE" }, { deadlineAt: "1970-01-01T00:00:00.000Z" }))
      .rejects.toMatchObject({ code: "VERIFICATION_DEADLINE_EXCEEDED" });
    expect(store.runs).toHaveLength(0);
  });

  it("applies a default total timeout to a hanging proof dependency", async () => {
    const { project, candidate } = fixture();
    const revision = `git:${"a".repeat(40)}:${"b".repeat(64)}`;
    const store = new MemoryStore();
    store.proofs = [{ runId: "prior-1", canonicalProjectId: "project-1", knowledgeVersion: { assetId: "a-1", assetVersion: 1 }, completedAt: time }];
    const service = new KnowledgeVerificationService({ revisions: new ScriptedRevisions([revision]), store, timeoutMs: 10,
      crossProject: { store, eligibility: { classify: async () => new Promise(() => undefined) } } });
    const assertionId = candidate.assertions.find((item) => item.kind === "CROSS_PROJECT_VERIFIED")!.assertionId;
    await expect(service.verify({ candidate, project, requestedAt: time, purpose: "CANDIDATE", assertionIds: [assertionId] }))
      .rejects.toMatchObject({ code: "VERIFICATION_DEADLINE_EXCEEDED", retryable: true });
    expect(store.runs).toHaveLength(0);
  });
});
