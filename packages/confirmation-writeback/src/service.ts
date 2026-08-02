import { createHash } from "node:crypto";

import type {
  ConfirmationEffect,
  ConfirmationResolution,
  ConfirmationVersionRelation,
} from "@zhiloop/domain";
import { CONFIRMATION_RELATION_BY_EFFECT } from "@zhiloop/domain";
import { parseConfirmationResolution } from "@zhiloop/schemas";

import { matchConfirmationReply } from "./matcher.js";
import type {
  ConfirmationEffectPort,
  ConfirmationReply,
  ConfirmationTargetSnapshot,
  ConfirmationWritebackOptions,
  ConfirmationWritebackRepository,
  ConfirmationWritebackResult,
} from "./types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/u;
const SAFE_REVISION = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,499}$/u;

class EffectDeadlineError extends Error {}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeError(error: unknown): string {
  if (error instanceof EffectDeadlineError) return "EffectDeadlineError: confirmation effect timed out";
  return `${error instanceof Error ? error.name : "UnknownError"}: confirmation writeback operation failed`;
}

function validReply(reply: ConfirmationReply): boolean {
  return SAFE_ID.test(reply.sessionId) && SAFE_ID.test(reply.turnId) && SAFE_ID.test(reply.eventId)
    && Number.isSafeInteger(reply.turnOrdinal) && reply.turnOrdinal >= 0
    && typeof reply.statement === "string" && reply.statement.trim().length > 0 && reply.statement.length <= 10_000
    && !/[\0]/u.test(reply.statement) && Number.isFinite(Date.parse(reply.occurredAt))
    && new Date(reply.occurredAt).toISOString() === reply.occurredAt
    && (reply.confirmationId === undefined || SAFE_ID.test(reply.confirmationId));
}

async function withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new EffectDeadlineError("confirmation effect timed out");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function validateRelations(
  effect: ConfirmationEffect,
  responseKind: "OPTION" | "CORRECTION",
  targets: readonly ConfirmationTargetSnapshot[],
  relations: readonly ConfirmationVersionRelation[],
): readonly ConfirmationVersionRelation[] {
  if (relations.length !== targets.length || new Set(relations.map((item) => item.subjectId)).size !== relations.length) {
    throw new Error("effect relations do not exactly cover confirmation targets");
  }
  const expectedRelation = responseKind === "CORRECTION" ? "CORRECTS" : CONFIRMATION_RELATION_BY_EFFECT[effect];
  for (const target of targets) {
    const relation = relations.find((item) => item.subjectId === target.subjectId);
    if (relation === undefined || relation.beforeRevision !== target.expectedRevision
      || relation.relation !== expectedRelation || !SAFE_REVISION.test(relation.afterRevision)
      || (relation.relation !== "RETAINS" && relation.relation !== "CONTINUES" && relation.afterRevision === relation.beforeRevision)) {
      throw new Error("effect relation expanded a target or violated revision fencing");
    }
  }
  return relations.map((item) => Object.freeze({ ...item })).sort((left, right) =>
    left.subjectId < right.subjectId ? -1 : left.subjectId > right.subjectId ? 1 : 0);
}

export class ConfirmationWritebackService {
  constructor(
    private readonly repository: ConfirmationWritebackRepository,
    private readonly effects: ConfirmationEffectPort,
    private readonly options: ConfirmationWritebackOptions,
  ) {
    if (!Number.isSafeInteger(options.effectDeadlineMs) || options.effectDeadlineMs < 1 || options.effectDeadlineMs > 60_000) {
      throw new Error("effectDeadlineMs must be between 1 and 60000");
    }
  }

