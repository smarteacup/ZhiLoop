import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { KnowledgeCandidate } from "@zhiloop/domain";
import { describe, expect, it } from "vitest";

import { canonical, knowledgeRepairDraftId, repairDigest } from "./identity.js";
import { SqliteKnowledgeRepairDraftStore } from "./store.js";
import type { CreateKnowledgeRepairDraftInput } from "./types.js";

const NOW = "2026-08-19T01:00:00.000Z";

function candidate(candidateId = "candidate-old"): KnowledgeCandidate {
  return {
    schemaVersion: 1, candidateId, compilerVersion: "compiler-1", status: "PROPOSED",
    subjectKey: "project.module.behavior", kind: "IMPLEMENTATION",
    scopeHint: { level: "PROJECT", projectId: "project-1", reasonCodes: ["PROJECT_MATCH"] },
    title: "Behavior", summary: "The old behavior", body: "The old behavior is implemented by OldSymbol.",
    sourceEpisodes: ["episode-1"], confidence: 0.9, createdAt: NOW, correlationId: "correlation-1",
    assertions: [{ assertionId: `assertion-${candidateId}`, candidateId, kind: "SYMBOL_EXISTS",
      parameters: { projectId: "project-1", symbol: "OldSymbol", path: "src/old.ts" }, createdAt: NOW }],
    evidenceHints: [],
  };
}

function input(overrides: Partial<CreateKnowledgeRepairDraftInput> = {}): CreateKnowledgeRepairDraftInput {
  const old = candidate();
  return {
    projectId: "project-1",
    sourceKnowledge: { assetId: "asset-1", assetVersion: 3, contentHash: "a".repeat(64),
      lifecycleStatus: "VERIFIED", candidate: old },
    conflict: { runId: "vrun-conflict-1", codeRevision: "git-revision-2", graphRevision: "graph-2", completedAt: NOW },
    changedAssertions: [{ assertionId: old.assertions[0]!.assertionId, assertionKind: "SYMBOL_EXISTS",
      verificationStatus: "UNSUPPORTED", reasonCodes: ["SYMBOL_NOT_FOUND"], evidenceId: "evidence-1" }],
    reasonCodes: ["FINGERPRINT_CHANGED", "ASSERTION_UNSUPPORTED"], createdAt: NOW, ...overrides,
  };
}

