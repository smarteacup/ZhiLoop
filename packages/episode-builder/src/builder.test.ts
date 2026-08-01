import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { LedgerEventRecord } from "@zhiloop/conversation-ledger";
import type {
  EventEnvelope,
  EventType,
  NormalizedEventRef,
  NormalizedSession,
  NormalizedTurnStatus,
} from "@zhiloop/domain";

import { buildEpisodes } from "./builder.js";
import type { EpisodePromptClassifier } from "./types.js";

interface EventFixture {
  readonly label: string;
  readonly eventType: EventType;
  readonly turnId?: string;
  readonly payload?: unknown;
  readonly occurredAt?: string;
  readonly cwd?: string;
}

interface InputOptions {
  readonly sessionStatus?: "OPEN" | "CLOSED";
  readonly turnStatuses?: Readonly<Record<string, NormalizedTurnStatus>>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function time(sequence: number): string {
  return new Date(Date.UTC(2026, 7, 1, 8, 0, sequence)).toISOString();
}

function input(fixtures: readonly EventFixture[], options: InputOptions = {}): {
  readonly records: readonly LedgerEventRecord[];
  readonly sessions: readonly NormalizedSession[];
} {
  const records = fixtures.map((fixture, index): LedgerEventRecord => {
    const sequence = index + 1;
    const event: EventEnvelope = {
      schemaVersion: 1,
      eventId: sha256(`event:${fixture.label}`),
      source: "codex-hook",
      sourceItemId: fixture.label,
      eventType: fixture.eventType,
      sessionId: "session-1",
      ...(fixture.turnId === undefined ? {} : { turnId: fixture.turnId }),
      occurredAt: fixture.occurredAt ?? time(sequence),
      ...(fixture.cwd === undefined ? {} : { cwd: fixture.cwd }),
      contentHash: sha256(`content:${fixture.label}`),
      correlationId: sha256("session-1"),
      payload: fixture.payload ?? { label: fixture.label },
    };
    return Object.freeze({
      sequence,
      event: Object.freeze(event),
      storedPayloadHash: sha256(JSON.stringify(event.payload)),
      redactionCount: 0,
      payloadPurged: false,
      insertedAt: "2026-08-01T09:00:00.000Z",
    });
  });
  const ref = (record: LedgerEventRecord): NormalizedEventRef => Object.freeze({
    eventId: record.event.eventId,
    source: record.event.source,
    eventType: record.event.eventType,
    sourceOrder: record.sequence,
    occurredAt: record.event.occurredAt,
  });
  const turnIds = [...new Set(records.flatMap((record) => record.event.turnId === undefined ? [] : [record.event.turnId]))];
  const sessionStatus = options.sessionStatus ?? (records.some((record) => record.event.eventType === "session.ended") ? "CLOSED" : "OPEN");
  const turns = turnIds.map((turnId) => {
    const turnRecords = records.filter((record) => record.event.turnId === turnId);
    const status = options.turnStatuses?.[turnId]
      ?? (sessionStatus === "CLOSED" || turnRecords.some((record) => record.event.eventType === "turn.stopped") ? "CLOSED" : "OPEN");
    const first = turnRecords[0] as LedgerEventRecord;
    const last = turnRecords.at(-1) as LedgerEventRecord;
    return Object.freeze({
      turnId,
      sessionId: "session-1",
      syntheticId: false,
      status,
      ...(status === "CLOSED" ? { closeReason: "STOP_EVENT" as const, endedAt: last.event.occurredAt } : {}),
      startedAt: first.event.occurredAt,
      stopEventCount: turnRecords.filter((record) => record.event.eventType === "turn.stopped").length,
      events: Object.freeze(turnRecords.map(ref)),
    });
  });
  const sessionEvents = records
    .filter((record) => record.event.eventType === "session.started" || record.event.eventType === "session.ended")
    .map(ref);
  const first = records[0];
  const last = records.at(-1);
  if (first === undefined || last === undefined) throw new Error("fixture must contain at least one event");
  const session: NormalizedSession = Object.freeze({
    sessionId: "session-1",
    status: sessionStatus,
    ...(sessionStatus === "CLOSED" ? { closeReason: "SOURCE_END" as const, closedAt: last.event.occurredAt } : {}),
    startedAt: first.event.occurredAt,
    lastActivityAt: last.event.occurredAt,
    contextKey: "cwd:/workspace/repo",
    sources: Object.freeze(["codex-hook" as const]),
    sessionEvents: Object.freeze(sessionEvents),
    turns: Object.freeze(turns),
  });
  return { records: Object.freeze(records), sessions: Object.freeze([session]) };
}

const prompt = (label: string, turnId: string, text: string): EventFixture => ({
  label,
  eventType: "user.prompted",
  turnId,
  payload: { kind: "user-prompt", prompt: text },
});

const stop = (label: string, turnId: string, message: string): EventFixture => ({
  label,
  eventType: "turn.stopped",
  turnId,
  payload: { kind: "turn-stopped", stopHookActive: false, lastAssistantMessage: message },
});

describe("buildEpisodes", () => {
  it("merges multiple turns in one session and preserves every evidence reference", () => {
    const source = input([
      { label: "start", eventType: "session.started", cwd: "/workspace/repo" },
      prompt("p1", "t1", "实现 Episode Builder"),
      stop("s1", "t1", "已完成设计"),
      prompt("p2", "t2", "继续"),
      stop("s2", "t2", "已完成实现"),
      { label: "end", eventType: "session.ended" },
    ]);

    const result = buildEpisodes(source.records, source.sessions);
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]).toMatchObject({
      builderVersion: "episode-builder-v2",
      goal: "实现 Episode Builder",
      goalRef: source.records[1]?.event.eventId,
      turnIds: ["t1", "t2"],
      status: "COMPLETED",
      projectContext: { repositoryRoot: "/workspace/repo", portable: false },
    });
    expect(result.episodes[0]?.evidenceRefs).toHaveLength(source.records.length);
    expect(result.episodes[0]?.subgoals).toEqual([]);
    expect(result.episodes[0]?.userStatements.map((statement) => statement.kind)).toEqual(["GOAL", "CONTINUATION"]);
  });

