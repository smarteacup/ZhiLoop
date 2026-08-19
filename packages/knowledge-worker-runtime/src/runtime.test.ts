import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIGURATION } from "@zhiloop/config";
import type { LedgerEventRecord } from "@zhiloop/conversation-ledger";
import type { Episode, EventEnvelope, KnowledgeAsset, KnowledgeKind } from "@zhiloop/domain";
import type { VerificationResult } from "@zhiloop/evidence-engine";
import type { IncrementalIndexResult } from "@zhiloop/knowledge-indexer";
import type { ProjectionWriteResult } from "@zhiloop/knowledge-registry";
import type {
  MarkdownPublishOptions,
  MarkdownPublishResult,
  MarkdownReadResult,
  StoredKnowledgeVersion,
} from "@zhiloop/markdown-repository";

import { SqliteKnowledgeWorkerCheckpointStore } from "./checkpoint-store.js";
import { KnowledgeWorkerError } from "./errors.js";
import { KnowledgeWorkerRuntime } from "./runtime.js";
import type {
  EvidenceVerificationPort,
  FreshnessProjectionPort,
  IncrementalIndexPort,
  KnowledgeWorkerCheckpoint,
  KnowledgeWorkerCheckpointStore,
  KnowledgeWorkerPorts,
  KnowledgeWorkerRunOptions,
  KnowledgeWorkerRunRequest,
  LedgerSnapshotPort,
  MarkdownKnowledgePort,
  RegistryProjectionPort,
} from "./types.js";
import type { KnowledgeExtractionInput } from "@zhiloop/knowledge-compiler";

const tempDirectories: string[] = [];
afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function ledgerRecords(): readonly LedgerEventRecord[] {
  const fixtures = [
    { eventType: "session.started" as const, payload: { kind: "session-started" }, cwd: "/workspace/repo" },
    {
      eventType: "user.prompted" as const,
      turnId: "turn-1",
      payload: { kind: "user-prompt", prompt: "采用当前运行时设计方案" },
    },
    {
      eventType: "turn.stopped" as const,
      turnId: "turn-1",
      payload: { kind: "turn-stopped", stopHookActive: false, lastAssistantMessage: "设计已确认" },
    },
    { eventType: "session.ended" as const, payload: { kind: "session-ended" } },
  ];
  return fixtures.map((fixture, index): LedgerEventRecord => {
    const occurredAt = new Date(Date.UTC(2026, 7, 1, 8, 0, index)).toISOString();
    const event: EventEnvelope = {
      schemaVersion: 1,
      eventId: sha256(`event:${index}`),
      source: "codex-hook",
      sourceItemId: `source-${index}`,
      eventType: fixture.eventType,
      sessionId: "session-1",
      ...(fixture.turnId === undefined ? {} : { turnId: fixture.turnId }),
      occurredAt,
      ...(fixture.cwd === undefined ? {} : { cwd: fixture.cwd }),
      contentHash: sha256(`content:${index}`),
      correlationId: sha256("session-1"),
      payload: fixture.payload,
    };
    return {
      sequence: index + 1,
      event,
      storedPayloadHash: sha256(JSON.stringify(event.payload)),
      redactionCount: 0,
      payloadPurged: false,
      insertedAt: occurredAt,
    };
  });
}

function commitmentLedgerRecords(statementText: string): readonly LedgerEventRecord[] {
  const fixtures = [
    { eventType: "session.started" as const, payload: { kind: "session-started" }, cwd: "/workspace/repo" },
    {
      eventType: "user.prompted" as const,
      turnId: "turn-1",
      payload: { kind: "user-prompt", prompt: "选择运行时设计" },
    },
    {
      eventType: "turn.stopped" as const,
      turnId: "turn-1",
      payload: { kind: "turn-stopped", stopHookActive: false, lastAssistantMessage: "建议使用可恢复阶段机" },
    },
    {
      eventType: "user.prompted" as const,
      turnId: "turn-2",
      payload: { kind: "user-prompt", prompt: statementText },
    },
    {
      eventType: "turn.stopped" as const,
      turnId: "turn-2",
      payload: { kind: "turn-stopped", stopHookActive: false, lastAssistantMessage: "收到" },
    },
    { eventType: "session.ended" as const, payload: { kind: "session-ended" } },
  ];
  return fixtures.map((fixture, index): LedgerEventRecord => {
    const occurredAt = new Date(Date.UTC(2026, 7, 2, 8, 0, index)).toISOString();
    const event: EventEnvelope = {
      schemaVersion: 1,
      eventId: sha256(`commitment-event:${statementText}:${index}`),
      source: "codex-hook",
      sourceItemId: `commitment-source-${index}`,
      eventType: fixture.eventType,
      sessionId: "session-1",
      ...(fixture.turnId === undefined ? {} : { turnId: fixture.turnId }),
      occurredAt,
      ...(fixture.cwd === undefined ? {} : { cwd: fixture.cwd }),
      contentHash: sha256(`commitment-content:${statementText}:${index}`),
      correlationId: sha256("session-1"),
      payload: fixture.payload,
    };
    return {
      sequence: index + 1,
      event,
      storedPayloadHash: sha256(JSON.stringify(event.payload)),
      redactionCount: 0,
      payloadPurged: false,
      insertedAt: occurredAt,
    };
  });
}

function snapshotLedger(records: readonly LedgerEventRecord[]): LedgerSnapshotPort {
  const contentHash = sha256(JSON.stringify(records));
  return {
    loadSnapshot: async () => ({ snapshotId: "snapshot-1", sourceVersion: "v1", contentHash, records }),
    inspectSnapshot: async () => ({ snapshotId: "snapshot-1", sourceVersion: "v1", contentHash }),
  };
}

class MemoryCheckpointStore implements KnowledgeWorkerCheckpointStore {
  checkpoint?: KnowledgeWorkerCheckpoint;

  load(): KnowledgeWorkerCheckpoint | undefined {
    return this.checkpoint === undefined ? undefined : structuredClone(this.checkpoint);
  }

  create(checkpoint: KnowledgeWorkerCheckpoint): void {
    if (this.checkpoint !== undefined) throw new Error("duplicate checkpoint");
    this.checkpoint = structuredClone(checkpoint);
  }

  save(checkpoint: KnowledgeWorkerCheckpoint, expectedRevision: number): void {
    if (this.checkpoint?.revision !== expectedRevision) throw new Error("revision conflict");
    this.checkpoint = structuredClone(checkpoint);
  }
}

class FaultCheckpointStore extends MemoryCheckpointStore {
  failAfterMarkdownOnce = true;

