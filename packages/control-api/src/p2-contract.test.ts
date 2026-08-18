import { describe, expect, it } from "vitest";

import {
  REDACTED_P2_CONTRACT_FIXTURES,
  bidirectionalProvenanceSchema,
  candidatePolicyCommitRequestSchema,
  candidatePreviewSchema,
  extractionSnapshotCreateRequestSchema,
  extractionSnapshotSchema,
  legacyMigrationItemSchema,
  legacyMigrationPreviewSchema,
  knowledgeVersionRefSchema,
  parseP2ContractText,
  p2ControlRequestSchema,
  provenanceEdgeSchema,
} from "./index.js";

const requestBase = { schemaVersion: 1, requestId: "request_p2_contract_01" } as const;
const hash = (value: string) => value.repeat(64);

describe("P2 snapshot and candidate contracts", () => {
  it("accepts immutable partial snapshots and redacted candidate previews", () => {
    const snapshot = extractionSnapshotSchema.parse(REDACTED_P2_CONTRACT_FIXTURES.snapshot);
    const preview = candidatePreviewSchema.parse(REDACTED_P2_CONTRACT_FIXTURES.candidatePreview);
    expect(snapshot).toMatchObject({ revision: 1, completeness: { status: "PARTIAL_SNAPSHOT", sourceClosed: false } });
    expect(preview).toMatchObject({ revision: 3, candidates: [{ policyDecision: "PUBLISH" }] });
    expect(JSON.stringify(REDACTED_P2_CONTRACT_FIXTURES)).not.toMatch(/authorization|api[_-]?key|password|secret|rawPrompt/iu);
  });

  it("rejects unknown schema versions, unknown fields, and byte-limit overflow", () => {
    expect(parseP2ContractText(
      JSON.stringify({ ...REDACTED_P2_CONTRACT_FIXTURES.snapshot, schemaVersion: 2 }),
      extractionSnapshotSchema,
    )).toMatchObject({ ok: false, code: "UNSUPPORTED_SCHEMA_VERSION" });
    expect(extractionSnapshotSchema.safeParse({
      ...REDACTED_P2_CONTRACT_FIXTURES.snapshot,
      mutable: true,
    }).success).toBe(false);
    expect(parseP2ContractText(JSON.stringify(REDACTED_P2_CONTRACT_FIXTURES.snapshot), extractionSnapshotSchema, 8))
      .toMatchObject({ ok: false, code: "MESSAGE_TOO_LARGE" });
    expect(() => parseP2ContractText("{}", extractionSnapshotSchema, 0)).toThrow(/maximumBytes/);
  });

  it("enforces source completeness, sequence and compiler invariants", () => {
    const fixture = REDACTED_P2_CONTRACT_FIXTURES.snapshot;
    expect(extractionSnapshotSchema.safeParse({
      ...fixture,
      sourceSequence: { from: 43, to: 42 },
    }).success).toBe(false);
    expect(extractionSnapshotSchema.safeParse({
      ...fixture,
      completeness: { status: "COMPLETE_SNAPSHOT", sourceClosed: false, unsupportedEventTypes: [] },
    }).success).toBe(false);
    expect(candidatePreviewSchema.safeParse({
      ...REDACTED_P2_CONTRACT_FIXTURES.candidatePreview,
      candidates: [{ ...REDACTED_P2_CONTRACT_FIXTURES.candidatePreview.candidates[0], compilerVersion: "compiler-v3" }],
    }).success).toBe(false);
    expect(extractionSnapshotSchema.safeParse({
      ...fixture,
      previousSnapshotId: fixture.snapshotId,
    }).success).toBe(false);
    expect(extractionSnapshotSchema.safeParse({
      ...fixture,
      createdAt: "2026-08-04T16:00:00+08:00",
    }).success).toBe(false);
  });

  it("requires strict revision-bound idempotent extraction commands", () => {
    const create = {
      ...requestBase,
      type: "extraction.snapshot.create",
      sessionId: "session_demo_02",
      expectedCaptureRevision: 12,
      transcriptIdentityHash: hash("a"),
      sourceSequence: { from: 1, to: 42 },
      cursor: { byteOffset: 8_192, lineNumber: 240 },
      completeness: { status: "PARTIAL_SNAPSHOT", sourceClosed: false, unsupportedEventTypes: [] },
      compilerVersion: "compiler-v2",
      policyHash: hash("b"),
      configurationHash: hash("c"),
      idempotencyKey: "snapshot:session-demo-02:revision-12",
    } as const;
    expect(extractionSnapshotCreateRequestSchema.parse(create)).toEqual(create);
    expect(extractionSnapshotCreateRequestSchema.safeParse({ ...create, expectedCaptureRevision: -1 }).success).toBe(false);
    expect(extractionSnapshotCreateRequestSchema.safeParse({ ...create, idempotencyKey: "short" }).success).toBe(false);
    expect(extractionSnapshotCreateRequestSchema.safeParse({ ...create, futureMode: true }).success).toBe(false);

    const commit = {
      ...requestBase,
      type: "extraction.candidates.commit",
      snapshot: { snapshotId: "snapshot_demo_02", revision: 1, identityHash: hash("d") },
      previewId: "preview_demo_01",
      expectedPreviewRevision: 3,
      compilerVersion: "compiler-v2",
      policyHash: hash("b"),
      idempotencyKey: "candidate-policy:preview-demo-01:revision-3",
    } as const;
    expect(candidatePolicyCommitRequestSchema.parse(commit)).toEqual(commit);
    expect(candidatePolicyCommitRequestSchema.safeParse({ ...commit, expectedPreviewRevision: 0 }).success).toBe(false);
  });

  it("keeps snapshot, candidate, commit and provenance reads typed and bounded", () => {
    expect(p2ControlRequestSchema.parse({
      ...requestBase,
      type: "extraction.snapshots.list",
      sessionId: "session_demo_02",
      limit: 100,
    })).toMatchObject({ type: "extraction.snapshots.list", limit: 100 });
    expect(p2ControlRequestSchema.safeParse({
      ...requestBase,
      type: "extraction.candidates.get",
      previewId: "preview_demo_01",
      snapshotId: "snapshot_demo_02",
    }).success).toBe(false);
    expect(p2ControlRequestSchema.safeParse({
      ...requestBase,
      type: "extraction.provenance.get",
      root: { type: "SNAPSHOT", snapshotId: "snapshot_demo_02", revision: 1 },
      limit: 101,
    }).success).toBe(false);
  });

  it("keeps legacy migration operations strict, revision-bound and body-free", () => {
    const requestedAt = "2026-08-19T04:00:00.000Z";
    const previewRequest = {
      ...requestBase,
      type: "knowledge.migrations.preview",
      projectId: "project_demo_01",
      requestedAt,
    } as const;
    expect(p2ControlRequestSchema.parse(previewRequest)).toEqual(previewRequest);

    const commit = {
      ...requestBase,
      type: "knowledge.migrations.commit",
      migrationId: "migration_demo_01",
      expectedRevision: 0,
      idempotencyKey: "migration:commit:demo-01",
      requestedAt,
    } as const;
    expect(p2ControlRequestSchema.parse(commit)).toEqual(commit);
    expect(p2ControlRequestSchema.safeParse({ ...commit, expectedRevision: -1 }).success).toBe(false);
    expect(p2ControlRequestSchema.safeParse({ ...commit, requestedAt: "2026-08-19 12:00" }).success).toBe(false);
    expect(p2ControlRequestSchema.safeParse({ ...commit, knowledgeBody: "must never cross control API" }).success).toBe(false);
    expect(p2ControlRequestSchema.safeParse({ ...previewRequest, limit: 101 }).success).toBe(false);
  });

  it("validates bounded legacy migration views without knowledge prose", () => {
    const preview = {
      schemaVersion: 1,
      migrationId: "migration_demo_01",
      migrationVersion: "legacy-code-knowledge-v1",
      projectId: "project_demo_01",
      sourceRegistryRevision: 7,
      status: "READY",
      revision: 0,
      scannedCount: 3,
      migratableCount: 1,
      alreadyCurrentCount: 1,
      skippedCount: 1,
      failedCount: 0,
      rollbackConflictCount: 0,
      summaryHash: hash("e"),
      createdAt: "2026-08-19T04:00:00.000Z",
      updatedAt: "2026-08-19T04:00:00.000Z",
    } as const;
    expect(legacyMigrationPreviewSchema.parse(preview)).toEqual(preview);
    expect(legacyMigrationPreviewSchema.safeParse({ ...preview, scannedCount: 4 }).success).toBe(false);
    const item = {
      schemaVersion: 1,
      migrationId: "migration_demo_01",
      ordinal: 0,
      assetId: "asset_demo_01",
      assetVersion: 1,
      assetContentHash: hash("f"),
      assetIndexVersion: 7,
      classification: "MIGRATABLE",
      source: "SYMBOL_ANCHOR",
      candidateId: "candidate_demo_01",
      assertionsHash: hash("a"),
      assertionKinds: ["SYMBOL_EXISTS"],
      reasonCodes: ["EXPLICIT_SYMBOL_ANCHOR"],
      status: "PENDING",
      updatedAt: "2026-08-19T04:00:00.000Z",
    } as const;
    expect(legacyMigrationItemSchema.parse(item)).toEqual(item);
    expect(legacyMigrationItemSchema.safeParse({ ...item, body: "private knowledge prose" }).success).toBe(false);
  });
});