  it("splits an explicit new goal and abandons an unfinished prior episode", () => {
    const source = input([
      prompt("p1", "t1", "实现采集器"),
      prompt("p2", "t2", "新任务：实现提炼器"),
      stop("s2", "t2", "已完成"),
    ], { turnStatuses: { t1: "OPEN", t2: "CLOSED" } });

    const result = buildEpisodes(source.records, source.sessions);
    expect(result.episodes.map((episode) => [episode.goal, episode.status])).toEqual([
      ["实现采集器", "ABANDONED"],
      ["新任务：实现提炼器", "COMPLETED"],
    ]);
    expect(result.episodes[0]?.evidenceRefs).toEqual([source.records[0]?.event.eventId]);
  });

  it("keeps additional requests as subgoals without splitting the episode", () => {
    const source = input([
      prompt("p1", "t1", "实现采集器"),
      stop("s1", "t1", "完成采集器"),
      prompt("p2", "t2", "另外补充性能测试"),
      prompt("p3", "t3", "增加异常测试"),
    ]);

    const episode = buildEpisodes(source.records, source.sessions).episodes[0];
    expect(episode?.subgoals.map((goal) => goal.statement)).toEqual(["另外补充性能测试", "增加异常测试"]);
    expect(episode?.turnIds).toEqual(["t1", "t2", "t3"]);
  });

  it("preserves both the corrected assistant statement and the user's correction", () => {
    const source = input([
      prompt("p1", "t1", "设计知识注入器"),
      stop("s1", "t1", "CKL 只是任务契约验证器"),
      prompt("p2", "t2", "不对，CKL 也有可控复杂度的知识注入能力"),
    ]);

    expect(buildEpisodes(source.records, source.sessions).episodes[0]?.userCorrections).toEqual([expect.objectContaining({
      turnId: "t2",
      originalRef: source.records[1]?.event.eventId,
      originalStatement: "CKL 只是任务契约验证器",
      correctedRef: source.records[2]?.event.eventId,
      correctedStatement: "不对，CKL 也有可控复杂度的知识注入能力",
    })]);
  });

  it("extracts command, tool, file actions, artifacts, and observable outcomes", () => {
    const source = input([
      prompt("p1", "t1", "修改文件并测试"),
      { label: "cmd", eventType: "tool.completed", turnId: "t1", payload: {
        toolName: "exec_command", toolInput: { cmd: "npm test" }, toolResponse: { exitCode: 0 },
      } },
      { label: "write", eventType: "tool.completed", turnId: "t1", payload: {
        toolName: "write_file", toolInput: { path: "/repo/a.ts" }, toolResponse: { status: "failed" },
      } },
      { label: "file", eventType: "file.changed", turnId: "t1", payload: { path: "/repo/a.ts" } },
      stop("s1", "t1", "测试执行完毕"),
    ]);

    const episode = buildEpisodes(source.records, source.sessions).episodes[0];
    expect(episode?.actions.map((action) => action.kind)).toEqual(["COMMAND", "TOOL", "FILE_CHANGE"]);
    expect(episode?.artifacts.map((artifact) => artifact.uri)).toEqual(["/repo/a.ts"]);
    expect(episode?.outcomes.map((outcome) => outcome.kind)).toEqual(["SUCCESS", "FAILURE", "UNKNOWN"]);
  });

  it("rebuilds byte-for-byte deterministically from reordered Ledger input", () => {
    const source = input([prompt("p1", "t1", "实现重建"), stop("s1", "t1", "完成")]);
    const first = buildEpisodes(source.records, source.sessions);
    const replay = buildEpisodes([...source.records].reverse(), source.sessions);
    expect(replay).toEqual(first);
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
  });

  it("uses the builder version in deterministic episode identity", () => {
    const source = input([prompt("p1", "t1", "实现版本化")]);
    const first = buildEpisodes(source.records, source.sessions, { builderVersion: "v1" }).episodes[0];
    const second = buildEpisodes(source.records, source.sessions, { builderVersion: "v2" }).episodes[0];
    expect(first?.episodeId).not.toBe(second?.episodeId);
  });

