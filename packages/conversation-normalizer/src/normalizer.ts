import { createHash } from "node:crypto";

import type { LedgerEventRecord } from "@zhiloop/conversation-ledger";
import type {
  NormalizedEventRef,
  NormalizedSession,
  NormalizedTurn,
  SessionCloseReason,
} from "@zhiloop/domain";

import type {
  ConversationNormalizationDiagnostic,
  ConversationNormalizationOptions,
  ConversationNormalizationResult,
} from "./types.js";

const DEFAULT_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_INACTIVITY_TIMEOUT_MS = 365 * 24 * 60 * 60 * 1_000;
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

interface OrderedRecord {
  readonly record: LedgerEventRecord;
  readonly occurredAtMs: number;
}

interface SessionDraft {
  readonly sessionId: string;
  readonly records: readonly OrderedRecord[];
  readonly startedAtMs: number;
  readonly lastActivityAtMs: number;
  readonly firstSourceOrder: number;
  readonly lastSourceOrder: number;
  readonly contextKey?: string;
  readonly explicitEnd?: OrderedRecord;
}

interface SessionClosure {
  readonly reason: SessionCloseReason;
  readonly closedAt: string;
}

interface MutableTurn {
  turnId: string;
  syntheticId: boolean;
  readonly records: OrderedRecord[];
}

function compareRecords(left: OrderedRecord, right: OrderedRecord): number {
  if (left.occurredAtMs !== right.occurredAtMs) return left.occurredAtMs < right.occurredAtMs ? -1 : 1;
  if (left.record.sequence !== right.record.sequence) return left.record.sequence < right.record.sequence ? -1 : 1;
  return left.record.event.eventId.localeCompare(right.record.event.eventId);
}

function compareDrafts(left: SessionDraft, right: SessionDraft): number {
  if (left.startedAtMs !== right.startedAtMs) return left.startedAtMs < right.startedAtMs ? -1 : 1;
  if (left.firstSourceOrder !== right.firstSourceOrder) return left.firstSourceOrder < right.firstSourceOrder ? -1 : 1;
  return left.sessionId.localeCompare(right.sessionId);
}

function isAfter(left: SessionDraft, right: SessionDraft): boolean {
  return right.startedAtMs > left.lastActivityAtMs || (
    right.startedAtMs === left.lastActivityAtMs && right.firstSourceOrder > left.lastSourceOrder
  );
}

function syntheticTurnId(sessionId: string, eventId: string): string {
  return `synthetic-${createHash("sha256").update(`${sessionId}\0${eventId}`).digest("hex")}`;
}

function eventRef(item: OrderedRecord): NormalizedEventRef {
  const event = item.record.event;
  return Object.freeze({
    eventId: event.eventId,
    source: event.source,
    eventType: event.eventType,
    sourceOrder: item.record.sequence,
    occurredAt: event.occurredAt,
  });
}

function contextKey(records: readonly OrderedRecord[]): string | undefined {
  for (const item of records) {
    if (item.record.event.projectHint !== undefined) return `project:${item.record.event.projectHint}`;
  }
  for (const item of records) {
    if (item.record.event.cwd !== undefined) return `cwd:${item.record.event.cwd}`;
  }
  return undefined;
}

function assertOptions(options: ConversationNormalizationOptions): {
  readonly asOfMs: number;
  readonly inactivityTimeoutMs: number;
  readonly closeFromNextSession: boolean;
} {
  const match = ISO_DATE_TIME.exec(options.asOf);
  const asOfMs = Date.parse(options.asOf);
  if (match === null || Number.isNaN(asOfMs)) throw new Error("asOf must be an ISO date-time");
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText ?? 0);
  const offsetMinute = Number(offsetMinuteText ?? 0);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new Error("asOf must be an ISO date-time");
  }
  const inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(inactivityTimeoutMs) ||
    inactivityTimeoutMs < 1 ||
    inactivityTimeoutMs > MAX_INACTIVITY_TIMEOUT_MS
  ) {
    throw new Error(`inactivityTimeoutMs must be between 1 and ${MAX_INACTIVITY_TIMEOUT_MS}`);
  }
  if (options.closeFromNextSession !== undefined && typeof options.closeFromNextSession !== "boolean") {
    throw new Error("closeFromNextSession must be a boolean");
  }
  return { asOfMs, inactivityTimeoutMs, closeFromNextSession: options.closeFromNextSession ?? true };
}

