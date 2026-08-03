import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIGURATION } from "@zhiloop/config";
import type { LedgerEventRecord } from "@zhiloop/conversation-ledger";
import type { EventEnvelope, KnowledgeAsset, KnowledgeCandidate } from "@zhiloop/domain";
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
  IncrementalIndexPort,
  KnowledgeWorkerCheckpoint,
  KnowledgeWorkerCheckpointStore,
  KnowledgeWorkerPorts,
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
      payload: { kind: "user-prompt", prompt: "记录已经确认的运行时设计" },
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
} = {}) {
  return {
    subjectKey: options.subjectKey ?? "project.runtime.behavior",
    kind: options.implementation === true ? "IMPLEMENTATION" : "FACT",
    scopeHint: { level: "PROJECT", projectId: "project-1", reasonCodes: ["PROJECT_BOUND"] },
    title: "运行时设计",
    summary: "运行时采用可恢复阶段机",
    body: "Markdown 是权威来源，Registry 和索引由 outbox 推进。",
    confidence: 0.95,
    assertions: [
      { kind: "USER_ACCEPTED", parameters: { statementRef: input.goalRef } },
      ...(options.withSymbol === true
        ? [{ kind: "SYMBOL_EXISTS", parameters: { projectId: "project-1", symbol: "KnowledgeWorkerRuntime" } }]
        : []),
    ],
    evidenceHints: [],
  };
}

function compiler(options: { readonly implementation?: boolean; readonly withSymbol?: boolean; readonly count?: number } = {}) {
  return {
    extract: async (input: KnowledgeExtractionInput) => ({
      schemaVersion: 1,
      candidates: Array.from({ length: options.count ?? 1 }, (_, index) => candidateDraft(input, {
        subjectKey: index === 0 ? "project.runtime.behavior" : `project.runtime.behavior-${index}`,
        ...(options.implementation === undefined ? {} : { implementation: options.implementation }),
        ...(options.withSymbol === undefined ? {} : { withSymbol: options.withSymbol }),
      })),
    }),
  };
}

function evidence(): EvidenceVerificationPort {
  return {
    verify: async (candidate: KnowledgeCandidate, project, requestedAt): Promise<readonly VerificationResult[]> =>
      candidate.assertions.map((assertion) => {
        const type = assertion.kind === "SYMBOL_EXISTS" ? "CODE_SYMBOL" as const : "USER_STATEMENT" as const;
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
      }),
  };
}

function fixture(overrides: Partial<KnowledgeWorkerPorts> = {}): {
  readonly ports: KnowledgeWorkerPorts;
  readonly markdown: MemoryMarkdown;
  readonly registry: MemoryRegistry;
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
  const index = new MemoryIndex(markdown);
  return {
    markdown,
    registry,
    index,
    ports: { ledger, compiler: compiler(), evidence: evidence(), markdown, registry, index, ...overrides },
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
    verificationPolicy: DEFAULT_CONFIGURATION.verification,
    extraction: { maxAttempts: 1, perAttemptTimeoutMs: 1_000 },
    ...overrides,
  };
}

