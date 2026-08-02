import type { ConfirmationRequest, ConfirmationResolution } from "@zhiloop/domain";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { SqliteConfirmationWritebackRepository } from "./repository.js";

const request: ConfirmationRequest = {
  schemaVersion: 1, confirmationId: "confirmation-a", sessionId: "session-a", turnId: "turn-20", turnOrdinal: 20,
  triggerId: "trigger-a", kind: "KNOWLEDGE_CONFLICT", subjectIds: ["knowledge-a"], question: "如何处理候选？",
  options: [
    { optionId: "keep-proposed", label: "保持候选", effect: "KEEP_PROPOSED" },
    { optionId: "reject-candidate", label: "拒绝候选", effect: "REJECT_CANDIDATE" },
    { optionId: "accept-candidate", label: "采用候选", effect: "ACCEPT_CANDIDATE" },
  ],
  safeDefaultOptionId: "keep-proposed", createdAt: "2026-08-02T03:00:00.000Z",
};
const targets = [{ subjectId: "knowledge-a", expectedRevision: "candidate-v1" }] as const;

function resolution(overrides: Partial<ConfirmationResolution> = {}): ConfirmationResolution {
  return {
    schemaVersion: 1, resolutionId: "resolution-a", confirmationId: "confirmation-a", sessionId: "session-a",
    requestTurnId: "turn-20", responseTurnId: "turn-21", responseEventId: "event-reply",
    responseKind: "OPTION", responseTextHash: "a".repeat(64), selectedOptionId: "accept-candidate",
    effect: "ACCEPT_CANDIDATE", subjectIds: ["knowledge-a"],
    relations: [{ subjectId: "knowledge-a", relation: "CONFIRMS", beforeRevision: "candidate-v1", afterRevision: "asset-v1" }],
    resolvedAt: "2026-08-02T03:01:00.000Z", ...overrides,
  };
}

describe("SqliteConfirmationWritebackRepository", () => {
  it("saves immutable requests idempotently and returns exact target snapshots", () => {
    const repository = new SqliteConfirmationWritebackRepository(":memory:");
    expect(repository.save(request, targets)).toBe("SAVED");
    expect(repository.save(structuredClone(request), structuredClone(targets))).toBe("EXISTING");
    expect(repository.pending("session-a")).toEqual([{ request, targets }]);
    expect(() => repository.save({ ...request, question: "changed" }, targets)).toThrow("identity conflict");
    expect(() => repository.save(request, [{ subjectId: "other", expectedRevision: "v1" }])).toThrow("targets");
    repository.close();
  });

  it("claims once, allows only the same deterministic retry, and fences conflicting replies", () => {
    const repository = new SqliteConfirmationWritebackRepository(":memory:");
    repository.save(request, targets);
    expect(repository.claim("confirmation-a", "resolution-a", "event-reply", "a".repeat(64))).toBe("CLAIMED");
    expect(repository.claim("confirmation-a", "resolution-a", "event-reply", "a".repeat(64))).toBe("RETRY");
    expect(repository.claim("confirmation-a", "resolution-b", "event-other", "b".repeat(64))).toBe("CONFLICT");
    repository.close();
  });

  it("completes an owned resolution, restores it, and remains idempotent", () => {
    const repository = new SqliteConfirmationWritebackRepository(":memory:");
    repository.save(request, targets);
    repository.claim("confirmation-a", "resolution-a", "event-reply", "a".repeat(64));
    expect(repository.complete(resolution())).toBe("COMPLETED");
    expect(repository.complete(structuredClone(resolution()))).toBe("EXISTING");
    expect(repository.pending("session-a")).toEqual([]);
    expect(repository.resolution("confirmation-a")).toEqual(resolution());
    expect(repository.claim("confirmation-a", "resolution-a", "event-reply", "a".repeat(64))).toBe("RESOLVED");
    repository.close();
  });

  it("rejects wrong option effects, expanded subjects, and stale before revisions", () => {
    for (const invalid of [
      resolution({ selectedOptionId: "reject-candidate", effect: "ACCEPT_CANDIDATE" }),
      resolution({ subjectIds: ["other"], relations: [{ subjectId: "other", relation: "CONFIRMS", beforeRevision: "candidate-v1", afterRevision: "asset-v1" }] }),
      resolution({ relations: [{ subjectId: "knowledge-a", relation: "CONFIRMS", beforeRevision: "candidate-v2", afterRevision: "asset-v1" }] }),
    ]) {
      const repository = new SqliteConfirmationWritebackRepository(":memory:");
      repository.save(request, targets);
      repository.claim("confirmation-a", "resolution-a", "event-reply", "a".repeat(64));
      expect(() => repository.complete(invalid)).toThrow();
      repository.close();
    }
  });

  it("rejects malformed public inputs and unowned completion", () => {
    const repository = new SqliteConfirmationWritebackRepository(":memory:");
    expect(() => repository.save({ ...request, safeDefaultOptionId: "accept-candidate" }, targets)).toThrow("schema");
    expect(() => repository.save(request, [{ subjectId: "knowledge-a", expectedRevision: "unsafe/revision" }])).toThrow("targets");
    expect(() => repository.pending("unsafe/session")).toThrow("query");
    expect(() => repository.claim("confirmation-a", "resolution-a", "event-a", "bad-hash")).toThrow("claim identity");
    expect(repository.claim("missing", "resolution-a", "event-a", "a".repeat(64))).toBe("CONFLICT");
    expect(() => repository.complete(resolution())).toThrow("does not exist");
    repository.save(request, targets);
    expect(() => repository.complete(resolution())).toThrow("does not own");
    expect(() => repository.resolution("unsafe/id")).toThrow("confirmationId");
    repository.close();
  });

  it("persists across reopen and rejects a future migration", () => {
    const directory = mkdtempSync(join(tmpdir(), "zhiloop-confirmation-"));
    const filename = join(directory, "writeback.sqlite");
    try {
      const first = new SqliteConfirmationWritebackRepository(filename);
      first.save(request, targets);
      first.close();
      const reopened = new SqliteConfirmationWritebackRepository(filename);
      expect(reopened.pending("session-a", "confirmation-a")).toHaveLength(1);
      reopened.close();

      const futureFile = join(directory, "future.sqlite");
      const database = new DatabaseSync(futureFile);
      database.exec(`
        CREATE TABLE confirmation_writeback_meta (component TEXT PRIMARY KEY, version INTEGER NOT NULL);
        INSERT INTO confirmation_writeback_meta VALUES ('confirmation-writeback', 2);
      `);
      database.close();
      expect(() => new SqliteConfirmationWritebackRepository(futureFile)).toThrow("newer than supported");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("detects conflicting completion after a resolution is already durable", () => {
    const repository = new SqliteConfirmationWritebackRepository(":memory:");
    repository.save(request, targets);
    repository.claim("confirmation-a", "resolution-a", "event-reply", "a".repeat(64));
    repository.complete(resolution());
    expect(() => repository.complete(resolution({ resolvedAt: "2026-08-02T03:02:00.000Z" }))).toThrow("resolution conflict");
    expect(repository.claim("confirmation-a", "resolution-other", "event-other", "b".repeat(64))).toBe("CONFLICT");
    repository.close();
  });

  it("fails after close and supports idempotent close", () => {
    const repository = new SqliteConfirmationWritebackRepository(":memory:");
    repository.close();
    repository.close();
    expect(() => repository.pending("session-a")).toThrow("closed");
  });
});