function orderRecords(
  records: readonly LedgerEventRecord[],
  diagnostics: ConversationNormalizationDiagnostic[],
): readonly OrderedRecord[] {
  const ordered = records.map((record) => {
    if (!Number.isSafeInteger(record.sequence) || record.sequence < 1) {
      throw new Error("ledger sequence must be a positive safe integer");
    }
    const occurredAtMs = Date.parse(record.event.occurredAt);
    if (Number.isNaN(occurredAtMs)) throw new Error(`event ${record.event.eventId} has an invalid occurredAt`);
    return { record, occurredAtMs };
  }).sort(compareRecords);
  const sequences = new Set<number>();
  for (const item of ordered) {
    if (sequences.has(item.record.sequence)) {
      diagnostics.push({
        code: "DUPLICATE_SEQUENCE",
        sessionId: item.record.event.sessionId,
        eventId: item.record.event.eventId,
        sourceOrder: item.record.sequence,
      });
    } else {
      sequences.add(item.record.sequence);
    }
  }
  return ordered;
}

function sessionDrafts(
  ordered: readonly OrderedRecord[],
  diagnostics: ConversationNormalizationDiagnostic[],
): readonly SessionDraft[] {
  const groups = new Map<string, OrderedRecord[]>();
  for (const item of ordered) {
    const sessionId = item.record.event.sessionId;
    const group = groups.get(sessionId);
    if (group === undefined) groups.set(sessionId, [item]);
    else group.push(item);
  }

  return [...groups.entries()].map(([sessionId, records]) => {
    const first = records[0] as OrderedRecord;
    const last = records.at(-1) as OrderedRecord;
    const endEvents = records.filter((item) => item.record.event.eventType === "session.ended");
    const explicitEnd = endEvents[0];
    for (const duplicate of endEvents.slice(1)) {
      diagnostics.push({
        code: "MULTIPLE_SESSION_END",
        sessionId,
        eventId: duplicate.record.event.eventId,
        sourceOrder: duplicate.record.sequence,
      });
    }
    if (explicitEnd !== undefined) {
      for (const item of records) {
        if (compareRecords(item, explicitEnd) <= 0 || item.record.event.eventType === "session.ended") continue;
        diagnostics.push({
          code: "EVENT_AFTER_SESSION_END",
          sessionId,
          eventId: item.record.event.eventId,
          sourceOrder: item.record.sequence,
        });
      }
    }
    const resolvedContextKey = contextKey(records);
    return {
      sessionId,
      records: Object.freeze(records),
      startedAtMs: first.occurredAtMs,
      lastActivityAtMs: last.occurredAtMs,
      firstSourceOrder: first.record.sequence,
      lastSourceOrder: last.record.sequence,
      ...(resolvedContextKey === undefined ? {} : { contextKey: resolvedContextKey }),
      ...(explicitEnd === undefined ? {} : { explicitEnd }),
    };
  }).sort(compareDrafts);
}

function inferClosure(
  draft: SessionDraft,
  successor: SessionDraft | undefined,
  asOfMs: number,
  inactivityTimeoutMs: number,
): SessionClosure | undefined {
  if (draft.explicitEnd !== undefined) {
    const closedAt = draft.lastActivityAtMs > draft.explicitEnd.occurredAtMs
      ? (draft.records.at(-1) as OrderedRecord).record.event.occurredAt
      : draft.explicitEnd.record.event.occurredAt;
    return { reason: "SOURCE_END", closedAt };
  }
  if (successor !== undefined) {
    return { reason: "NEXT_SESSION", closedAt: (successor.records[0] as OrderedRecord).record.event.occurredAt };
  }
  if (asOfMs >= draft.lastActivityAtMs && asOfMs - draft.lastActivityAtMs >= inactivityTimeoutMs) {
    return { reason: "INACTIVITY_TIMEOUT", closedAt: new Date(draft.lastActivityAtMs + inactivityTimeoutMs).toISOString() };
  }
  return undefined;
}

function sessionSuccessors(
  drafts: readonly SessionDraft[],
  enabled: boolean,
): ReadonlyMap<string, SessionDraft> {
  const successors = new Map<string, SessionDraft>();
  if (!enabled) return successors;
  const contexts = new Map<string, SessionDraft[]>();
  for (const draft of drafts) {
    if (draft.contextKey === undefined) continue;
    const group = contexts.get(draft.contextKey);
    if (group === undefined) contexts.set(draft.contextKey, [draft]);
    else group.push(draft);
  }
  for (const group of contexts.values()) {
    for (const draft of group) {
      let low = 0;
      let high = group.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (isAfter(draft, group[middle] as SessionDraft)) high = middle;
        else low = middle + 1;
      }
      const successor = group[low];
      if (successor !== undefined) successors.set(draft.sessionId, successor);
    }
  }
  return successors;
}

function nextNonOverlappingTurn(turns: readonly MutableTurn[], index: number): MutableTurn | undefined {
  const current = turns[index];
  if (current === undefined) return undefined;
  const last = current.records.at(-1) as OrderedRecord;
  let low = index + 1;
  let high = turns.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = turns[middle] as MutableTurn;
    if (compareRecords(candidate.records[0] as OrderedRecord, last) > 0) high = middle;
    else low = middle + 1;
  }
  return turns[low];
}

