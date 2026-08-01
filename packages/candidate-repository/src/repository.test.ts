import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { KnowledgeCandidate } from "@zhiloop/domain";
import {
  knowledgeExtractionInputHash,
  knowledgeExtractionKey,
  type KnowledgeExtractionRequest,
  type KnowledgeExtractionResult,
} from "@zhiloop/knowledge-compiler";

import { SqliteCandidateRepository } from "./repository.js";

function request(compilerVersion = "compiler-v1", promptVersion = "prompt-v1"): KnowledgeExtractionRequest {
  return {
    input: {
      schemaVersion: 1,
      episodeId: "episode-1",
      builderVersion: "episode-builder-v2",
      projectContext: { projectId: "project-1", portable: false },
      goal: "Persist candidates idempotently",
      goalRef: "event-goal",
      subgoals: [],
      corrections: [],
      actions: [],
      artifacts: [],
      outcomes: [],
      evidenceRefs: ["event-goal"],
    },
    compilerVersion,
    promptVersion,
    requestedAt: "2026-08-01T08:00:00.000Z",
    correlationId: "correlation-1",
  };
}

function candidate(source: KnowledgeExtractionRequest, candidateId = `candidate-${source.compilerVersion}`): KnowledgeCandidate {
  return {
    schemaVersion: 1,
    candidateId,
    compilerVersion: source.compilerVersion,
    status: "PROPOSED",
    subjectKey: `design.repository.${source.compilerVersion}`,
    kind: "DESIGN",
    scopeHint: { level: "PROJECT", projectId: "project-1", reasonCodes: ["EPISODE_PROJECT"] },
    title: `Repository design ${source.compilerVersion}`,
    summary: "Persist a versioned compilation batch.",
    body: "Claim before compiling and commit the complete result atomically.",
    sourceEpisodes: [source.input.episodeId],
    confidence: 0.9,
    assertions: [],
    evidenceHints: [{
      type: "USER_STATEMENT",
      sourceRef: "event-goal",
      projectId: "project-1",
      correlationId: source.correlationId,
    }],
    createdAt: source.requestedAt,
    correlationId: source.correlationId,
  };
}

function success(
  source: KnowledgeExtractionRequest,
  candidates: readonly KnowledgeCandidate[] = [candidate(source)],
): KnowledgeExtractionResult {
  return {
    extractionKey: knowledgeExtractionKey(source),
    inputHash: knowledgeExtractionInputHash(source),
    episodeId: source.input.episodeId,
    builderVersion: source.input.builderVersion,
    compilerVersion: source.compilerVersion,
    promptVersion: source.promptVersion,
    attempts: 1,
    status: "SUCCEEDED",
    candidates,
    diagnostics: [],
  };
}

function failure(
  source: KnowledgeExtractionRequest,
  status: "RETRYABLE" | "FAILED",
): KnowledgeExtractionResult {
  return {
    extractionKey: knowledgeExtractionKey(source),
    inputHash: knowledgeExtractionInputHash(source),
    episodeId: source.input.episodeId,
    builderVersion: source.input.builderVersion,
    compilerVersion: source.compilerVersion,
    promptVersion: source.promptVersion,
    attempts: 3,
    status,
    candidates: [],
    reason: status === "RETRYABLE" ? "TIMEOUT" : "ADAPTER_REJECTED",
    diagnostics: status === "RETRYABLE" ? [{ code: "SCHEMA_INVALID", path: "/candidates/0" }] : [],
  };
}

function repository(clock: () => Date = () => new Date("2026-08-01T08:00:00.000Z")) {
  let token = 0;
  return new SqliteCandidateRepository(":memory:", {
    clock,
    tokenFactory: () => `claim-${token += 1}`,
    defaultLeaseMs: 1_000,
  });
}

