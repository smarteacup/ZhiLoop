import { describe, expect, it } from "vitest";

import type { Episode, EpisodeUserStatement, KnowledgeCandidate, KnowledgeKind } from "@zhiloop/domain";

import { applyUserCommitments, detectUserCommitments } from "./commitment-detector.js";

const BASE_TIME = "2026-08-01T08:00:00.000Z";

function statement(
  sourceEventId: string,
  text: string,
  occurredAt: string,
  kind: EpisodeUserStatement["kind"] = "CONTINUATION",
): EpisodeUserStatement {
  return { turnId: `turn-${sourceEventId}`, sourceEventId, kind, statement: text, occurredAt };
}

function episode(
  statements: readonly EpisodeUserStatement[],
  overrides: Partial<Episode> = {},
): Episode {
  const refs = new Set(["event-goal", ...statements.map((item) => item.sourceEventId)]);
  for (const correction of overrides.userCorrections ?? []) {
    refs.add(correction.originalRef);
    refs.add(correction.correctedRef);
  }
  for (const action of overrides.actions ?? []) {
    action.sourceEventIds.forEach((ref) => refs.add(ref));
  }
  return {
    episodeId: "episode-commitment",
    builderVersion: "episode-builder-v2",
    sessionIds: ["session-1"],
    turnIds: statements.map((item) => item.turnId),
    projectContext: { projectId: "project-1", repositoryRoot: "/private/repo", portable: false },
    goal: "Choose a cache design",
    goalRef: "event-goal",
    subgoals: [],
    userStatements: statements,
    userCorrections: [],
    actions: [],
    artifacts: [],
    outcomes: [],
    evidenceRefs: [...refs],
    status: "COMPLETED",
    createdAt: BASE_TIME,
    updatedAt: "2026-08-01T08:10:00.000Z",
    ...overrides,
  };
}

function candidate(
  candidateId: string,
  title: string,
  kind: KnowledgeKind = "DESIGN",
  sourceRef = "event-goal",
): KnowledgeCandidate {
  return {
    schemaVersion: 1,
    candidateId,
    compilerVersion: "mvp-compiler-v1",
    status: "PROPOSED",
    subjectKey: `design.cache.${candidateId}`,
    kind,
    scopeHint: { level: "PROJECT", projectId: "project-1", reasonCodes: ["EPISODE_PROJECT"] },
    title,
    summary: `${title} is the proposed cache design.`,
    body: `Apply ${title} in this project.`,
    sourceEpisodes: ["episode-commitment"],
    confidence: 0.8,
    assertions: [],
    evidenceHints: [{
      type: "USER_STATEMENT",
      sourceRef,
      projectId: "project-1",
      correlationId: "correlation-1",
    }],
    createdAt: "2026-08-01T08:00:30.000Z",
    correlationId: "correlation-1",
  };
}