describe("P2 bidirectional provenance contract", () => {
  it("accepts bounded incoming/outgoing edges around the requested root", () => {
    const result = bidirectionalProvenanceSchema.parse(REDACTED_P2_CONTRACT_FIXTURES.provenance);
    expect(result.upstream[0]?.to).toEqual(result.root);
    expect(result.downstream[0]?.from).toEqual(result.root);
  });

  it("rejects edges that are assigned to the wrong direction and incomplete pagination", () => {
    const fixture = REDACTED_P2_CONTRACT_FIXTURES.provenance;
    expect(bidirectionalProvenanceSchema.safeParse({
      ...fixture,
      upstream: fixture.downstream,
      downstream: fixture.upstream,
    }).success).toBe(false);
    expect(bidirectionalProvenanceSchema.safeParse({
      ...fixture,
      completeness: "TRUNCATED",
      nextCursor: undefined,
    }).success).toBe(false);
  });

  it("preserves knowledge id/version and existing DERIVED_FROM relation semantics", () => {
    const knowledge = { type: "KNOWLEDGE_VERSION", knowledge: { id: "knowledge_demo_01", version: 2 } } as const;
    const source = { type: "KNOWLEDGE_VERSION", knowledge: { id: "knowledge_source_01", version: 1 } } as const;
    expect(knowledgeVersionRefSchema.parse(knowledge.knowledge)).toEqual({ id: "knowledge_demo_01", version: 2 });
    expect(provenanceEdgeSchema.parse({
      edgeId: "edge_candidate_knowledge_01",
      relationType: "DERIVED_FROM",
      from: knowledge,
      to: source,
      reason: "preserves the existing KnowledgeRelation reason field",
      observedAt: "2026-08-04T08:00:00.000Z",
    })).toMatchObject({ relationType: "DERIVED_FROM", from: knowledge, reason: expect.any(String) });
  });

  it("keeps ID, revision, relation and array bounds strict", () => {
    const fixture = REDACTED_P2_CONTRACT_FIXTURES.provenance;
    expect(extractionSnapshotSchema.safeParse({
      ...REDACTED_P2_CONTRACT_FIXTURES.snapshot,
      snapshotId: "bad\nid",
    }).success).toBe(false);
    expect(bidirectionalProvenanceSchema.safeParse({
      ...fixture,
      root: { type: "SNAPSHOT", snapshotId: "bad\nid", revision: 1 },
    }).success).toBe(false);
    expect(bidirectionalProvenanceSchema.safeParse({ ...fixture, unknown: true }).success).toBe(false);
    expect(provenanceEdgeSchema.safeParse({
      ...fixture.upstream[0],
      relationType: "UNKNOWN_RELATION",
    }).success).toBe(false);
    expect(provenanceEdgeSchema.safeParse({
      ...fixture.upstream[0],
      relationType: "SESSION_CONTAINS_TURN",
    }).success).toBe(false);
    expect(provenanceEdgeSchema.safeParse({
      edgeId: "edge_invalid_knowledge_relation",
      relationType: "DERIVED_FROM",
      from: { type: "KNOWLEDGE_VERSION", knowledge: { id: "knowledge_demo_01", version: 2 } },
      to: { type: "CANDIDATE", candidateId: "candidate_demo_01" },
      observedAt: "2026-08-04T08:00:00.000Z",
    }).success).toBe(false);
    expect(bidirectionalProvenanceSchema.safeParse({
      ...fixture,
      upstream: Array.from({ length: 1_001 }, () => fixture.upstream[0]),
    }).success).toBe(false);
    expect(bidirectionalProvenanceSchema.safeParse({
      ...fixture,
      downstream: [{ ...fixture.downstream[0], edgeId: "edge_event_snapshot_01" }],
    }).success).toBe(false);
  });
});