  it("supports a validated custom project resolver", () => {
    const source = input([prompt("p1", "t1", "解析项目")]);
    const episode = buildEpisodes(source.records, source.sessions, {
      projectResolver: () => ({ projectId: "project-1", repositoryRemote: "git@example/repo", portable: true }),
    }).episodes[0];
    expect(episode?.projectContext).toEqual({ projectId: "project-1", repositoryRemote: "git@example/repo", portable: true });
    expect(() => buildEpisodes(source.records, source.sessions, {
      projectResolver: () => ({ projectId: " ", portable: false }),
    })).toThrow("invalid projectId");
    expect(() => buildEpisodes(source.records, source.sessions, {
      projectResolver: () => ({ projectId: "project-1", portable: undefined as unknown as boolean }),
    })).toThrow("invalid portable");
    expect(() => buildEpisodes(source.records, source.sessions, {
      projectResolver: () => ({ projectId: "project-1", branch: " ", portable: false }),
    })).toThrow("invalid branch");
  });

  it("rejects missing, mismatched, duplicate, and unreferenced Ledger records", () => {
    const source = input([prompt("p1", "t1", "验证引用")]);
    expect(() => buildEpisodes([], source.sessions)).toThrow("missing from the Ledger");
    const mismatched = [{ ...source.records[0] as LedgerEventRecord, sequence: 99 }];
    expect(() => buildEpisodes(mismatched, source.sessions)).toThrow("does not match");
    expect(() => buildEpisodes([...source.records, ...source.records], source.sessions)).toThrow("duplicate Ledger eventId");
    const extra = input([prompt("p1", "t1", "验证引用"), prompt("extra", "t2", "额外")]);
    expect(() => buildEpisodes(extra.records, source.sessions)).toThrow("not referenced");
    const session = source.sessions[0] as NormalizedSession;
    const turn = session.turns[0];
    if (turn === undefined) throw new Error("fixture must contain a turn");
    const duplicatedReference: NormalizedSession = {
      ...session,
      turns: [{ ...turn, events: [...turn.events, ...turn.events] }],
    };
    expect(() => buildEpisodes(source.records, [duplicatedReference])).toThrow("more than once");
  });

  it("rejects unavailable prompts and invalid classifier output", () => {
    const unavailable = input([{ label: "p1", eventType: "user.prompted", turnId: "t1", payload: {} }]);
    expect(() => buildEpisodes(unavailable.records, unavailable.sessions)).toThrow("unavailable or invalid");
    const source = input([prompt("p1", "t1", "分类")]);
    expect(() => buildEpisodes(source.records, source.sessions, {
      promptClassifier: (() => ({ kind: "INVALID", statement: "x" })) as unknown as EpisodePromptClassifier,
    })).toThrow("unsupported kind");
    expect(() => buildEpisodes(source.records, source.sessions, {
      promptClassifier: () => ({ kind: "PRIMARY", statement: " " }),
    })).toThrow("empty statement");
    expect(buildEpisodes(source.records, source.sessions, {
      promptClassifier: () => ({ kind: "PRIMARY", statement: "  trimmed  " }),
    }).episodes[0]?.goal).toBe("trimmed");
  });

  it("truncates oversized visible text with an auditable diagnostic", () => {
    const source = input([prompt("p1", "t1", "123456789012345")]);
    const result = buildEpisodes(source.records, source.sessions, { maxTextChars: 10 });
    expect(result.episodes[0]?.goal).toBe("123456789…");
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: "TEXT_TRUNCATED",
      eventId: source.records[0]?.event.eventId,
    })]);
  });

  it("downgrades a second primary prompt in one turn to a diagnosed subgoal", () => {
    const source = input([prompt("p1", "t1", "主目标"), prompt("p2", "t1", "第二目标")]);
    const result = buildEpisodes(source.records, source.sessions, {
      promptClassifier: (value) => ({ kind: "NEW_GOAL", statement: value }),
    });
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]?.subgoals[0]?.statement).toBe("第二目标");
    expect(result.diagnostics[0]?.code).toBe("MULTIPLE_PRIMARY_PROMPTS");
  });

  it("builds an unattributed episode for orphan work and freezes the result", () => {
    const source = input([{ label: "tool", eventType: "tool.completed", turnId: "t1", payload: {
      toolName: "search", toolInput: { query: "Episode" }, toolResponse: {},
    } }]);
    const result = buildEpisodes(source.records, source.sessions);
    expect(result.episodes[0]?.goal).toBe("Unattributed session activity");
    expect(result.episodes[0]?.status).toBe("OPEN");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.episodes)).toBe(true);
    expect(Object.isFrozen(result.episodes[0])).toBe(true);
  });

  it("validates builder options", () => {
    const source = input([prompt("p1", "t1", "配置")]);
    expect(() => buildEpisodes(source.records, source.sessions, { builderVersion: "bad version" })).toThrow("builderVersion");
    expect(() => buildEpisodes(source.records, source.sessions, { maxTextChars: 0 })).toThrow("maxTextChars");
  });
});