describe("KnowledgeWorkerRuntime", () => {
  it("runs the complete chain and replays without duplicate candidate or version", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zhiloop-worker-"));
    tempDirectories.push(directory);
    const setup = fixture();
    const databasePath = path.join(directory, "worker.sqlite");
    const store = new SqliteKnowledgeWorkerCheckpointStore(databasePath);
    const runtime = new KnowledgeWorkerRuntime(setup.ports, store, () => new Date("2026-08-01T10:00:00.000Z"));

    const first = await runtime.run(request());
    store.close();
    using reopened = new SqliteKnowledgeWorkerCheckpointStore(databasePath);
    const replay = await new KnowledgeWorkerRuntime(
      setup.ports,
      reopened,
      () => new Date("2026-08-01T10:00:00.000Z"),
    ).run(request());

    expect(first.status).toBe("COMPLETED");
    expect(first.payload.episodes).toHaveLength(1);
    expect(first.payload.candidates).toHaveLength(1);
    expect(first.payload.policies?.[0]?.decision.targetStatus).toBe("ACCEPTED");
    expect(first.payload.outbox).toHaveLength(1);
    expect(replay.revision).toBe(first.revision);
    expect(setup.markdown.current).toHaveLength(1);
    expect(setup.markdown.publishCalls).toBe(1);
    expect(setup.registry.calls).toBe(1);
    expect(setup.index.calls).toBe(1);
  });

  it("persists a publication-free preview boundary and resumes the same work after commit", async () => {
    const setup = fixture();
    const store = new MemoryCheckpointStore();
    const runtime = new KnowledgeWorkerRuntime(setup.ports, store);

    const preview = await runtime.run(request(), { stopAfterCandidatePolicy: true });
    const replay = await runtime.run(request(), { stopAfterCandidatePolicy: true });

    expect(preview.status).toBe("AWAITING_COMMIT");
    expect(preview.payload.policies).toHaveLength(1);
    expect(preview.payload.outbox).toHaveLength(1);
    expect(preview.stages.MARKDOWN_PUBLISH.status).toBe("PENDING");
    expect(replay.revision).toBe(preview.revision);
    expect(setup.markdown.publishCalls).toBe(0);
    expect(setup.registry.calls).toBe(0);
    expect(setup.index.calls).toBe(0);

    const committed = await runtime.run(request());

    expect(committed.status).toBe("COMPLETED");
    expect(setup.markdown.publishCalls).toBe(1);
    expect(setup.registry.calls).toBe(1);
    expect(setup.index.calls).toBe(1);
  });

  it("replays an idempotent Markdown publish after a crash before checkpoint commit", async () => {
    const setup = fixture();
    const store = new FaultCheckpointStore();
    const runtime = new KnowledgeWorkerRuntime(setup.ports, store);

    const interrupted = await runtime.run(request());
    const recovered = await runtime.run(request());

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

    const degraded = await runtime.run(request());
    setup.index.fail = undefined;
    const recovered = await runtime.run(request());

    expect(degraded.status).toBe("RETRYABLE");
    expect(degraded.stages.INCREMENTAL_INDEX.status).toBe("RETRYABLE");
    expect(recovered.status).toBe("COMPLETED");
    expect(setup.markdown.publishCalls).toBe(1);
    expect(setup.registry.calls).toBe(1);
    expect(setup.index.calls).toBe(2);
  });

  it("uses stable subject-kind-scope asset identity to create a contiguous version chain", async () => {
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
    );
    symbolSupported = true;
    const second = await new KnowledgeWorkerRuntime(setup.ports, new MemoryCheckpointStore()).run(
      request({ workId: "version-2" }),
    );

    expect(first.payload.outbox?.[0]?.asset).toMatchObject({ version: 1, status: "ACCEPTED" });
    expect(second.payload.outbox?.[0]?.asset).toMatchObject({
      id: first.payload.outbox?.[0]?.asset.id,
      version: 2,
      status: "IMPLEMENTED",
    });
    expect(setup.markdown.current.values().next().value?.asset.version).toBe(2);
  });

  it.each([
    ["LEDGER_READ", "ledger"],
    ["CANDIDATE_POLICY", "evidence"],
    ["MARKDOWN_PUBLISH", "markdown"],
    ["REGISTRY_PROJECT", "registry"],
    ["INCREMENTAL_INDEX", "index"],
  ] as const)("checkpoints retryable external failure at %s", async (expectedStage, boundary) => {
    const setup = fixture();
    const retryable = (): never => { throw Object.assign(new Error(`${boundary} unavailable`), { retryable: true }); };
    if (boundary === "ledger") setup.ports.ledger.loadSnapshot = async () => retryable();
    if (boundary === "evidence") setup.ports.evidence.verify = async () => retryable();
    if (boundary === "markdown") setup.markdown.fail = retryable;
    if (boundary === "registry") setup.registry.fail = retryable;
    if (boundary === "index") setup.index.fail = retryable;

    const result = await new KnowledgeWorkerRuntime(setup.ports, new MemoryCheckpointStore()).run(request());

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

    expect((await runtime.run(bounded)).status).toBe("RETRYABLE");
    const terminal = await runtime.run(bounded);

    expect(terminal.status).toBe("FAILED");
    expect(terminal.stages.LEDGER_READ.attempts).toBe(2);
    expect(terminal.stages.LEDGER_READ.error?.retryable).toBe(false);
  });

  it("rejects snapshot drift and work identity changes", async () => {
    const setup = fixture();
    const store = new MemoryCheckpointStore();
    const runtime = new KnowledgeWorkerRuntime(setup.ports, store);
    await runtime.run(request());
    setup.ports.ledger.inspectSnapshot = async () => ({
      snapshotId: "snapshot-1",
      sourceVersion: "v1",
      contentHash: "changed",
    });

    await expect(runtime.run(request())).rejects.toMatchObject({ code: "LEDGER_SNAPSHOT_CHANGED" });
    await expect(runtime.run(request({ promptVersion: "prompt-v2" }))).rejects.toMatchObject({
      code: "WORK_IDENTITY_CONFLICT",
    });
  });

  it("detects index version inconsistency and supports bounded rebuild", async () => {
    const setup = fixture();
    setup.index.versionOffset = 1;
    const runtime = new KnowledgeWorkerRuntime(setup.ports, new MemoryCheckpointStore());

    const inconsistent = await runtime.run(request());
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
    );
    expect(ledgerLimited.status).toBe("FAILED");
    expect(ledgerLimited.stages.LEDGER_READ.error?.code).toBe("LEDGER_BATCH_LIMIT_EXCEEDED");

    const publishing = fixture();
    publishing.ports.compiler.extract = compiler({ count: 2 }).extract;
    const publishLimited = await new KnowledgeWorkerRuntime(publishing.ports, new MemoryCheckpointStore()).run(
      request({ workId: "publish-limited", limits: { maxPublishItems: 1 } }),
    );
    expect(publishLimited.status).toBe("FAILED");
    expect(publishLimited.stages.CANDIDATE_POLICY.error?.code).toBe("PUBLISH_BATCH_LIMIT_EXCEEDED");
  });
});