  async handle(reply: ConfirmationReply): Promise<ConfirmationWritebackResult> {
    if (!validReply(reply)) return { status: "INVALID_INPUT" };
    let pending;
    try {
      pending = this.repository.pending(reply.sessionId, reply.confirmationId);
    } catch (error) {
      return { status: "RETRYABLE", diagnostic: safeError(error) };
    }
    if (pending.length === 0) {
      if (reply.confirmationId !== undefined) {
        try {
          const existing = this.repository.resolution(reply.confirmationId);
          if (existing?.sessionId === reply.sessionId
            && existing.responseEventId === reply.eventId && existing.responseTextHash === sha256(reply.statement)) {
            return { status: "ALREADY_RESOLVED", confirmationId: reply.confirmationId, resolution: existing };
          }
          if (existing !== undefined) return { status: "CONFLICT", confirmationId: reply.confirmationId };
        } catch (error) {
          return { status: "RETRYABLE", diagnostic: safeError(error) };
        }
      }
      return { status: "NO_PENDING" };
    }
    if (pending.length !== 1) return { status: "AMBIGUOUS_PENDING" };
    const selected = pending[0];
    if (selected === undefined || reply.turnOrdinal <= selected.request.turnOrdinal || reply.turnId === selected.request.turnId
      || Date.parse(reply.occurredAt) <= Date.parse(selected.request.createdAt)) {
      return { status: "INVALID_INPUT" };
    }
    const match = matchConfirmationReply(selected.request, reply.statement);
    if (match.status === "NO_MATCH") return { status: "NO_EXPLICIT_CHOICE", confirmationId: selected.request.confirmationId };
    if (match.status === "AMBIGUOUS") return { status: "AMBIGUOUS_CHOICE", confirmationId: selected.request.confirmationId };

    const responseTextHash = sha256(reply.statement);
    const resolutionId = `resolution-${sha256(JSON.stringify([
      selected.request.confirmationId, reply.eventId, match.option.optionId, match.responseKind,
    ])).slice(0, 32)}`;
    let claim;
    try {
      claim = this.repository.claim(selected.request.confirmationId, resolutionId, reply.eventId, responseTextHash);
      if (claim === "CONFLICT") return { status: "CONFLICT", confirmationId: selected.request.confirmationId };
      if (claim === "RESOLVED") {
        const existing = this.repository.resolution(selected.request.confirmationId);
        return existing === undefined
          ? { status: "RETRYABLE", confirmationId: selected.request.confirmationId, diagnostic: "resolved claim has no resolution" }
          : { status: "ALREADY_RESOLVED", confirmationId: selected.request.confirmationId, resolution: existing };
      }
      const applied = await withDeadline((signal) => this.effects.apply({
        resolutionId,
        confirmationId: selected.request.confirmationId,
        effect: match.option.effect,
        responseKind: match.responseKind,
        responseEventId: reply.eventId,
        responseText: reply.statement,
        targets: selected.targets,
        signal,
      }), this.options.effectDeadlineMs);
      const relations = validateRelations(match.option.effect, match.responseKind, selected.targets, applied.relations);
      const resolution: ConfirmationResolution = {
        schemaVersion: 1,
        resolutionId,
        confirmationId: selected.request.confirmationId,
        sessionId: reply.sessionId,
        requestTurnId: selected.request.turnId,
        responseTurnId: reply.turnId,
        responseEventId: reply.eventId,
        responseKind: match.responseKind,
        responseTextHash,
        selectedOptionId: match.option.optionId,
        effect: match.option.effect,
        subjectIds: [...selected.request.subjectIds].sort(),
        ...(match.responseKind === "CORRECTION" ? { correctionStatementRef: reply.eventId } : {}),
        relations,
        resolvedAt: reply.occurredAt,
      };
      const parsed = parseConfirmationResolution(resolution);
      if (!parsed.ok) throw new Error("generated ConfirmationResolution failed schema validation");
      this.repository.complete(parsed.value);
      const stored = this.repository.resolution(selected.request.confirmationId);
      if (stored === undefined) throw new Error("completed confirmation resolution is unavailable");
      return { status: "RESOLVED", confirmationId: selected.request.confirmationId, resolution: stored };
    } catch (error) {
      return { status: "RETRYABLE", confirmationId: selected.request.confirmationId, diagnostic: safeError(error) };
    }
  }
}
