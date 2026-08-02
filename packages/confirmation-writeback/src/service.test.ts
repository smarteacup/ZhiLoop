import type { ConfirmationEffect, ConfirmationRelationType, ConfirmationRequest } from "@zhiloop/domain";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { SqliteConfirmationWritebackRepository } from "./repository.js";
import { ConfirmationWritebackService } from "./service.js";
import type {
  ConfirmationEffectCommand,
  ConfirmationEffectPort,
  ConfirmationReply,
  ConfirmationWritebackRepository,
  PendingConfirmation,
} from "./types.js";

const RELATION: Readonly<Record<ConfirmationEffect, ConfirmationRelationType>> = {
  KEEP_PROPOSED: "RETAINS", KEEP_CURRENT: "RETAINS", REJECT_CANDIDATE: "REJECTS", ACCEPT_CANDIDATE: "CONFIRMS",
  KEEP_PROJECT: "RETAINS", PROMOTE_GLOBAL: "PROMOTES", KEEP_RULE: "RETAINS", APPLY_OVERRIDE: "OVERRIDES",
  STOP_WITHOUT_EXPANSION: "RETAINS", CONTINUE_ORIGINAL_SCOPE: "CONTINUES",
};

function request(id = "confirmation-a", turnOrdinal = 20): ConfirmationRequest {
  return {
    schemaVersion: 1, confirmationId: id, sessionId: "session-a", turnId: `turn-${turnOrdinal}`, turnOrdinal,
    triggerId: `trigger-${id}`, kind: "KNOWLEDGE_CONFLICT", subjectIds: [`knowledge-${id}`], question: "如何处理候选？",
    options: [
      { optionId: "keep-proposed", label: "保持候选", effect: "KEEP_PROPOSED" },
      { optionId: "reject-candidate", label: "拒绝候选", effect: "REJECT_CANDIDATE" },
      { optionId: "accept-candidate", label: "采用候选", effect: "ACCEPT_CANDIDATE" },
    ],
    safeDefaultOptionId: "keep-proposed", createdAt: "2026-08-02T03:00:00.000Z",
  };
}

const reply: ConfirmationReply = {
  sessionId: "session-a", turnId: "turn-21", turnOrdinal: 21, eventId: "event-reply",
  statement: "采用候选", occurredAt: "2026-08-02T03:01:00.000Z", confirmationId: "confirmation-a",
};

function effectPort(): ConfirmationEffectPort {
  const seen = new Map<string, Awaited<ReturnType<ConfirmationEffectPort["apply"]>>>();
  return {
    apply: vi.fn(async (command: ConfirmationEffectCommand) => {
      const existing = seen.get(command.resolutionId);
      if (existing !== undefined) return existing;
      const value = {
        relations: command.targets.map((target) => ({
          subjectId: target.subjectId,
          relation: command.responseKind === "CORRECTION" ? "CORRECTS" as const : RELATION[command.effect],
          beforeRevision: target.expectedRevision,
          afterRevision: ["RETAINS", "CONTINUES"].includes(command.responseKind === "CORRECTION" ? "CORRECTS" : RELATION[command.effect])
            ? target.expectedRevision : `${target.expectedRevision}-next`,
        })),
      };
      seen.set(command.resolutionId, value);
      return value;
    }),
  };
}

function setup(port = effectPort()): { repository: SqliteConfirmationWritebackRepository; service: ConfirmationWritebackService; port: ConfirmationEffectPort } {
  const repository = new SqliteConfirmationWritebackRepository(":memory:");
  const value = request();
  repository.save(value, [{ subjectId: value.subjectIds[0]!, expectedRevision: "candidate-v1" }]);
  return { repository, service: new ConfirmationWritebackService(repository, port, { effectDeadlineMs: 1_000 }), port };
}