describe("SqliteCandidateRepository", () => {
  it("claims once, atomically saves a batch, and skips identical recompilation", () => {
    const repo = repository();
    const source = request();
    const first = repo.claim(source);
    expect(first).toMatchObject({ status: "ACQUIRED", claimToken: expect.any(String), batch: { status: "RUNNING", runCount: 1 } });
    expect(repo.claim(source).status).toBe("IN_PROGRESS");
    if (first.status !== "ACQUIRED") throw new Error("expected claim");

    const stored = repo.saveResult(first.claimToken, success(source));
    expect(stored).toMatchObject({
      status: "SUCCEEDED",
      runCount: 1,
      lastAttempts: 1,
      candidates: [{ candidateId: "candidate-compiler-v1", status: "PROPOSED" }],
    });
    expect(repo.claim(source)).toMatchObject({ status: "ALREADY_SUCCEEDED", batch: { candidates: stored.candidates } });
    expect(repo.claim({
      ...source,
      requestedAt: "2026-08-02T08:00:00.000Z",
      correlationId: "correlation-replay",
    }).status).toBe("ALREADY_SUCCEEDED");
    expect(repo.listCandidates()).toEqual([]);
    expect(repo.listCandidates({ includeProposed: true })).toEqual(stored.candidates);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.candidates[0]?.evidenceHints)).toBe(true);
    repo.close();
  });

  it("preserves separate compiler versions and supports explicit administrative filters", () => {
    const repo = repository();
    const v1 = request("compiler-v1");
    const v2 = request("compiler-v2");
    const first = repo.claim(v1);
    const second = repo.claim(v2);
    if (first.status !== "ACQUIRED" || second.status !== "ACQUIRED") throw new Error("expected claims");
    repo.saveResult(first.claimToken, success(v1));
    repo.saveResult(second.claimToken, success(v2));

    expect(knowledgeExtractionKey(v1)).not.toBe(knowledgeExtractionKey(v2));
    expect(repo.listCandidates({ includeProposed: true }).map((item) => item.compilerVersion)).toEqual([
      "compiler-v1",
      "compiler-v2",
    ]);
    expect(repo.listCandidates({ includeProposed: true, compilerVersion: "compiler-v2" })).toHaveLength(1);
    expect(repo.listCandidates({ includeProposed: true, episodeId: "other-episode" })).toEqual([]);
    repo.close();
  });

  it("reclaims RETRYABLE work and retains failure diagnostics until the next claim", () => {
    const repo = repository();
    const source = request();
    const first = repo.claim(source);
    if (first.status !== "ACQUIRED") throw new Error("expected claim");
    const retryable = repo.saveResult(first.claimToken, failure(source, "RETRYABLE"));
    expect(retryable).toMatchObject({
      status: "RETRYABLE",
      runCount: 1,
      lastAttempts: 3,
      failureReason: "TIMEOUT",
      diagnostics: [{ code: "SCHEMA_INVALID", path: "/candidates/0" }],
    });

    const retry = repo.claim(source);
    expect(retry).toMatchObject({ status: "ACQUIRED", claimToken: expect.any(String), batch: { runCount: 2, diagnostics: [] } });
    expect(retry.status === "ACQUIRED" && retry.claimToken).not.toBe(first.claimToken);
    if (retry.status !== "ACQUIRED") throw new Error("expected retry claim");
    expect(repo.saveResult(retry.claimToken, success(source))).toMatchObject({ status: "SUCCEEDED", runCount: 2 });
    repo.close();
  });

  it("does not automatically reclaim terminal failures", () => {
    const repo = repository();
    const source = request();
    const claim = repo.claim(source);
    if (claim.status !== "ACQUIRED") throw new Error("expected claim");
    repo.saveResult(claim.claimToken, failure(source, "FAILED"));
    expect(repo.claim(source)).toMatchObject({
      status: "TERMINAL_FAILED",
      batch: { failureReason: "ADAPTER_REJECTED", candidates: [] },
    });
    repo.close();
  });

  it("takes over an expired lease and rejects the stale worker result", () => {
    let current = new Date("2026-08-01T08:00:00.000Z");
    const repo = repository(() => current);
    const source = request();
    const stale = repo.claim(source, { leaseMs: 100 });
    if (stale.status !== "ACQUIRED") throw new Error("expected claim");
    current = new Date("2026-08-01T08:00:00.101Z");
    const takeover = repo.claim(source, { leaseMs: 100 });
    expect(takeover).toMatchObject({ status: "ACQUIRED", claimToken: expect.any(String), batch: { runCount: 2 } });
    expect(takeover.status === "ACQUIRED" && takeover.claimToken).not.toBe(stale.claimToken);
    expect(() => repo.saveResult(stale.claimToken, success(source))).toThrow("stale or invalid claim token");
    if (takeover.status !== "ACQUIRED") throw new Error("expected takeover");
    expect(repo.saveResult(takeover.claimToken, success(source)).status).toBe("SUCCEEDED");
    repo.close();
  });

  it("renews a long-running claim without changing its fencing token", () => {
    let current = new Date("2026-08-01T08:00:00.000Z");
    const repo = repository(() => current);
    const source = request();
    const claim = repo.claim(source, { leaseMs: 100 });
    if (claim.status !== "ACQUIRED") throw new Error("expected claim");
    current = new Date("2026-08-01T08:00:00.050Z");
    const renewed = repo.renewClaim(knowledgeExtractionKey(source), claim.claimToken, { leaseMs: 100 });
    expect(renewed).toMatchObject({ status: "RUNNING", runCount: 1, leaseExpiresAt: "2026-08-01T08:00:00.150Z" });
    current = new Date("2026-08-01T08:00:00.101Z");
    expect(repo.claim(source, { leaseMs: 100 }).status).toBe("IN_PROGRESS");
    expect(repo.saveResult(claim.claimToken, success(source)).status).toBe("SUCCEEDED");
    expect(() => repo.renewClaim(knowledgeExtractionKey(source), claim.claimToken)).toThrow("stale or invalid");
    repo.close();
  });

  it("serializes claims across connections and keeps generations unique with repeated entropy", () => {
    const directory = mkdtempSync(join(tmpdir(), "zhiloop-candidate-claim-"));
    const filename = join(directory, "knowledge.db");
    let current = new Date("2026-08-01T08:00:00.000Z");
    const options = { clock: () => current, tokenFactory: () => "same-entropy", defaultLeaseMs: 100 };
    try {
      const firstRepository = new SqliteCandidateRepository(filename, options);
      const secondRepository = new SqliteCandidateRepository(filename, options);
      const source = request();
      const first = firstRepository.claim(source);
      expect(secondRepository.claim(source).status).toBe("IN_PROGRESS");
      if (first.status !== "ACQUIRED") throw new Error("expected claim");

      current = new Date("2026-08-01T08:00:00.101Z");
      const takeover = secondRepository.claim(source);
      if (takeover.status !== "ACQUIRED") throw new Error("expected takeover");
      expect(takeover.claimToken).not.toBe(first.claimToken);
      expect(() => firstRepository.saveResult(first.claimToken, success(source))).toThrow("stale");
      expect(secondRepository.saveResult(takeover.claimToken, success(source)).status).toBe("SUCCEEDED");
      firstRepository.close();
      secondRepository.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back a candidate collision without partially completing the new batch", () => {
    const repo = repository();
    const v1 = request("compiler-v1");
    const v2 = request("compiler-v2");
    const first = repo.claim(v1);
    const second = repo.claim(v2);
    if (first.status !== "ACQUIRED" || second.status !== "ACQUIRED") throw new Error("expected claims");
    repo.saveResult(first.claimToken, success(v1, [candidate(v1, "shared-candidate")]));

    expect(() => repo.saveResult(second.claimToken, success(v2, [candidate(v2, "shared-candidate")]))).toThrow();
    expect(repo.getBatch(knowledgeExtractionKey(v2))).toMatchObject({ status: "RUNNING", candidates: [] });
    expect(repo.listCandidates({ includeProposed: true })).toHaveLength(1);
    repo.close();
  });

  it("rejects result identity mismatches before writing candidates", () => {
    const repo = repository();
    const source = request();
    const claim = repo.claim(source);
    if (claim.status !== "ACQUIRED") throw new Error("expected claim");
    const mismatched = { ...success(source), inputHash: "wrong-input-hash" } as KnowledgeExtractionResult;
    expect(() => repo.saveResult(claim.claimToken, mismatched)).toThrow("identity does not match");
    expect(repo.getBatch(knowledgeExtractionKey(source))).toMatchObject({ status: "RUNNING", candidates: [] });
    repo.close();
  });

  it("persists batches across reopen and protects the database file", () => {
    const directory = mkdtempSync(join(tmpdir(), "zhiloop-candidates-"));
    const filename = join(directory, "knowledge.db");
    try {
      const source = request();
      const first = new SqliteCandidateRepository(filename, { tokenFactory: () => "claim-persist" });
      const claim = first.claim(source);
      if (claim.status !== "ACQUIRED") throw new Error("expected claim");
      first.saveResult(claim.claimToken, success(source));
      first.close();

      if (process.platform !== "win32") expect(statSync(filename).mode & 0o777).toBe(0o600);
      const reopened = new SqliteCandidateRepository(filename);
      expect(reopened.getBatch(knowledgeExtractionKey(source))).toMatchObject({
        status: "SUCCEEDED",
        candidates: [{ candidateId: "candidate-compiler-v1" }],
      });
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("detects candidate index corruption instead of trusting denormalized columns", () => {
    const directory = mkdtempSync(join(tmpdir(), "zhiloop-candidate-corrupt-"));
    const filename = join(directory, "knowledge.db");
    try {
      const source = request();
      const repository = new SqliteCandidateRepository(filename, { tokenFactory: () => "entropy" });
      const claim = repository.claim(source);
      if (claim.status !== "ACQUIRED") throw new Error("expected claim");
      repository.saveResult(claim.claimToken, success(source));
      repository.close();

      const database = new DatabaseSync(filename);
      database.prepare("UPDATE knowledge_candidates SET subject_key = ?").run("design.corrupt.topic");
      database.close();
      const reopened = new SqliteCandidateRepository(filename);
      expect(() => reopened.getBatch(knowledgeExtractionKey(source))).toThrow("index columns failed integrity");
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a repository migration created by a newer runtime", () => {
    const directory = mkdtempSync(join(tmpdir(), "zhiloop-candidate-future-"));
    const filename = join(directory, "knowledge.db");
    try {
      const database = new DatabaseSync(filename);
      database.exec(`
        CREATE TABLE candidate_repository_meta (
          component TEXT PRIMARY KEY,
          version INTEGER NOT NULL CHECK (version >= 0)
        );
        INSERT INTO candidate_repository_meta(component, version) VALUES ('candidate-repository', 2);
      `);
      database.close();
      expect(() => new SqliteCandidateRepository(filename)).toThrow("newer than supported");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("validates leases, list bounds, lifecycle, and unclaimed results", () => {
    expect(() => new SqliteCandidateRepository(":memory:", { defaultLeaseMs: 0 })).toThrow("leaseMs");
    const repo = repository();
    expect(() => repo.claim(request(), { leaseMs: 0 })).toThrow("leaseMs");
    expect(() => repo.listCandidates({ limit: 0 })).toThrow("limit");
    expect(repo.getBatch("missing")).toBeUndefined();
    expect(() => repo.saveResult("claim-none", success(request()))).toThrow("was not claimed");
    repo.close();
    repo.close();
    expect(() => repo.claim(request())).toThrow("closed");
  });

  it("rejects impossible or tampered extraction result shapes", () => {
    const repo = repository();
    const source = request();
    const claim = repo.claim(source);
    if (claim.status !== "ACQUIRED") throw new Error("expected claim");
    expect(() => repo.saveResult(claim.claimToken, {
      ...failure(source, "RETRYABLE"),
      candidates: [candidate(source)],
    } as unknown as KnowledgeExtractionResult)).toThrow("cannot contain candidates");
    expect(() => repo.saveResult(claim.claimToken, {
      ...success(source),
      diagnostics: [{ code: "SCHEMA_INVALID", path: "/" }],
    } as unknown as KnowledgeExtractionResult)).toThrow("cannot contain diagnostics");
    expect(() => repo.saveResult(claim.claimToken, {
      ...success(source),
      status: "PARTIAL",
    } as unknown as KnowledgeExtractionResult)).toThrow("unsupported extraction result status");
    expect(() => repo.saveResult(claim.claimToken, {
      ...success(source),
      attempts: 11,
    })).toThrow("result attempts");
    expect(() => repo.saveResult(claim.claimToken, {
      ...failure(source, "RETRYABLE"),
      reason: "UNKNOWN",
    } as unknown as KnowledgeExtractionResult)).toThrow("failure reason");
    expect(() => repo.saveResult(claim.claimToken, {
      ...failure(source, "RETRYABLE"),
      diagnostics: [{ code: "UNKNOWN", path: "/" }],
    } as unknown as KnowledgeExtractionResult)).toThrow("diagnostics are invalid");
    expect(repo.getBatch(knowledgeExtractionKey(source))).toMatchObject({ status: "RUNNING", candidates: [] });
    repo.close();
  });

  it("validates candidate batches before entering the storage transaction", () => {
    const repo = repository();
    const source = request();
    const claim = repo.claim(source);
    if (claim.status !== "ACQUIRED") throw new Error("expected claim");
    expect(() => repo.saveResult(claim.claimToken, success(source, [
      { ...candidate(source), title: "" },
    ] as KnowledgeCandidate[]))).toThrow("Candidate schema");
    expect(() => repo.saveResult(claim.claimToken, success(source, [
      candidate(source, "duplicate"),
      candidate(source, "duplicate"),
    ]))).toThrow("duplicate candidateId");
    expect(() => repo.saveResult(claim.claimToken, success(source, [
      { ...candidate(source), compilerVersion: "compiler-v2" },
    ] as KnowledgeCandidate[]))).toThrow("compilation identity");
    expect(() => repo.saveResult(claim.claimToken, success(
      source,
      Array.from({ length: 10_001 }, () => candidate(source)),
    ))).toThrow("at most 10000");
    expect(repo.getBatch(knowledgeExtractionKey(source))).toMatchObject({ status: "RUNNING", candidates: [] });
    repo.close();
  });
});