describe("detectUserCommitments", () => {
  it("associates a generic acceptance with the only proposal and records later implementation", () => {
    const acceptance = statement("event-accept", "按这个做", "2026-08-01T08:01:00.000Z");
    const source = episode([acceptance], {
      actions: [{
        actionId: "action-1",
        kind: "FILE_CHANGE",
        summary: "Implemented Redis cache",
        sourceEventIds: ["event-action"],
        occurredAt: "2026-08-01T08:02:00.000Z",
      }],
    });

    const result = detectUserCommitments(source, [candidate("redis", "Use Redis cache")]);

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]).toMatchObject({
      kind: "USER_ACCEPTED",
      candidateIds: ["redis"],
      turnId: acceptance.turnId,
      statementRef: "event-accept",
      reasonCodes: ["SINGLE_PROPOSAL", "FOLLOWED_BY_IMPLEMENTATION"],
    });
    expect(result.ambiguities).toEqual([]);
  });

  it("recognizes a direct confirmation-to-use statement without requiring a design suffix", () => {
    const acceptance = statement("event-accept", "确认使用可恢复 outbox", "2026-08-01T08:01:00.000Z");
    const result = detectUserCommitments(episode([acceptance]), [candidate("outbox", "Use a durable outbox")]);
    expect(result.signals).toEqual([
      expect.objectContaining({ kind: "USER_ACCEPTED", candidateIds: ["outbox"], statementRef: "event-accept" }),
    ]);
    expect(result.ambiguities).toEqual([]);
  });

  it("does not auto-confirm multiple proposals without a unique target", () => {
    const acceptance = statement("event-accept", "按这个做", "2026-08-01T08:01:00.000Z");
    const result = detectUserCommitments(episode([acceptance]), [
      candidate("redis", "Use Redis cache"),
      candidate("mysql", "Use MySQL cache"),
    ]);

    expect(result.signals).toEqual([]);
    expect(result.ambiguities).toEqual([{
      kind: "USER_ACCEPTED",
      turnId: acceptance.turnId,
      statementRef: "event-accept",
      candidateIds: ["mysql", "redis"],
      statement: "按这个做",
      reasonCode: "MULTIPLE_PLAUSIBLE_TARGETS",
    }]);
  });

  it("uses a unique Candidate source reference to resolve generic acceptance in a multi-kind batch", () => {
    const acceptance = statement("event-accept", "按这个做", "2026-08-01T08:01:00.000Z");
    const result = detectUserCommitments(episode([acceptance]), [
      candidate("requirement", "Keep data local", "REQUIREMENT"),
      candidate("design", "Use Redis cache", "DESIGN", "event-accept"),
      candidate("decision", "Select the cache", "DECISION"),
    ]);
    expect(result.signals[0]).toMatchObject({
      kind: "USER_ACCEPTED",
      candidateIds: ["design"],
      reasonCodes: ["EXPLICIT_SOURCE_REFERENCE"],
    });
    expect(result.ambiguities).toEqual([]);
  });

  it("keeps generic acceptance ambiguous when several Candidates cite the same statement", () => {
    const acceptance = statement("event-accept", "按这个做", "2026-08-01T08:01:00.000Z");
    const result = detectUserCommitments(episode([acceptance]), [
      candidate("design", "Use Redis cache", "DESIGN", "event-accept"),
      candidate("decision", "Select Redis", "DECISION", "event-accept"),
    ]);
    expect(result.signals).toEqual([]);
    expect(result.ambiguities[0]).toMatchObject({
      kind: "USER_ACCEPTED",
      candidateIds: ["decision", "design"],
      statementRef: "event-accept",
    });
  });

  it("uses a unique explicit topic to select one candidate from several", () => {
    const acceptance = statement("event-accept", "采用 Redis 方案", "2026-08-01T08:01:00.000Z");
    const result = detectUserCommitments(episode([acceptance]), [
      candidate("redis", "Use Redis cache"),
      candidate("mysql", "Use MySQL cache"),
    ]);

    expect(result.signals[0]).toMatchObject({
      kind: "USER_ACCEPTED",
      candidateIds: ["redis"],
      reasonCodes: ["EXPLICIT_TOPIC_MATCH"],
    });
    expect(result.ambiguities).toEqual([]);
  });

  it("targets the denied topic and preserves the original Turn reference", () => {
    const rejection = statement("event-reject", "不要使用 Redis", "2026-08-01T08:01:00.000Z", "SUBGOAL");
    const result = detectUserCommitments(episode([rejection]), [
      candidate("redis", "Use Redis cache"),
      candidate("mysql", "Use MySQL cache"),
    ]);

    expect(result.signals[0]).toMatchObject({
      kind: "USER_REJECTED",
      candidateIds: ["redis"],
      turnId: rejection.turnId,
      statementRef: "event-reject",
      statement: "不要使用 Redis",
      reasonCodes: ["EXPLICIT_TOPIC_MATCH"],
    });
  });

  it("emits correction evidence and rejects candidates grounded in the corrected source", () => {
    const correctionStatement = statement(
      "event-corrected",
      "不是这个意思，改用 MySQL",
      "2026-08-01T08:02:00.000Z",
      "CORRECTION",
    );
    const source = episode([correctionStatement], {
      userCorrections: [{
        correctionId: "correction-1",
        turnId: correctionStatement.turnId,
        originalRef: "event-redis-proposal",
        originalStatement: "Use Redis cache",
        correctedRef: "event-corrected",
        correctedStatement: correctionStatement.statement,
        occurredAt: correctionStatement.occurredAt,
      }],
    });

    const result = detectUserCommitments(source, [
      candidate("redis", "Use Redis cache", "DESIGN", "event-redis-proposal"),
      candidate("mysql", "Use MySQL cache"),
    ]);

    expect(result.signals).toEqual([
      expect.objectContaining({
        kind: "CORRECTION",
        candidateIds: ["redis"],
        turnId: correctionStatement.turnId,
        statementRef: "event-corrected",
        originalRef: "event-redis-proposal",
        originalStatement: "Use Redis cache",
        correctedRef: "event-corrected",
        correctedStatement: "不是这个意思，改用 MySQL",
        reasonCodes: ["EXPLICIT_SOURCE_REFERENCE"],
      }),
      expect.objectContaining({
        kind: "USER_REJECTED",
        candidateIds: ["redis"],
        reasonCodes: ["EXPLICIT_SOURCE_REFERENCE"],
      }),
    ]);
  });

  it("ignores candidates from another Episode and rejects mutable OPEN Episode input", () => {
    const acceptance = statement("event-accept", "按这个做", "2026-08-01T08:01:00.000Z");
    const external = { ...candidate("external", "Use Redis cache"), sourceEpisodes: ["other-episode"] } as KnowledgeCandidate;
    expect(detectUserCommitments(episode([acceptance]), [external]).signals).toEqual([]);
    expect(() => detectUserCommitments(episode([acceptance], { status: "OPEN" }), [external])).toThrow("OPEN Episode");
  });

  it("does not treat quoted commitment phrases as user commitments", () => {
    const mentions = [
      statement("event-mention-1", "请测试‘按这个做’的识别逻辑", "2026-08-01T08:01:00.000Z"),
      statement("event-mention-2", "文档需要解释不要使用 X 的规则", "2026-08-01T08:02:00.000Z"),
    ];
    const result = detectUserCommitments(episode(mentions), [candidate("redis", "Use Redis cache")]);
    expect(result).toEqual({ signals: [], ambiguities: [] });
  });

  it("fails closed on duplicate or temporally invalid user evidence", () => {
    const acceptance = statement("event-accept", "按这个做", "2026-08-01T08:01:00.000Z");
    expect(() => detectUserCommitments(
      episode([acceptance, acceptance]),
      [candidate("redis", "Use Redis cache")],
    )).toThrow("duplicate user statement");
    expect(() => detectUserCommitments(
      episode([{ ...acceptance, occurredAt: "not-a-date" }]),
      [candidate("redis", "Use Redis cache")],
    )).toThrow("invalid occurredAt");
  });

  it("rejects correction metadata that conflicts with the retained user statement", () => {
    const corrected = statement("event-corrected", "不是这个意思", "2026-08-01T08:02:00.000Z", "CORRECTION");
    const source = episode([corrected], {
      userCorrections: [{
        correctionId: "correction-conflict",
        turnId: corrected.turnId,
        originalRef: "event-original",
        originalStatement: "Use Redis cache",
        correctedRef: corrected.sourceEventId,
        correctedStatement: "different text",
        occurredAt: corrected.occurredAt,
      }],
    });
    expect(() => detectUserCommitments(source, [candidate("redis", "Use Redis cache")])).toThrow("conflicts");
  });

  it("retains an unresolved correction and exposes multiple plausible targets", () => {
    const source = episode([], {
      userCorrections: [{
        correctionId: "correction-ambiguous",
        turnId: "turn-correction",
        originalRef: "event-original",
        originalStatement: "Use a cache",
        correctedRef: "event-corrected",
        correctedStatement: "改为其他方案",
        occurredAt: "2026-08-01T08:02:00.000Z",
      }],
    });
    const result = detectUserCommitments(source, [
      candidate("redis", "Use Redis cache"),
      candidate("mysql", "Use MySQL cache"),
    ]);
    expect(result.signals[0]).toMatchObject({
      kind: "CORRECTION",
      candidateIds: [],
      turnId: "turn-correction",
      reasonCodes: ["TARGET_UNRESOLVED"],
    });
    expect(result.ambiguities[0]).toMatchObject({
      kind: "CORRECTION",
      candidateIds: ["mysql", "redis"],
    });
  });
});