describe("ConfirmationWritebackService", () => {
  it("applies an explicit option only to the request subjects and persists version relations", async () => {
    const { repository, service, port } = setup();
    const result = await service.handle(reply);
    expect(result).toMatchObject({
      status: "RESOLVED",
      resolution: {
        effect: "ACCEPT_CANDIDATE", responseKind: "OPTION", subjectIds: ["knowledge-confirmation-a"],
        relations: [{ relation: "CONFIRMS", beforeRevision: "candidate-v1", afterRevision: "candidate-v1-next" }],
      },
    });
    expect(port.apply).toHaveBeenCalledOnce();
    const command = vi.mocked(port.apply).mock.calls[0]?.[0];
    expect(command?.targets).toEqual([{ subjectId: "knowledge-confirmation-a", expectedRevision: "candidate-v1" }]);
    repository.close();
  });

  it("records explicit rejection separately from silence and preserves correction lineage", async () => {
    const rejected = setup();
    expect((await rejected.service.handle({ ...reply, statement: "拒绝候选" })).resolution).toMatchObject({
      effect: "REJECT_CANDIDATE", responseKind: "OPTION", relations: [{ relation: "REJECTS" }],
    });
    rejected.repository.close();

    const corrected = setup();
    const result = await corrected.service.handle({ ...reply, statement: "不对，应该是按租户隔离连接池" });
    expect(result.resolution).toMatchObject({
      effect: "REJECT_CANDIDATE", responseKind: "CORRECTION", correctionStatementRef: "event-reply",
      relations: [{ relation: "CORRECTS", beforeRevision: "candidate-v1", afterRevision: "candidate-v1-next" }],
    });
    expect(result.resolution).not.toHaveProperty("responseText");
    corrected.repository.close();
  });

  it("does not infer generic acknowledgement and does not call the effect port", async () => {
    const { repository, service, port } = setup();
    expect(await service.handle({ ...reply, statement: "好的" })).toMatchObject({ status: "NO_EXPLICIT_CHOICE" });
    expect(port.apply).not.toHaveBeenCalled();
    expect(repository.pending("session-a")).toHaveLength(1);
    repository.close();
  });

  it("returns ambiguous choice without mutation when option labels are not unique", async () => {
    const repository = new SqliteConfirmationWritebackRepository(":memory:");
    const value = request();
    const ambiguous: ConfirmationRequest = {
      ...value,
      options: value.options.map((option) => ({ ...option, label: "选择" })),
    };
    repository.save(ambiguous, [{ subjectId: value.subjectIds[0]!, expectedRevision: "candidate-v1" }]);
    const port = effectPort();
    const service = new ConfirmationWritebackService(repository, port, { effectDeadlineMs: 1_000 });
    expect((await service.handle({ ...reply, statement: "选择" })).status).toBe("AMBIGUOUS_CHOICE");
    expect(port.apply).not.toHaveBeenCalled();
    repository.close();
  });

  it("requires an explicit confirmation ID when multiple requests are pending", async () => {
    const { repository, service } = setup();
    const other = request("confirmation-b", 19);
    repository.save(other, [{ subjectId: other.subjectIds[0]!, expectedRevision: "candidate-b-v1" }]);
    const implicitReply: ConfirmationReply = {
      sessionId: reply.sessionId,
      turnId: reply.turnId,
      turnOrdinal: reply.turnOrdinal,
      eventId: reply.eventId,
      statement: reply.statement,
      occurredAt: reply.occurredAt,
    };
    expect((await service.handle(implicitReply)).status).toBe("AMBIGUOUS_PENDING");
    expect((await service.handle(reply)).status).toBe("RESOLVED");
    expect(repository.pending("session-a")).toHaveLength(1);
    repository.close();
  });

  it("is idempotent for the same reply and conflicts on a different reply after resolution", async () => {
    const { repository, service, port } = setup();
    expect((await service.handle(reply)).status).toBe("RESOLVED");
    expect((await service.handle(reply)).status).toBe("ALREADY_RESOLVED");
    expect((await service.handle({ ...reply, eventId: "event-other", statement: "拒绝候选" })).status).toBe("CONFLICT");
    expect(port.apply).toHaveBeenCalledOnce();
    repository.close();
  });

  it("rejects same-turn, malformed, and missing pending replies", async () => {
    const { repository, service } = setup();
    expect((await service.handle({ ...reply, turnId: "turn-20", turnOrdinal: 20 })).status).toBe("INVALID_INPUT");
    expect((await service.handle({ ...reply, occurredAt: "2026-08-02T03:00:00.000Z" })).status).toBe("INVALID_INPUT");
    expect((await service.handle({ ...reply, occurredAt: "invalid" })).status).toBe("INVALID_INPUT");
    expect((await service.handle({ ...reply, confirmationId: "missing" })).status).toBe("NO_PENDING");
    repository.close();
  });

  it("fails safely when the effect times out and aborts the port", async () => {
    let signal: AbortSignal | undefined;
    const hanging: ConfirmationEffectPort = {
      apply: async (command) => {
        signal = command.signal;
        return await new Promise(() => undefined);
      },
    };
    const repository = new SqliteConfirmationWritebackRepository(":memory:");
    const value = request();
    repository.save(value, [{ subjectId: value.subjectIds[0]!, expectedRevision: "candidate-v1" }]);
    const service = new ConfirmationWritebackService(repository, hanging, { effectDeadlineMs: 10 });
    expect((await service.handle(reply)).status).toBe("RETRYABLE");
    expect(signal?.aborted).toBe(true);
    repository.close();
  });

  it("rejects expanded, stale, or semantically wrong effect relations", async () => {
    const invalidPorts: ConfirmationEffectPort[] = [
      { apply: async () => ({ relations: [] }) },
      { apply: async () => ({ relations: [{ subjectId: "other", relation: "CONFIRMS", beforeRevision: "candidate-v1", afterRevision: "v2" }] }) },
      { apply: async () => ({ relations: [{ subjectId: "knowledge-confirmation-a", relation: "CONFIRMS", beforeRevision: "stale", afterRevision: "v2" }] }) },
      { apply: async () => ({ relations: [{ subjectId: "knowledge-confirmation-a", relation: "REJECTS", beforeRevision: "candidate-v1", afterRevision: "v2" }] }) },
      { apply: async () => ({ relations: [{ subjectId: "knowledge-confirmation-a", relation: "CONFIRMS", beforeRevision: "candidate-v1", afterRevision: "unsafe/revision" }] }) },
      { apply: async () => ({ relations: [{ subjectId: "knowledge-confirmation-a", relation: "CONFIRMS", beforeRevision: "candidate-v1", afterRevision: "candidate-v1" }] }) },
    ];
    for (const port of invalidPorts) {
      const { repository, service } = setup(port);
      expect((await service.handle(reply)).status).toBe("RETRYABLE");
      expect(repository.resolution("confirmation-a")).toBeUndefined();
      repository.close();
    }
  });

  it("handles repository failures and claim race outcomes without guessing", async () => {
    const value = request();
    const pending: PendingConfirmation = {
      request: value,
      targets: [{ subjectId: value.subjectIds[0]!, expectedRevision: "candidate-v1" }],
    };
    const base = (overrides: Partial<ConfirmationWritebackRepository>): ConfirmationWritebackRepository => ({
      save: () => "SAVED",
      pending: () => [pending],
      claim: () => "CLAIMED",
      complete: () => "COMPLETED",
      resolution: () => undefined,
      ...overrides,
    });

    const pendingFailure = new ConfirmationWritebackService(base({
      pending: () => { throw new Error("db\nfailure"); },
    }), effectPort(), { effectDeadlineMs: 1_000 });
    expect(await pendingFailure.handle(reply)).toMatchObject({ status: "RETRYABLE", diagnostic: "Error: confirmation writeback operation failed" });

    const resolutionFailure = new ConfirmationWritebackService(base({
      pending: () => [], resolution: () => { throw new Error("corrupt"); },
    }), effectPort(), { effectDeadlineMs: 1_000 });
    expect((await resolutionFailure.handle(reply)).status).toBe("RETRYABLE");

    const crossSessionResolution = {
      schemaVersion: 1, resolutionId: "resolution-existing", confirmationId: "confirmation-a", sessionId: "other-session",
      requestTurnId: "turn-20", responseTurnId: "turn-21", responseEventId: "event-reply", responseKind: "OPTION",
      responseTextHash: createHash("sha256").update(reply.statement).digest("hex"),
      selectedOptionId: "accept-candidate", effect: "ACCEPT_CANDIDATE", subjectIds: ["knowledge-confirmation-a"],
      relations: [{ subjectId: "knowledge-confirmation-a", relation: "CONFIRMS", beforeRevision: "v1", afterRevision: "v2" }],
      resolvedAt: "2026-08-02T03:01:00.000Z",
    } as const;
    const crossSession = new ConfirmationWritebackService(base({
      pending: () => [], resolution: () => crossSessionResolution,
    }), effectPort(), { effectDeadlineMs: 1_000 });
    expect((await crossSession.handle({ ...reply, sessionId: "other-session" })).status).toBe("ALREADY_RESOLVED");
    expect((await crossSession.handle(reply)).status).toBe("CONFLICT");

    const conflict = new ConfirmationWritebackService(base({ claim: () => "CONFLICT" }), effectPort(), { effectDeadlineMs: 1_000 });
    expect((await conflict.handle(reply)).status).toBe("CONFLICT");

    const missingResolved = new ConfirmationWritebackService(base({ claim: () => "RESOLVED" }), effectPort(), { effectDeadlineMs: 1_000 });
    expect(await missingResolved.handle(reply)).toMatchObject({ status: "RETRYABLE", diagnostic: "resolved claim has no resolution" });

    const missingAfterComplete = new ConfirmationWritebackService(base({}), effectPort(), { effectDeadlineMs: 1_000 });
    expect(await missingAfterComplete.handle(reply)).toMatchObject({ status: "RETRYABLE", diagnostic: "Error: confirmation writeback operation failed" });
  });

  it("validates constructor deadlines", () => {
    const repository = new SqliteConfirmationWritebackRepository(":memory:");
    expect(() => new ConfirmationWritebackService(repository, effectPort(), { effectDeadlineMs: 0 })).toThrow("effectDeadlineMs");
    expect(() => new ConfirmationWritebackService(repository, effectPort(), { effectDeadlineMs: 60_001 })).toThrow("effectDeadlineMs");
    repository.close();
  });
});