  override save(checkpoint: KnowledgeWorkerCheckpoint, expectedRevision: number): void {
    if (this.failAfterMarkdownOnce && checkpoint.payload.outbox?.some((item) => item.markdown !== undefined) === true) {
      this.failAfterMarkdownOnce = false;
      throw new Error("simulated crash before Markdown checkpoint commit");
    }
    super.save(checkpoint, expectedRevision);
  }
}

class MemoryMarkdown implements MarkdownKnowledgePort {
  readonly current = new Map<string, StoredKnowledgeVersion>();
  publishCalls = 0;
  fail?: () => never;

  readCurrent(assetId: string): MarkdownReadResult {
    const value = this.current.get(assetId);
    if (value !== undefined) return { ok: true, value };
    return {
      ok: false,
      error: { code: "NOT_FOUND", message: "not found", path: assetId, issues: [] },
    };
  }

  listAssetIds(): readonly string[] {
    return [...this.current.keys(), ...this.current.keys()];
  }

  publish(asset: KnowledgeAsset, options: MarkdownPublishOptions = {}): MarkdownPublishResult {
    this.publishCalls += 1;
    this.fail?.();
    const existing = this.current.get(asset.id);
    if (existing?.asset.version === asset.version && existing.asset.contentHash === asset.contentHash) {
      return { status: "IDEMPOTENT", value: existing };
    }
    if (existing?.asset.version !== options.expectedCurrentVersion) throw new Error("version conflict");
    const value: StoredKnowledgeVersion = {
      asset,
      tombstone: false,
      historyState: "COMMITTED",
      documentPath: `/knowledge/${asset.id}/current.md`,
    };
    this.current.set(asset.id, value);
    return { status: "PUBLISHED", value };
  }
}

class MemoryRegistry implements RegistryProjectionPort {
  readonly versions = new Map<string, number>();
  calls = 0;
  fail?: () => never;

  projectCurrent(record: StoredKnowledgeVersion): ProjectionWriteResult {
    this.calls += 1;
    this.fail?.();
    const previous = this.versions.get(record.asset.id);
    this.versions.set(record.asset.id, record.asset.version);
    return {
      status: previous === record.asset.version ? "IDEMPOTENT" : "PROJECTED",
      indexVersion: this.calls,
      assetId: record.asset.id,
      assetVersion: record.asset.version,
    };
  }
}

class MemoryFreshness implements FreshnessProjectionPort {
  calls = 0;
  fail?: () => never;
  project(input: Parameters<FreshnessProjectionPort["project"]>[0]) {
    this.calls += 1;
    this.fail?.();
    return {
      status: "PROJECTED" as const,
      assetId: input.asset.id,
      assetVersion: input.asset.version,
      anchorCount: input.candidate.assertions.length,
    };
  }
}

class MemoryIndex implements IncrementalIndexPort {
  calls = 0;
  readonly versions = new Map<string, number>();
  constructor(private readonly markdown: MemoryMarkdown) {}
  fail: (() => never) | undefined;
  versionOffset = 0;

  syncAsset(assetId: string): IncrementalIndexResult {
    this.calls += 1;
    this.fail?.();
    const version = this.markdown.current.get(assetId)?.asset.version;
    const unchanged = this.versions.get(assetId) === version;
    if (version !== undefined) this.versions.set(assetId, version);
    return {
      assetId,
      action: unchanged ? "UNCHANGED" : "INDEXED",
      ...(version === undefined ? {} : { assetVersion: version + this.versionOffset }),
      ...(this.markdown.current.get(assetId)?.asset.contentHash === undefined
        ? {}
        : { contentHash: this.markdown.current.get(assetId)?.asset.contentHash as string }),
      indexVersion: this.calls,
      chunks: [],
      diagnostics: [],
    };
  }
}

function candidateDraft(input: KnowledgeExtractionInput, options: {
  readonly subjectKey?: string;
  readonly implementation?: boolean;
  readonly withSymbol?: boolean;
  readonly kind?: KnowledgeKind;
  readonly includeAcceptance?: boolean;
  readonly trustedTest?: boolean;
} = {}) {
  return {
    subjectKey: options.subjectKey ?? "project.runtime.behavior",
    kind: options.kind ?? (options.implementation === true ? "IMPLEMENTATION" : "FACT"),
    scopeHint: { level: "PROJECT", projectId: input.projectContext.projectId, reasonCodes: ["PROJECT_BOUND"] },
    title: "运行时设计",
    summary: "运行时采用可恢复阶段机",
    body: "Markdown 是权威来源，Registry 和索引由 outbox 推进。",
    confidence: 0.95,
    assertions: [
      ...(options.trustedTest === true
        ? [{ kind: "TEST_PASSED", parameters: { testId: `test-${options.subjectKey ?? "runtime"}` } }]
        : options.includeAcceptance === false ? [] : [{ kind: "USER_ACCEPTED", parameters: { statementRef: input.goalRef } }]),
      ...(options.withSymbol === true
        ? [{ kind: "SYMBOL_EXISTS", parameters: { projectId: input.projectContext.projectId, symbol: "KnowledgeWorkerRuntime" } }]
        : []),
    ],
    evidenceHints: [{ type: "USER_STATEMENT", sourceRef: input.goalRef, projectId: input.projectContext.projectId }],
  };
}

function compiler(options: {
  readonly implementation?: boolean;
  readonly withSymbol?: boolean;
  readonly count?: number;
  readonly kind?: KnowledgeKind;
  readonly includeAcceptance?: boolean;
  readonly trustedTest?: boolean;
} = {}) {
  return {
    extract: async (input: KnowledgeExtractionInput) => ({
      schemaVersion: 1,
      candidates: Array.from({ length: options.count ?? 1 }, (_, index) => candidateDraft(input, {
        subjectKey: index === 0 ? "project.runtime.behavior" : `project.runtime.behavior-${index}`,
        ...(options.implementation === undefined ? {} : { implementation: options.implementation }),
        ...(options.withSymbol === undefined ? {} : { withSymbol: options.withSymbol }),
        ...(options.kind === undefined ? {} : { kind: options.kind }),
        ...(options.includeAcceptance === undefined ? {} : { includeAcceptance: options.includeAcceptance }),
        ...(options.trustedTest === undefined ? {} : { trustedTest: options.trustedTest }),
      })),
    }),
  };
}