describe("applyUserCommitments", () => {
  it("adds deterministic assertions without mutating candidates and deduplicates replay", () => {
    const acceptance = statement("event-accept", "按这个做", "2026-08-01T08:01:00.000Z");
    const sourceCandidate = candidate("redis", "Use Redis cache");
    const detection = detectUserCommitments(episode([acceptance]), [sourceCandidate]);

    const first = applyUserCommitments([sourceCandidate], detection);
    const replay = applyUserCommitments(first, detection);

    expect(sourceCandidate.assertions).toEqual([]);
    expect(first[0]?.status).toBe("PROPOSED");
    expect(first[0]?.assertions).toEqual([expect.objectContaining({
      candidateId: "redis",
      kind: "USER_ACCEPTED",
      parameters: { statementRef: "event-accept" },
      createdAt: acceptance.occurredAt,
    })]);
    expect(replay[0]?.assertions).toEqual(first[0]?.assertions);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0]?.assertions)).toBe(true);
    expect(Object.isFrozen(first[0]?.assertions[0]?.parameters)).toBe(true);
  });

  it("fails closed when a supplied signal targets an unknown candidate", () => {
    const acceptance = statement("event-accept", "按这个做", "2026-08-01T08:01:00.000Z");
    const detection = detectUserCommitments(episode([acceptance]), [candidate("redis", "Use Redis cache")]);
    const signal = detection.signals[0];
    if (signal === undefined) throw new Error("expected a signal");
    const tampered = { ...detection, signals: [{ ...signal, candidateIds: ["unknown"] }] };

    expect(() => applyUserCommitments([candidate("redis", "Use Redis cache")], tampered)).toThrow("unknown candidate");
  });

  it("rejects tampered signal kinds and timestamps", () => {
    const acceptance = statement("event-accept", "按这个做", "2026-08-01T08:01:00.000Z");
    const sourceCandidate = candidate("redis", "Use Redis cache");
    const detection = detectUserCommitments(episode([acceptance]), [sourceCandidate]);
    const signal = detection.signals[0];
    if (signal === undefined) throw new Error("expected a signal");
    expect(() => applyUserCommitments([sourceCandidate], {
      ...detection,
      signals: [{ ...signal, kind: "IMPLEMENTED" }],
    } as unknown as typeof detection)).toThrow("unsupported commitment signal kind");
    expect(() => applyUserCommitments([sourceCandidate], {
      ...detection,
      signals: [{ ...signal, occurredAt: "not-a-date" }],
    })).toThrow("is invalid");
    expect(() => applyUserCommitments([sourceCandidate], {
      ...detection,
      signals: [{ ...signal, candidateIds: ["redis", "redis"] }],
    })).toThrow("duplicate candidate targets");
  });

  it("deduplicates duplicate signals within the same application batch", () => {
    const acceptance = statement("event-accept", "按这个做", "2026-08-01T08:01:00.000Z");
    const sourceCandidate = candidate("redis", "Use Redis cache");
    const detection = detectUserCommitments(episode([acceptance]), [sourceCandidate]);
    const signal = detection.signals[0];
    if (signal === undefined) throw new Error("expected a signal");
    const enriched = applyUserCommitments([sourceCandidate], { ...detection, signals: [signal, signal] });
    expect(enriched[0]?.assertions).toHaveLength(1);
  });
});