function normalizeTurns(draft: SessionDraft, closure: SessionClosure | undefined): readonly NormalizedTurn[] {
  const turns = new Map<string, MutableTurn>();
  let activeTurnId: string | undefined;
  for (const item of draft.records) {
    const event = item.record.event;
    if (event.eventType === "session.started" || event.eventType === "session.ended") continue;

    let turnId = event.turnId;
    let syntheticId = false;
    if (event.eventType === "user.prompted") {
      if (turnId === undefined) {
        turnId = syntheticTurnId(draft.sessionId, event.eventId);
        syntheticId = true;
      }
      activeTurnId = turnId;
    } else if (turnId !== undefined) {
      const active = activeTurnId === undefined ? undefined : turns.get(activeTurnId);
      if (active?.syntheticId === true && !turns.has(turnId)) {
        turns.delete(active.turnId);
        active.turnId = turnId;
        active.syntheticId = false;
        turns.set(turnId, active);
      }
      activeTurnId = turnId;
    } else if (activeTurnId !== undefined) {
      turnId = activeTurnId;
      syntheticId = turns.get(turnId)?.syntheticId ?? false;
    } else {
      turnId = syntheticTurnId(draft.sessionId, event.eventId);
      syntheticId = true;
      activeTurnId = turnId;
    }

    const current = turns.get(turnId);
    if (current === undefined) turns.set(turnId, { turnId, syntheticId, records: [item] });
    else current.records.push(item);
  }

  const orderedTurns = [...turns.values()].sort((left, right) => compareRecords(
    left.records[0] as OrderedRecord,
    right.records[0] as OrderedRecord,
  ));
  return Object.freeze(orderedTurns.map((turn, index) => {
    const first = turn.records[0] as OrderedRecord;
    const last = turn.records.at(-1) as OrderedRecord;
    const stopEventCount = turn.records.filter((item) => item.record.event.eventType === "turn.stopped").length;
    const next = nextNonOverlappingTurn(orderedTurns, index);
    let closeReason: NormalizedTurn["closeReason"];
    let endedAt: string | undefined;
    if (last.record.event.eventType === "turn.stopped") {
      closeReason = "STOP_EVENT";
      endedAt = last.record.event.occurredAt;
    } else if (next !== undefined) {
      closeReason = "NEXT_TURN";
      endedAt = (next.records[0] as OrderedRecord).record.event.occurredAt;
    } else if (closure !== undefined) {
      closeReason = "SESSION_CLOSED";
      endedAt = closure.closedAt;
    }

    return Object.freeze({
      turnId: turn.turnId,
      sessionId: draft.sessionId,
      syntheticId: turn.syntheticId,
      status: closeReason === undefined ? "OPEN" : "CLOSED",
      ...(closeReason === undefined ? {} : { closeReason }),
      startedAt: first.record.event.occurredAt,
      ...(endedAt === undefined ? {} : { endedAt }),
      stopEventCount,
      events: Object.freeze(turn.records.map(eventRef)),
    });
  }));
}

function normalizeSession(draft: SessionDraft, closure: SessionClosure | undefined): NormalizedSession {
  const sources = [...new Set(draft.records.map((item) => item.record.event.source))].sort();
  return Object.freeze({
    sessionId: draft.sessionId,
    status: closure === undefined ? "OPEN" : "CLOSED",
    ...(closure === undefined ? {} : { closeReason: closure.reason, closedAt: closure.closedAt }),
    startedAt: draft.records[0]?.record.event.occurredAt as string,
    lastActivityAt: draft.records.at(-1)?.record.event.occurredAt as string,
    ...(draft.contextKey === undefined ? {} : { contextKey: draft.contextKey }),
    sources: Object.freeze(sources),
    sessionEvents: Object.freeze(
      draft.records
        .filter((item) => item.record.event.eventType === "session.started" || item.record.event.eventType === "session.ended")
        .map(eventRef),
    ),
    turns: normalizeTurns(draft, closure),
  });
}

export function normalizeConversations(
  records: readonly LedgerEventRecord[],
  options: ConversationNormalizationOptions,
): ConversationNormalizationResult {
  const validatedOptions = assertOptions(options);
  const diagnostics: ConversationNormalizationDiagnostic[] = [];
  const ordered = orderRecords(records, diagnostics);
  const drafts = sessionDrafts(ordered, diagnostics);
  const successors = sessionSuccessors(drafts, validatedOptions.closeFromNextSession);
  const sessions = drafts.map((draft) => normalizeSession(
    draft,
    inferClosure(
      draft,
      successors.get(draft.sessionId),
      validatedOptions.asOfMs,
      validatedOptions.inactivityTimeoutMs,
    ),
  ));
  return Object.freeze({
    sessions: Object.freeze(sessions),
    diagnostics: Object.freeze(diagnostics.map((item) => Object.freeze(item))),
  });
}