describe("SqliteKnowledgeRepairDraftStore", () => {
  it("creates one deterministic pending draft and replays the same conflict", () => {
    const store = new SqliteKnowledgeRepairDraftStore(":memory:");
    const first = store.create(input());
    const second = store.create(input());
    expect(first).toMatchObject({ status: "CREATED", draft: { status: "PENDING", revision: 0,
      inheritedAuthorization: false } });
    expect(first.draft.proposedCandidate).toBeUndefined();
    expect(second).toEqual({ status: "IDEMPOTENT", draft: first.draft });
    expect(first.draft.draftId).toBe(knowledgeRepairDraftId(input()));
    expect(store.getByConflict("asset-1", 3, "vrun-conflict-1")).toEqual(first.draft);
    expect(() => store.create(input({ reasonCodes: ["DIFFERENT"] }))).toThrow("IDEMPOTENCY_CONFLICT");
    store.close();
    expect(() => store.get(first.draft.draftId)).toThrow("STORE_CLOSED");
  });

  it("persists across restart and pages deterministically", () => {
    const filename = join(mkdtempSync(join(tmpdir(), "zhiloop-repair-")), "repair.sqlite");
    const firstStore = new SqliteKnowledgeRepairDraftStore(filename);
    const first = firstStore.create(input()).draft;
    firstStore.create(input({ sourceKnowledge: { ...input().sourceKnowledge, assetId: "asset-2" },
      conflict: { ...input().conflict, runId: "vrun-conflict-2" }, createdAt: "2026-08-19T02:00:00.000Z" }));
    firstStore.close();
    const reopened = new SqliteKnowledgeRepairDraftStore(filename);
    expect(reopened.get(first.draftId)).toEqual(first);
    const page = reopened.list({ projectId: "project-1", statuses: ["PENDING"], limit: 1 });
    expect(page.items).toHaveLength(1); expect(page.next).toBeDefined();
    expect(reopened.list({ assetId: first.sourceKnowledge.assetId, assetVersion: first.sourceKnowledge.assetVersion,
      limit: 10 }).items).toEqual([first]);
    expect(reopened.list({ projectId: "project-1", statuses: ["PENDING"], limit: 1, after: page.next! }).items).toHaveLength(1);
    reopened.close();
  });

  it("uses revision CAS and keeps every replacement candidate proposed", () => {
    const store = new SqliteKnowledgeRepairDraftStore(":memory:");
    const pending = store.create(input()).draft;
    const replacement = candidate("candidate-new");
    const ready = store.attachCandidate({ draftId: pending.draftId, expectedRevision: 0, effectKey: "effect-attach",
      candidate: replacement, updatedAt: "2026-08-19T01:01:00.000Z" });
    expect(ready).toMatchObject({ status: "TRANSITIONED", draft: { status: "READY", revision: 1,
      proposedCandidate: { candidateId: "candidate-new", status: "PROPOSED" }, inheritedAuthorization: false } });
    expect(store.attachCandidate({ draftId: pending.draftId, expectedRevision: 0, effectKey: "effect-attach",
      candidate: replacement, updatedAt: "2026-08-19T01:01:00.000Z" })).toEqual(ready);
    expect(() => store.dismiss({ draftId: pending.draftId, expectedRevision: 0, effectKey: "effect-stale",
      reason: "stale command", updatedAt: "2026-08-19T01:02:00.000Z" })).toThrow("REVISION_CONFLICT");
    expect(() => store.attachCandidate({ draftId: pending.draftId, expectedRevision: 1, effectKey: "effect-authority",
      candidate: { ...replacement, candidateId: "candidate-bad", status: "VERIFIED" } as unknown as KnowledgeCandidate,
      updatedAt: "2026-08-19T01:02:00.000Z" })).toThrow("AUTHORITY_INVALID");
    const promoted = store.promote({ draftId: pending.draftId, expectedRevision: 1, effectKey: "effect-promote",
      receipt: { receiptId: "receipt-1", candidateId: "candidate-new", acceptedAt: "2026-08-19T01:02:00.000Z" },
      updatedAt: "2026-08-19T01:02:00.000Z" });
    expect(promoted.draft.status).toBe("PROMOTED");
    expect(store.promote({ draftId: pending.draftId, expectedRevision: 1, effectKey: "effect-promote",
      receipt: { receiptId: "receipt-1", candidateId: "candidate-new", acceptedAt: "2026-08-19T01:02:00.000Z" },
      updatedAt: "2026-08-19T01:02:00.000Z" })).toEqual(promoted);
    expect(store.attachCandidate({ draftId: pending.draftId, expectedRevision: 0, effectKey: "effect-attach",
      candidate: replacement, updatedAt: "2026-08-19T01:01:00.000Z" })).toEqual(ready);
    expect(() => store.dismiss({ draftId: pending.draftId, expectedRevision: 2, effectKey: "effect-terminal",
      reason: "too late", updatedAt: "2026-08-19T01:03:00.000Z" })).toThrow("STATUS_CONFLICT");
    store.close();
  });

  it("supports dismissal and terminal generator failure without a candidate", () => {
    const store = new SqliteKnowledgeRepairDraftStore(":memory:");
    const dismissed = store.dismiss({ draftId: store.create(input()).draft.draftId, expectedRevision: 0,
      effectKey: "effect-dismiss", reason: "obsolete knowledge", updatedAt: "2026-08-19T01:01:00.000Z" });
    expect(dismissed.draft).toMatchObject({ status: "DISMISSED", dismissalReason: "obsolete knowledge" });
    const other = store.create(input({ sourceKnowledge: { ...input().sourceKnowledge, assetId: "asset-failed" },
      conflict: { ...input().conflict, runId: "vrun-failed" } })).draft;
    const failed = store.fail({ draftId: other.draftId, expectedRevision: 0, effectKey: "effect-fail",
      code: "NO_GROUNDED_REPLACEMENT", updatedAt: "2026-08-19T01:02:00.000Z" });
    expect(failed.draft).toMatchObject({ status: "FAILED", failure: { code: "NO_GROUNDED_REPLACEMENT", retryable: false } });
    expect(() => store.promote({ draftId: other.draftId, expectedRevision: 1, effectKey: "effect-no-receipt",
      receipt: { receiptId: "receipt-2", candidateId: "candidate-new", acceptedAt: "2026-08-19T01:03:00.000Z" },
      updatedAt: "2026-08-19T01:03:00.000Z" }))
      .toThrow("PROMOTION_INVALID");
    store.close();
  });

  it("rejects conflicting effects, invalid bounds, and corrupt stored payloads", () => {
    const filename = join(mkdtempSync(join(tmpdir(), "zhiloop-repair-corrupt-")), "repair.sqlite");
    const store = new SqliteKnowledgeRepairDraftStore(filename); const draft = store.create(input()).draft;
    store.dismiss({ draftId: draft.draftId, expectedRevision: 0, effectKey: "effect-shared", reason: "one", updatedAt: NOW });
    expect(() => store.dismiss({ draftId: draft.draftId, expectedRevision: 0, effectKey: "effect-shared", reason: "two", updatedAt: NOW }))
      .toThrow("EFFECT_CONFLICT");
    expect(() => store.list({ limit: 0 })).toThrow("LIST_LIMIT_INVALID");
    expect(() => store.create(input({ changedAssertions: [] }))).toThrow("ASSERTIONS_INVALID");
    store.close();
    const database = new DatabaseSync(filename);
    database.prepare("UPDATE knowledge_repair_drafts SET payload_json=? WHERE draft_id=?").run("{}", draft.draftId);
    database.close();
    const corrupt = new SqliteKnowledgeRepairDraftStore(filename);
    expect(() => corrupt.get(draft.draftId)).toThrow("CORRUPT");
    corrupt.close();
  });

  it("validates candidate and query boundaries while allowing multiline knowledge", () => {
    const store = new SqliteKnowledgeRepairDraftStore(":memory:");
    const multiline = input({ sourceKnowledge: { ...input().sourceKnowledge,
      candidate: { ...candidate(), summary: "line one\nline two", body: "first\nsecond" } } });
    expect(store.create(multiline).draft.sourceKnowledge.candidate.body).toContain("\n");
    const badInputs: Array<[CreateKnowledgeRepairDraftInput, string]> = [
      [input({ projectId: "." }), "PROJECT_ID_INVALID"],
      [input({ sourceKnowledge: { ...input().sourceKnowledge, assetVersion: 0 } }), "SOURCE_INVALID"],
      [input({ sourceKnowledge: { ...input().sourceKnowledge, contentHash: "not-a-hash" } }), "SOURCE_INVALID"],
      [input({ sourceKnowledge: { ...input().sourceKnowledge,
        candidate: { ...candidate(), status: "VERIFIED" } as unknown as KnowledgeCandidate } }), "SOURCE_CANDIDATE_INVALID"],
      [input({ sourceKnowledge: { ...input().sourceKnowledge,
        candidate: { ...candidate(), confidence: 2 } } }), "CANDIDATE_INVALID"],
      [input({ sourceKnowledge: { ...input().sourceKnowledge, candidate: { ...candidate(), assertions: [{
        ...candidate().assertions[0]!, candidateId: "different-candidate" }] } } }), "ASSERTION_MISMATCH"],
      [input({ changedAssertions: [{ ...input().changedAssertions[0]!, verificationStatus: "SUPPORTED" as never }] }),
        "ASSERTIONS_INVALID"],
      [input({ reasonCodes: ["bad\nreason"] }), "REASON_CODE_INVALID"],
    ];
    for (const [value, error] of badInputs) expect(() => store.create(value)).toThrow(error);
    expect(store.get("unknown-draft")).toBeUndefined();
    expect(store.getByConflict("asset-unknown", 1, "run-unknown")).toBeUndefined();
    expect(() => store.getByConflict("asset-1", 0, "run-1")).toThrow("ASSET_VERSION_INVALID");
    expect(() => store.list({ limit: 1, statuses: [] })).toThrow("LIST_STATUS_INVALID");
    expect(() => store.list({ limit: 1, statuses: ["PENDING", "PENDING"] })).toThrow("LIST_STATUS_INVALID");
    expect(() => store.list({ limit: 1, after: { createdAt: "invalid", draftId: "cursor" } })).toThrow("CURSOR_TIME_INVALID");
    const draft = store.create(input({ sourceKnowledge: { ...input().sourceKnowledge, assetId: "asset-boundaries" },
      conflict: { ...input().conflict, runId: "run-boundaries" } })).draft;
    expect(() => store.attachCandidate({ draftId: draft.draftId, expectedRevision: 0, effectKey: "same-candidate",
      candidate: draft.sourceKnowledge.candidate, updatedAt: NOW })).toThrow("CANDIDATE_NOT_NEW");
    expect(() => store.dismiss({ draftId: "missing-draft", expectedRevision: 0, effectKey: "missing-effect",
      reason: "missing", updatedAt: NOW })).toThrow("NOT_FOUND");
    expect(() => store.dismiss({ draftId: draft.draftId, expectedRevision: -1, effectKey: "bad-revision",
      reason: "invalid", updatedAt: NOW })).toThrow("REVISION_INVALID");
    store.dismiss({ draftId: draft.draftId, expectedRevision: 0, effectKey: "time-effect",
      reason: "done", updatedAt: "2026-08-19T01:04:00.000Z" });
    expect(() => store.dismiss({ draftId: draft.draftId, expectedRevision: 1, effectKey: "time-regression",
      reason: "again", updatedAt: "2026-08-19T01:03:00.000Z" })).toThrow("TIME_REGRESSION");
    store.close();
  });

  it("fails closed on malformed payload and effect receipts", () => {
    const filename = join(mkdtempSync(join(tmpdir(), "zhiloop-repair-effects-")), "repair.sqlite");
    let store = new SqliteKnowledgeRepairDraftStore(filename);
    const draft = store.create(input()).draft;
    const request = { draftId: draft.draftId, expectedRevision: 0, effectKey: "effect-corrupt",
      reason: "dismiss", updatedAt: "2026-08-19T01:01:00.000Z" };
    store.dismiss(request); store.close();
    let database = new DatabaseSync(filename);
    database.prepare("UPDATE knowledge_repair_draft_effects SET result_json=?,result_hash=? WHERE effect_key=?")
      .run("{", repairDigest("{"), request.effectKey); database.close();
    store = new SqliteKnowledgeRepairDraftStore(filename);
    expect(() => store.dismiss(request)).toThrow("EFFECT_CORRUPT"); store.close();
    database = new DatabaseSync(filename);
    const malformed = canonical({ status: "TRANSITIONED", draft: { ...draft, draftId: "wrong", revision: 1 } });
    database.prepare("UPDATE knowledge_repair_draft_effects SET result_json=?,result_hash=? WHERE effect_key=?")
      .run(malformed, repairDigest(malformed), request.effectKey); database.close();
    store = new SqliteKnowledgeRepairDraftStore(filename);
    expect(() => store.dismiss(request)).toThrow("EFFECT_CORRUPT"); store.close();
    database = new DatabaseSync(filename);
    database.prepare("UPDATE knowledge_repair_drafts SET payload_json=?,payload_hash=? WHERE draft_id=?")
      .run("{", repairDigest("{"), draft.draftId); database.close();
    store = new SqliteKnowledgeRepairDraftStore(filename);
    expect(() => store.get(draft.draftId)).toThrow("CORRUPT"); store.close();
  });
});