function evidence(): EvidenceVerificationPort {
  return {
    verify: async ({ candidate, project, requestedAt, purpose, snapshot }): Promise<readonly VerificationResult[]> => {
      expect(purpose).toBe("CANDIDATE");
      expect(snapshot).toBeDefined();
      return candidate.assertions.map((assertion) => {
        const type = assertion.kind === "SYMBOL_EXISTS"
          ? "CODE_SYMBOL" as const
          : assertion.kind === "TEST_PASSED" ? "TEST_RESULT" as const : "USER_STATEMENT" as const;
        return {
        assertionId: assertion.assertionId,
        assertionKind: assertion.kind,
        verifierId: "test-verifier",
        status: "SUPPORTED",
        target: assertion.assertionId,
        observedAt: requestedAt,
        reasonCodes: ["SUPPORTED_BY_TEST"],
        evidence: {
          evidenceId: sha256(`evidence:${assertion.assertionId}`),
          assertionId: assertion.assertionId,
          type,
          verdict: "SUPPORTS",
          sourceRef: assertion.kind === "USER_ACCEPTED" || assertion.kind === "USER_REJECTED"
            ? assertion.parameters.statementRef
            : assertion.assertionId,
          projectId: project.projectId,
          observedAt: requestedAt,
          correlationId: candidate.correlationId,
        },
        };
      });
    },
  };
}

function fixture(overrides: Partial<KnowledgeWorkerPorts> = {}): {
  readonly ports: KnowledgeWorkerPorts;
  readonly markdown: MemoryMarkdown;
  readonly registry: MemoryRegistry;
  readonly freshness: MemoryFreshness;
  readonly index: MemoryIndex;
} {
  const records = ledgerRecords();
  const ledger: LedgerSnapshotPort = {
    loadSnapshot: async () => ({
      snapshotId: "snapshot-1",
      sourceVersion: "v1",
      contentHash: sha256(JSON.stringify(records)),
      records,
    }),
    inspectSnapshot: async () => ({
      snapshotId: "snapshot-1",
      sourceVersion: "v1",
      contentHash: sha256(JSON.stringify(records)),
    }),
  };
  const markdown = new MemoryMarkdown();
  const registry = new MemoryRegistry();
  const freshness = new MemoryFreshness();
  const index = new MemoryIndex(markdown);
  const evolution = {
    search: async (_queries: readonly string[], limit: number) =>
      [...markdown.current.values()].slice(0, limit).map((record) => record.asset),
  };
  return {
    markdown,
    registry,
    freshness,
    index,
    ports: { ledger, compiler: compiler(), evidence: evidence(), evolution, markdown, registry, freshness, index, ...overrides },
  };
}

function request(overrides: Partial<KnowledgeWorkerRunRequest> = {}): KnowledgeWorkerRunRequest {
  return {
    workId: "work-1",
    snapshot: { snapshotId: "snapshot-1", sessionId: "session-1", sourceVersion: "v1" },
    asOf: "2026-08-01T09:00:00.000Z",
    project: { projectId: "project-1", repositoryRoot: "/workspace/repo", portable: false },
    compilerVersion: "compiler-v1",
    promptVersion: "prompt-v1",
    policyHash: "policy-v1",
    verificationPolicy: DEFAULT_CONFIGURATION.verification,
    extraction: { maxAttempts: 1, perAttemptTimeoutMs: 1_000 },
    ...overrides,
  };
}

function publicationOptions(
  authorizationId = "explicit-commit-1",
  overrides: Partial<KnowledgeWorkerRunOptions> = {},
): KnowledgeWorkerRunOptions {
  return {
    executionMode: "SAFE_AUTO_PUBLICATION",
    publicationAuthorization: { kind: "EXPLICIT_COMMIT", authorizationId },
    ...overrides,
  };
}

describe("KnowledgeWorkerRuntime", () => {
  it("publishes v2 localization and projects scenario/CodeGraph context idempotently", async () => {
    const projected: Array<{ asset: KnowledgeAsset }> = [];
    const setup = fixture({
      compiler: {
        extract: async (input) => ({ schemaVersion: 1, candidates: [{
          ...candidateDraft(input),
          claimMode: "CURRENT_STATE" as const,
          scenarioHint: { scenarioKey: "runtime.publication", title: "运行时发布", summary: "发布可恢复知识。",
            taskIntents: ["发布知识"], entryPoints: ["KnowledgeWorkerRuntime.run"], applicability: ["当前项目"],
            nonApplicability: ["其他项目"] },
        }] }),
      },
      contextProjection: { project: (input) => { projected.push({ asset: input.asset }); } },
    });
    const runtime = new KnowledgeWorkerRuntime(setup.ports, new MemoryCheckpointStore());
    const result = await runtime.run(request({ project: { projectId: "project-1", repositoryRoot: "/workspace/repo",
      branch: "main", revision: { commit: "abcdef1234567", dirty: false }, portable: false } }), publicationOptions());
    expect(result.status).toBe("COMPLETED");
    expect(result.payload.candidates?.[0]?.locator).toMatchObject({ observedRevision: {
      branch: "main", commit: "abcdef1234567", dirty: false,
    } });
    expect(result.payload.policies?.[0]?.decision.shouldPublish).toBe(true);
    expect(result.payload.outbox?.[0]?.asset).toMatchObject({ schemaVersion: 2, claimMode: "CURRENT_STATE",
      locator: { projectId: "project-1", observedRevision: { branch: "main", commit: "abcdef1234567", dirty: false },
        scenarioKey: "runtime.publication" } });
    expect(projected).toHaveLength(1);
    const replay = await runtime.run(request({ project: { projectId: "project-1", repositoryRoot: "/workspace/repo",
      branch: "main", revision: { commit: "abcdef1234567", dirty: false }, portable: false } }), publicationOptions());
    expect(replay.revision).toBe(result.revision);
    expect(projected).toHaveLength(1);
  });

  it("uses Episode project resolution for scope and evidence instead of the session fallback", async () => {
    const fallbackEvidence = evidence();
    const verifiedProjects: string[] = [];
    const nested = { projectId: "project-nested", repositoryRoot: "/workspace/repo/nested", portable: false } as const;
    const setup = fixture({
      projectResolution: { resolve: () => nested },
      evidence: {
        verify: async (input) => {
          verifiedProjects.push(input.project.projectId);
          return await fallbackEvidence.verify(input);
        },
      },
    });
    const runtime = new KnowledgeWorkerRuntime(setup.ports, new MemoryCheckpointStore());
    const checkpoint = await runtime.run(request(), { executionMode: "POLICY_EVALUATION" });
    expect({ status: checkpoint.status, stages: checkpoint.stages }).toMatchObject({
      status: "AWAITING_COMMIT",
      stages: { CANDIDATE_POLICY: { status: "SUCCEEDED" } },
    });
    expect(checkpoint.payload.episodes?.map((episode) => episode.projectContext)).toEqual([nested]);
    expect(verifiedProjects).toEqual([nested.projectId]);
    expect(checkpoint.payload.evolution?.[0]?.scope.scope).toMatchObject({ projectId: nested.projectId });
  });

  it("runs the complete chain and replays without duplicate candidate or version", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zhiloop-worker-"));
    tempDirectories.push(directory);
    const setup = fixture();
    const search = setup.ports.evolution.search;
    let evolutionCalls = 0;
    setup.ports.evolution.search = async (...args) => {
      evolutionCalls += 1;
      return search(...args);
    };
    const databasePath = path.join(directory, "worker.sqlite");
    const store = new SqliteKnowledgeWorkerCheckpointStore(databasePath);
    const runtime = new KnowledgeWorkerRuntime(setup.ports, store, () => new Date("2026-08-01T10:00:00.000Z"));

    const first = await runtime.run(request(), publicationOptions());
    store.close();
    using reopened = new SqliteKnowledgeWorkerCheckpointStore(databasePath);
    const replay = await new KnowledgeWorkerRuntime(
      setup.ports,
      reopened,
      () => new Date("2026-08-01T10:00:00.000Z"),
    ).run(request(), publicationOptions());

    expect(first.status).toBe("COMPLETED");
    expect(first.payload.episodes).toHaveLength(1);
    expect(first.payload.candidates).toHaveLength(1);
    expect(first.payload.policies?.[0]?.decision.targetStatus).toBe("ACCEPTED");
    expect(first.payload.outbox).toHaveLength(1);
    expect(replay.revision).toBe(first.revision);
    expect(setup.markdown.current).toHaveLength(1);
    expect(setup.markdown.publishCalls).toBe(1);
    expect(setup.registry.calls).toBe(1);
    expect(setup.freshness.calls).toBe(1);
    expect(setup.index.calls).toBe(1);
    expect(evolutionCalls).toBe(1);
  });

  it("persists a publication-free preview boundary and resumes the same work after commit", async () => {
    const setup = fixture();
    const store = new MemoryCheckpointStore();
    const runtime = new KnowledgeWorkerRuntime(setup.ports, store);

    const preview = await runtime.run(request());
    const replay = await runtime.run(request(), { executionMode: "POLICY_EVALUATION" });

    expect(preview.status).toBe("AWAITING_COMMIT");
    expect(preview.payload.policies).toHaveLength(1);
    expect(preview.payload.outbox).toHaveLength(1);
    expect(preview.stages.MARKDOWN_PUBLISH.status).toBe("PENDING");
    expect(replay.revision).toBeGreaterThan(preview.revision);
    expect(setup.markdown.publishCalls).toBe(0);
    expect(setup.registry.calls).toBe(0);
    expect(setup.index.calls).toBe(0);

    const committed = await runtime.run(request(), publicationOptions());

    expect(committed.status).toBe("COMPLETED");
    expect(setup.markdown.publishCalls).toBe(1);
    expect(setup.registry.calls).toBe(1);
    expect(setup.index.calls).toBe(1);
  });

  it.each([
    ["按这个做", "USER_ACCEPTED"],
    ["不要使用运行时设计", "USER_REJECTED"],
  ] as const)("applies a uniquely targeted user commitment before policy: %s", async (statementText, expectedKind) => {
    const records = commitmentLedgerRecords(statementText);
    const setup = fixture({ ledger: snapshotLedger(records) });
    setup.ports.compiler.extract = compiler({ kind: "DESIGN", includeAcceptance: false }).extract;
    const checkpoint = await new KnowledgeWorkerRuntime(setup.ports, new MemoryCheckpointStore()).run(request());

    expect(checkpoint.status).toBe("AWAITING_COMMIT");
    expect(checkpoint.stages.USER_COMMITMENT).toMatchObject({ status: "SUCCEEDED", attempts: 1 });
    expect(checkpoint.payload.userCommitments?.ambiguities).toEqual([]);
    expect(checkpoint.payload.userCommitments?.signals).toEqual([
      expect.objectContaining({ kind: expectedKind, candidateIds: [checkpoint.payload.candidates?.[0]?.candidateId] }),
    ]);
    expect(checkpoint.payload.candidates?.[0]?.assertions).toEqual([
      expect.objectContaining({ kind: expectedKind, parameters: { statementRef: records[3]?.event.eventId } }),
    ]);
    expect(checkpoint.payload.candidateProvenance?.[0]).toMatchObject({
      candidateId: checkpoint.payload.candidates?.[0]?.candidateId,
      episodeId: checkpoint.payload.episodes?.[0]?.episodeId,
      compilerVersion: "compiler-v1",
      promptVersion: "prompt-v1",
      policyHash: "policy-v1",
    });
    expect(checkpoint.payload.candidateProvenance?.[0]?.inputHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.keys(checkpoint.payload.candidateProvenance?.[0] ?? {}).sort()).toEqual([
      "builderVersion",
      "candidateId",
      "compilerVersion",
      "episodeId",
      "extractionKey",
      "inputHash",
      "policyHash",
      "promptVersion",
    ]);
  });

  it("keeps an ambiguous commitment visible without enriching either candidate", async () => {
    const records = commitmentLedgerRecords("按这个做");
    const setup = fixture({ ledger: snapshotLedger(records) });
    setup.ports.compiler.extract = compiler({ kind: "DESIGN", includeAcceptance: false, count: 2 }).extract;
    const checkpoint = await new KnowledgeWorkerRuntime(setup.ports, new MemoryCheckpointStore()).run(request());

    expect(checkpoint.payload.userCommitments?.signals).toEqual([]);
    expect(checkpoint.payload.userCommitments?.ambiguities).toEqual([
      expect.objectContaining({
        kind: "USER_ACCEPTED",
        statementRef: records[3]?.event.eventId,
        candidateIds: checkpoint.payload.candidates?.map(({ candidateId }) => candidateId).sort(),
      }),
    ]);
    expect(checkpoint.payload.candidates?.every((candidate) =>
      candidate.assertions.every((assertion) => assertion.kind !== "USER_ACCEPTED"))).toBe(true);
  });

  it("removes model-asserted commitment when the user did not make that commitment", async () => {
    const records = commitmentLedgerRecords("继续分析边界条件");
    const setup = fixture({ ledger: snapshotLedger(records) });
    setup.ports.compiler.extract = compiler({ kind: "DESIGN", includeAcceptance: true }).extract;
    const checkpoint = await new KnowledgeWorkerRuntime(setup.ports, new MemoryCheckpointStore()).run(request());

    expect(checkpoint.payload.userCommitments).toMatchObject({ signals: [], ambiguities: [] });
    expect(checkpoint.payload.candidates?.[0]?.assertions).toEqual([]);
    expect(checkpoint.payload.candidates?.[0]?.evidenceHints).toHaveLength(1);
    expect(checkpoint.payload.outbox).toEqual([]);
  });

  it("upgrades a legacy compiled checkpoint and preserves a correction as an evolution draft", async () => {
    const setup = fixture();
    setup.ports.compiler.extract = compiler({ kind: "DESIGN", includeAcceptance: false }).extract;
    const store = new MemoryCheckpointStore();
    const runtime = new KnowledgeWorkerRuntime(setup.ports, store);
    const initial = await runtime.run(request());
    const sourceEpisode = initial.payload.episodes?.[0];
    const sourceCandidate = initial.payload.candidates?.[0];
    const sourceLedger = initial.payload.ledger;
    const sourceNormalization = initial.payload.normalization;
    const sourceEpisodeBuild = initial.payload.episodeBuild;
    if (sourceEpisode === undefined || sourceCandidate === undefined || sourceLedger === undefined
      || sourceNormalization === undefined || sourceEpisodeBuild === undefined) {
      throw new Error("fixture did not compile an Episode");
    }
    const correctedRef = "event-user-correction";
    const occurredAt = "2026-08-01T08:05:00.000Z";
    const correctionEpisode: Episode = {
      ...sourceEpisode,
      turnIds: [...sourceEpisode.turnIds, "turn-correction"],
      userStatements: [...sourceEpisode.userStatements, {
        turnId: "turn-correction",
        sourceEventId: correctedRef,
        kind: "CORRECTION",
        statement: "不是这个意思，改用有界队列",
        occurredAt,
      }],
      userCorrections: [...sourceEpisode.userCorrections, {
        correctionId: "correction-1",
        turnId: "turn-correction",
        originalRef: sourceEpisode.goalRef,
        originalStatement: sourceEpisode.goal,
        correctedRef,
        correctedStatement: "不是这个意思，改用有界队列",
        occurredAt,
      }],
      evidenceRefs: [...sourceEpisode.evidenceRefs, correctedRef],
      updatedAt: occurredAt,
    };
    const stages = structuredClone(initial.stages) as Record<string, unknown>;
    delete stages["USER_COMMITMENT"];
    delete stages["EVOLUTION_MATCH"];
    for (const stage of ["CANDIDATE_POLICY", "MARKDOWN_PUBLISH", "REGISTRY_PROJECT", "INCREMENTAL_INDEX"]) {
      stages[stage] = { status: "PENDING", attempts: 0 };
    }
    store.checkpoint = {
      ...initial,
      status: "RUNNING",
      stages: stages as KnowledgeWorkerCheckpoint["stages"],
      payload: {
        ledger: sourceLedger,
        normalization: sourceNormalization,
        episodeBuild: sourceEpisodeBuild,
        episodes: [correctionEpisode],
        candidates: [sourceCandidate],
      },
    };

    const migrated = await runtime.run(request());
    expect(migrated.payload.userCommitments?.signals.map(({ kind }) => kind).sort()).toEqual([
      "CORRECTION",
      "USER_ACCEPTED",
      "USER_REJECTED",
    ]);
    expect(migrated.payload.userCommitments?.correctionDrafts).toEqual([
      expect.objectContaining({
        candidateId: sourceCandidate.candidateId,
        relationHint: "CONTRADICTS",
        originalRef: sourceEpisode.goalRef,
        correctedRef,
      }),
    ]);
    expect(migrated.payload.candidates?.[0]?.assertions).toContainEqual(
      expect.objectContaining({ kind: "USER_REJECTED", parameters: { statementRef: correctedRef } }),
    );
    expect(migrated.payload.candidateProvenance).toHaveLength(1);
    expect(migrated.payload.evolution?.[0]?.decision).toMatchObject({ status: "DECIDED", action: "STORE" });
    expect(migrated.payload.policies?.[0]?.decision).toMatchObject({
      targetStatus: "PROPOSED", interaction: "ASK_USER", shouldPublish: false,
    });
    expect(migrated.payload.outbox).toEqual([]);
    const replay = await runtime.run(request());
    expect(replay.revision).toBe(migrated.revision);
    expect(replay.stages.USER_COMMITMENT.attempts).toBe(1);
    expect(replay.stages.EVOLUTION_MATCH.attempts).toBe(1);
  });

  it("adds evolution audit data to a legacy policy checkpoint without rewriting its outbox", async () => {
    const setup = fixture();
    const store = new MemoryCheckpointStore();
    const runtime = new KnowledgeWorkerRuntime(setup.ports, store);
    const initial = await runtime.run(request());
    const stages = structuredClone(initial.stages) as Record<string, unknown>;
    delete stages["EVOLUTION_MATCH"];
    const payload = Object.fromEntries(Object.entries(initial.payload).filter(([key]) => key !== "evolution")) as
      KnowledgeWorkerCheckpoint["payload"];
    store.checkpoint = {
      ...initial,
      status: "RUNNING",
      stages: stages as KnowledgeWorkerCheckpoint["stages"],
      payload,
    };

    const migrated = await runtime.run(request());
    expect(migrated.payload.evolution).toHaveLength(1);
    expect(migrated.payload.outbox).toEqual(initial.payload.outbox);
    expect(migrated.stages.CANDIDATE_POLICY.attempts).toBe(initial.stages.CANDIDATE_POLICY.attempts);
  });

  it("fails closed for missing or malformed publication authority", async () => {
    const setup = fixture();
    const store = new MemoryCheckpointStore();
    const runtime = new KnowledgeWorkerRuntime(setup.ports, store);

    await expect(runtime.run(request(), { executionMode: "SAFE_AUTO_PUBLICATION" })).rejects.toMatchObject({
      code: "PUBLICATION_AUTHORIZATION_REQUIRED",
      retryable: false,
    });
    await expect(runtime.run(request(), {
      executionMode: "PREVIEW_ONLY",
      publicationAuthorization: { kind: "EXPLICIT_COMMIT", authorizationId: "unexpected" },
    })).rejects.toMatchObject({ code: "UNEXPECTED_PUBLICATION_AUTHORIZATION" });
    await expect(runtime.run(request(), {
      executionMode: "SAFE_AUTO_PUBLICATION",
      publicationAuthorization: { kind: "EXPLICIT_COMMIT", authorizationId: "   " },
    })).rejects.toMatchObject({ code: "INVALID_PUBLICATION_AUTHORIZATION" });
    await expect(runtime.run(request(), {
      executionMode: "SAFE_AUTO_PUBLICATION",
      publicationAuthorization: {
        kind: "EXPLICIT_COMMIT",
        authorizationId: 42,
      },
    } as unknown as KnowledgeWorkerRunOptions)).rejects.toMatchObject({ code: "INVALID_PUBLICATION_AUTHORIZATION" });
    await expect(runtime.run(request(), {
      executionMode: "SAFE_AUTO_PUBLICATION",
      publicationAuthorization: { kind: "SAFE_POLICY", authorizationId: "policy-1", policyHash: "" },
    })).rejects.toMatchObject({ code: "INVALID_PUBLICATION_AUTHORIZATION" });

    expect(store.checkpoint).toBeUndefined();
    expect(setup.markdown.publishCalls).toBe(0);
  });

  it("accepts a policy-bound publication authority and rejects an invalid execution mode", async () => {
    const setup = fixture();
    const runtime = new KnowledgeWorkerRuntime(setup.ports, new MemoryCheckpointStore());
    const completed = await runtime.run(request({ workId: "safe-policy-work" }), {
      executionMode: "SAFE_AUTO_PUBLICATION",
      publicationAuthorization: {
        kind: "SAFE_POLICY",
        authorizationId: "policy-decision-1",
        policyHash: "policy-v1",
      },
    });
    expect(completed.status).toBe("COMPLETED");
    expect(completed.publicationAuthorization).toMatchObject({ kind: "SAFE_POLICY", policyHash: "policy-v1" });

    await expect(new KnowledgeWorkerRuntime(fixture().ports, new MemoryCheckpointStore()).run(
      request({ workId: "invalid-mode-work" }),
      { executionMode: "UNBOUNDED" } as unknown as KnowledgeWorkerRunOptions,
    )).rejects.toMatchObject({ code: "INVALID_EXECUTION_MODE", retryable: false });
  });

  it("does not inherit publication capability and rejects changed authority after publication starts", async () => {
    const setup = fixture();
    let failIndex = true;
    setup.index.fail = () => {
      if (failIndex) throw Object.assign(new Error("index offline"), { retryable: true });
      throw new Error("unexpected index failure");
    };
    const store = new MemoryCheckpointStore();
    const runtime = new KnowledgeWorkerRuntime(setup.ports, store);

    const partial = await runtime.run(request(), publicationOptions("commit-a"));
    expect(partial.status).toBe("RETRYABLE");
    expect(partial.stages.MARKDOWN_PUBLISH.status).toBe("SUCCEEDED");
    expect(partial.stages.INCREMENTAL_INDEX.status).toBe("RETRYABLE");
    const indexCalls = setup.index.calls;

    const lowerPrivilege = await runtime.run(request());
    expect(lowerPrivilege.status).toBe("AWAITING_COMMIT");
    expect(lowerPrivilege.lastExecutionMode).toBe("PREVIEW_ONLY");
    expect(setup.index.calls).toBe(indexCalls);

    await expect(runtime.run(request(), publicationOptions("commit-b"))).rejects.toMatchObject({
      code: "PUBLICATION_AUTHORIZATION_CONFLICT",
      retryable: false,
    });
    expect(setup.index.calls).toBe(indexCalls);

    failIndex = false;
    setup.index.fail = undefined;
    const completed = await runtime.run(request(), publicationOptions("commit-a"));
    expect(completed.status).toBe("COMPLETED");
    expect(setup.markdown.publishCalls).toBe(1);
    expect(setup.registry.calls).toBe(1);
    expect(setup.index.calls).toBe(indexCalls + 1);
  });

  it("resumes at freshness projection without replaying prior publication side effects", async () => {
    const setup = fixture();
    setup.freshness.fail = () => {
      throw Object.assign(new Error("freshness store offline"), { retryable: true });
    };
    const runtime = new KnowledgeWorkerRuntime(setup.ports, new MemoryCheckpointStore());

    const partial = await runtime.run(request({ workId: "freshness-recovery" }), publicationOptions("commit-freshness"));
    expect(partial.status).toBe("RETRYABLE");
    expect(partial.stages.MARKDOWN_PUBLISH.status).toBe("SUCCEEDED");
    expect(partial.stages.REGISTRY_PROJECT.status).toBe("SUCCEEDED");
    expect(partial.stages.FRESHNESS_PROJECT.status).toBe("RETRYABLE");
    expect(setup.markdown.publishCalls).toBe(1);
    expect(setup.registry.calls).toBe(1);
    expect(setup.index.calls).toBe(0);

    delete setup.freshness.fail;
    const completed = await runtime.run(
      request({ workId: "freshness-recovery" }),
      publicationOptions("commit-freshness"),
    );
    expect(completed.status).toBe("COMPLETED");
    expect(setup.markdown.publishCalls).toBe(1);
    expect(setup.registry.calls).toBe(1);
    expect(setup.freshness.calls).toBe(2);
    expect(setup.index.calls).toBe(1);
  });

  it("does not let a lower-privilege retry reset a failed publication stage", async () => {
    const setup = fixture();
    setup.index.fail = () => { throw Object.assign(new Error("index offline"), { retryable: true }); };
    const store = new MemoryCheckpointStore();
    const runtime = new KnowledgeWorkerRuntime(setup.ports, store);
    const bounded = request({ workId: "failed-publication", limits: { maxStageAttempts: 1 } });

    const failed = await runtime.run(bounded, publicationOptions("commit-failed"));
    expect(failed.status).toBe("FAILED");
    expect(failed.stages.INCREMENTAL_INDEX).toMatchObject({ status: "FAILED", attempts: 1 });
    const replay = await runtime.run(bounded, { executionMode: "PREVIEW_ONLY", retryFailed: true });
    expect(replay.status).toBe("FAILED");
    expect(replay.revision).toBe(failed.revision + 1);
    expect(replay.lastExecutionMode).toBe("PREVIEW_ONLY");
    expect(replay.stages.INCREMENTAL_INDEX).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(setup.index.calls).toBe(1);
  });

  it("lazily upgrades a legacy awaiting-commit checkpoint", async () => {
    const setup = fixture();
    const store = new MemoryCheckpointStore();
    const runtime = new KnowledgeWorkerRuntime(setup.ports, store);
    const preview = await runtime.run(request());
    store.checkpoint = { ...preview };
    delete (store.checkpoint as { lastExecutionMode?: unknown }).lastExecutionMode;

    const migrated = await runtime.run(request(), { executionMode: "POLICY_EVALUATION" });
    expect(migrated.status).toBe("AWAITING_COMMIT");
    expect(migrated.lastExecutionMode).toBe("POLICY_EVALUATION");
    expect(setup.markdown.publishCalls).toBe(0);

    const completed = await runtime.run(request(), publicationOptions("legacy-commit"));
    expect(completed.status).toBe("COMPLETED");
    expect(completed.publicationAuthorization).toEqual({
      kind: "EXPLICIT_COMMIT",
      authorizationId: "legacy-commit",
    });
    store.checkpoint = { ...completed };
    delete (store.checkpoint as { lastExecutionMode?: unknown }).lastExecutionMode;
    delete (store.checkpoint as { publicationAuthorization?: unknown }).publicationAuthorization;
    const completedLegacyReplay = await runtime.run(request());
    expect(completedLegacyReplay.revision).toBe(completed.revision);
    expect(setup.markdown.publishCalls).toBe(1);
  });

  it("replays an idempotent Markdown publish after a crash before checkpoint commit", async () => {
    const setup = fixture();
    const store = new FaultCheckpointStore();
    const runtime = new KnowledgeWorkerRuntime(setup.ports, store);

    const interrupted = await runtime.run(request(), publicationOptions());
    const recovered = await runtime.run(request(), publicationOptions());

    expect(interrupted.status).toBe("RETRYABLE");
    expect(interrupted.stages.MARKDOWN_PUBLISH.error?.code).toBe("CHECKPOINT_SAVE_FAILED");
    expect(recovered.status).toBe("COMPLETED");
    expect(setup.markdown.publishCalls).toBe(2);
    expect(setup.markdown.current.values().next().value?.asset.version).toBe(1);
    expect(setup.registry.calls).toBe(1);
  });

  it("resumes at the index boundary without republishing or reprojecting", async () => {
    const setup = fixture();
    let failOnce = true;
    setup.index.fail = () => {
      if (failOnce) {
        failOnce = false;
        throw Object.assign(new Error("index unavailable"), { retryable: true });
      }
      throw new Error("unexpected second failure");
    };
    const runtime = new KnowledgeWorkerRuntime(setup.ports, new MemoryCheckpointStore());

    const degraded = await runtime.run(request(), publicationOptions());
    setup.index.fail = undefined;
    const recovered = await runtime.run(request(), publicationOptions());

    expect(degraded.status).toBe("RETRYABLE");
    expect(degraded.stages.INCREMENTAL_INDEX.status).toBe("RETRYABLE");
    expect(recovered.status).toBe("COMPLETED");
    expect(setup.markdown.publishCalls).toBe(1);
    expect(setup.registry.calls).toBe(1);
    expect(setup.index.calls).toBe(2);
  });

  it("skips an unchanged knowledge body instead of creating a status-only version", async () => {
    const setup = fixture();
    setup.ports.compiler.extract = compiler({ implementation: true, withSymbol: true }).extract;
    const verify = evidence().verify;
    let symbolSupported = false;
    setup.ports.evidence.verify = async (...args) => (await verify(...args)).map((result) => {
      if (result.assertionKind !== "SYMBOL_EXISTS" || symbolSupported) return result;
      return {
        assertionId: result.assertionId,
        assertionKind: result.assertionKind,
        ...(result.verifierId === undefined ? {} : { verifierId: result.verifierId }),
        status: "UNKNOWN" as const,
        target: result.target,
        observedAt: result.observedAt,
        reasonCodes: ["SYMBOL_NOT_OBSERVED"],
      };
    });
    const first = await new KnowledgeWorkerRuntime(setup.ports, new MemoryCheckpointStore()).run(
      request({ workId: "version-1" }),
      publicationOptions("version-1-commit"),
    );
    symbolSupported = true;
    const second = await new KnowledgeWorkerRuntime(setup.ports, new MemoryCheckpointStore()).run(
      request({ workId: "version-2" }),
      publicationOptions("version-2-commit"),
    );

    expect(first.payload.outbox?.[0]?.asset).toMatchObject({ version: 1, status: "ACCEPTED" });
    expect(second.payload.evolution?.[0]?.decision).toMatchObject({
      status: "DECIDED",
      action: "SKIP",
      targetKnowledgeVersions: [{ id: first.payload.outbox?.[0]?.asset.id, version: 1 }],
    });
    expect(second.payload.policies?.[0]?.decision.targetStatus).toBe("IMPLEMENTED");
    expect(second.payload.outbox).toEqual([]);
    expect(setup.markdown.current.values().next().value?.asset.version).toBe(1);
  });

  it("publishes an evidence-backed supplement as the next lineage version", async () => {
    const setup = fixture();
    const baseCompiler = compiler();
    const first = await new KnowledgeWorkerRuntime(setup.ports, new MemoryCheckpointStore()).run(
      request({ workId: "supplement-v1" }),
      publicationOptions("supplement-v1-commit"),
    );
    setup.ports.compiler.extract = async (input) => {
      const output = await baseCompiler.extract(input);
      return {
        ...output,
        candidates: output.candidates.map((draft) => ({
          ...draft,
          body: `${draft.body} 新增边界：索引失败不回滚 Markdown。`,
        })),
      };
    };
    const second = await new KnowledgeWorkerRuntime(setup.ports, new MemoryCheckpointStore()).run(
      request({ workId: "supplement-v2" }),
      publicationOptions("supplement-v2-commit"),
    );

    expect(second.payload.evolution?.[0]?.decision).toMatchObject({ status: "DECIDED", action: "SUPPLEMENT" });
    expect(second.payload.outbox?.[0]?.asset).toMatchObject({
      id: first.payload.outbox?.[0]?.asset.id,
      version: 2,
      relations: [{
        type: "DERIVED_FROM",
        targetId: first.payload.outbox?.[0]?.asset.id,
        targetVersion: 1,
        reason: "EVOLUTION_SUPPLEMENT",
      }],
    });
  });

  it.each([
    ["LEDGER_READ", "ledger"],
    ["EVOLUTION_MATCH", "evolution"],
    ["CANDIDATE_POLICY", "evidence"],
    ["MARKDOWN_PUBLISH", "markdown"],
    ["REGISTRY_PROJECT", "registry"],
    ["FRESHNESS_PROJECT", "freshness"],
    ["INCREMENTAL_INDEX", "index"],
  ] as const)("checkpoints retryable external failure at %s", async (expectedStage, boundary) => {
    const setup = fixture();
    const retryable = (): never => { throw Object.assign(new Error(`${boundary} unavailable`), { retryable: true }); };
    if (boundary === "ledger") setup.ports.ledger.loadSnapshot = async () => retryable();
    if (boundary === "evolution") setup.ports.evolution.search = async () => retryable();
    if (boundary === "evidence") setup.ports.evidence.verify = async () => retryable();
    if (boundary === "markdown") setup.markdown.fail = retryable;
    if (boundary === "registry") setup.registry.fail = retryable;
    if (boundary === "freshness") setup.freshness.fail = retryable;
    if (boundary === "index") setup.index.fail = retryable;

    const result = await new KnowledgeWorkerRuntime(setup.ports, new MemoryCheckpointStore()).run(
      request(),
      publicationOptions(),
    );

    expect(result.status).toBe("RETRYABLE");
    expect(result.stages[expectedStage].status).toBe("RETRYABLE");
    expect(result.stages[expectedStage].error?.retryable).toBe(true);
  });

  it("turns retryable failures terminal at the configured attempt limit", async () => {
    const setup = fixture();
    setup.ports.ledger.loadSnapshot = async () => {
      throw Object.assign(new Error("offline"), { retryable: true });
    };
    const runtime = new KnowledgeWorkerRuntime(setup.ports, new MemoryCheckpointStore());
    const bounded = request({ limits: { maxStageAttempts: 2 } });

    expect((await runtime.run(bounded, publicationOptions())).status).toBe("RETRYABLE");
    const terminal = await runtime.run(bounded, publicationOptions());

    expect(terminal.status).toBe("FAILED");
    expect(terminal.stages.LEDGER_READ.attempts).toBe(2);
    expect(terminal.stages.LEDGER_READ.error?.retryable).toBe(true);
  });

  it("allows an explicit retry to recover one terminal retryable stage without replaying successful stages", async () => {
    const setup = fixture();
    let ledgerCalls = 0;
    setup.ports.ledger.loadSnapshot = async (...args) => {
      ledgerCalls += 1;
      if (ledgerCalls <= 2) throw Object.assign(new Error("offline"), { retryable: true });
      return fixture().ports.ledger.loadSnapshot(...args);
    };
    const store = new MemoryCheckpointStore();
    const runtime = new KnowledgeWorkerRuntime(setup.ports, store);
    const bounded = request({ limits: { maxStageAttempts: 2 } });

    expect((await runtime.run(bounded, publicationOptions())).status).toBe("RETRYABLE");
    expect((await runtime.run(bounded, publicationOptions())).status).toBe("FAILED");
    expect((await runtime.run(bounded, publicationOptions())).status).toBe("FAILED");

    const recovered = await runtime.run(bounded, publicationOptions("explicit-commit-1", { retryFailed: true }));
    expect(recovered.status).toBe("COMPLETED");
    expect(recovered.stages.LEDGER_READ.status).toBe("SUCCEEDED");
    expect(ledgerCalls).toBe(3);
  });

  it("rejects snapshot drift and work identity changes", async () => {
    const setup = fixture();
    const store = new MemoryCheckpointStore();
    const runtime = new KnowledgeWorkerRuntime(setup.ports, store);
    await runtime.run(request(), publicationOptions());
    setup.ports.ledger.inspectSnapshot = async () => ({
      snapshotId: "snapshot-1",
      sourceVersion: "v1",
      contentHash: "changed",
    });

    await expect(runtime.run(request(), publicationOptions())).rejects.toMatchObject({ code: "LEDGER_SNAPSHOT_CHANGED" });
    await expect(runtime.run(request({ promptVersion: "prompt-v2" }), publicationOptions())).rejects.toMatchObject({
      code: "WORK_IDENTITY_CONFLICT",
    });
    await expect(runtime.run(request({ policyHash: "policy-v2" }), publicationOptions())).rejects.toMatchObject({
      code: "WORK_IDENTITY_CONFLICT",
    });
    await expect(new KnowledgeWorkerRuntime(fixture().ports, new MemoryCheckpointStore()).run(
      request({ workId: "invalid-policy", policyHash: "" }),
    )).rejects.toMatchObject({ code: "INVALID_POLICY_HASH", retryable: false });
  });

  it("detects index version inconsistency and supports bounded rebuild", async () => {
    const setup = fixture();
    setup.index.versionOffset = 1;
    const runtime = new KnowledgeWorkerRuntime(setup.ports, new MemoryCheckpointStore());

    const inconsistent = await runtime.run(request(), publicationOptions());
    expect(inconsistent.status).toBe("RETRYABLE");
    expect(inconsistent.stages.INCREMENTAL_INDEX.error?.code).toBe("INDEX_VERSION_MISMATCH");

    setup.index.versionOffset = 0;
    const rebuild = await runtime.rebuildIndex(1);
    expect(rebuild.requested).toBe(1);
    expect(rebuild.indexed + rebuild.unchanged).toBe(1);
    await expect(runtime.rebuildIndex(0)).rejects.toBeInstanceOf(KnowledgeWorkerError);
  });

  it("enforces ledger and publication batch limits", async () => {
    const setup = fixture();
    const ledgerLimited = await new KnowledgeWorkerRuntime(setup.ports, new MemoryCheckpointStore()).run(
      request({ limits: { maxLedgerRecords: 3 } }),
      publicationOptions(),
    );
    expect(ledgerLimited.status).toBe("FAILED");
    expect(ledgerLimited.stages.LEDGER_READ.error?.code).toBe("LEDGER_BATCH_LIMIT_EXCEEDED");

    const evolutionLimited = fixture();
    const seeded = await new KnowledgeWorkerRuntime(evolutionLimited.ports, new MemoryCheckpointStore()).run(
      request({ workId: "evolution-seed" }),
      publicationOptions("evolution-seed-commit"),
    );
    const current = seeded.payload.outbox?.[0]?.asset;
    if (current === undefined) throw new Error("expected seeded asset");
    evolutionLimited.ports.evolution.search = async () => Array.from({ length: 6 }, () => current);
    const overLimit = await new KnowledgeWorkerRuntime(evolutionLimited.ports, new MemoryCheckpointStore()).run(
      request({ workId: "evolution-limited" }),
      publicationOptions("evolution-limited-commit"),
    );
    expect(overLimit.status).toBe("FAILED");
    expect(overLimit.stages.EVOLUTION_MATCH.error?.code).toBe("EVOLUTION_DECISION_INVALID");
    expect(overLimit.stages.EVOLUTION_MATCH.error?.message).toBe("EVOLUTION_TARGET_LIMIT_EXCEEDED");

    const publishing = fixture();
    publishing.ports.compiler.extract = compiler({
      count: 2,
      kind: "IMPLEMENTATION",
      includeAcceptance: false,
      withSymbol: true,
    }).extract;
    const publishLimited = await new KnowledgeWorkerRuntime(publishing.ports, new MemoryCheckpointStore()).run(
      request({ workId: "publish-limited", limits: { maxPublishItems: 1 } }),
      publicationOptions(),
    );
    expect(publishLimited.status).toBe("FAILED");
    expect(publishLimited.stages.CANDIDATE_POLICY.error?.code).toBe("PUBLISH_BATCH_LIMIT_EXCEEDED");
  });
});
