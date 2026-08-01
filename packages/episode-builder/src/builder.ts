import { createHash } from "node:crypto";

import type { LedgerEventRecord } from "@zhiloop/conversation-ledger";
import type {
  ActionRecord,
  ArtifactRef,
  Correction,
  Episode,
  EpisodeStatus,
  EpisodeSubgoal,
  EpisodeUserStatement,
  NormalizedSession,
  NormalizedTurn,
  Outcome,
  ProjectContext,
} from "@zhiloop/domain";

import { classifyEpisodePrompt } from "./classifier.js";
import type {
  EpisodeBuildDiagnostic,
  EpisodeBuilderOptions,
  EpisodeBuildResult,
  EpisodePromptClassification,
  EpisodePromptContext,
  EpisodePromptClassifier,
} from "./types.js";

const DEFAULT_BUILDER_VERSION = "episode-builder-v2";
const DEFAULT_MAX_TEXT_CHARS = 32_000;
const MAX_TEXT_CHARS = 262_144;
const VERSION = /^[A-Za-z0-9._-]{1,100}$/;
const PROMPT_KINDS = new Set(["PRIMARY", "CONTINUATION", "SUBGOAL", "CORRECTION", "NEW_GOAL"]);

interface VisibleStatement {
  readonly text: string;
  readonly eventId: string;
}

interface EpisodeDraft {
  readonly session: NormalizedSession;
  readonly projectContext: ProjectContext;
  readonly primaryEventId: string;
  readonly turnIds: string[];
  readonly turnIdSet: Set<string>;
  readonly records: LedgerEventRecord[];
  readonly subgoals: EpisodeSubgoal[];
  readonly userStatements: EpisodeUserStatement[];
  readonly corrections: Correction[];
  readonly actions: ActionRecord[];
  readonly artifacts: ArtifactRef[];
  readonly artifactKeys: Set<string>;
  readonly outcomes: Outcome[];
  goal: string;
  forcedStatus?: EpisodeStatus;
}

function hash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textField(value: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return undefined;
}

function promptText(record: LedgerEventRecord): string | undefined {
  if (record.event.eventType !== "user.prompted") return undefined;
  return textField(record.event.payload, ["prompt"]);
}

function assistantText(record: LedgerEventRecord): string | undefined {
  if (record.event.eventType !== "turn.stopped") return undefined;
  return textField(record.event.payload, ["lastAssistantMessage"]);
}

function toolPayload(record: LedgerEventRecord): {
  readonly name: string;
  readonly input: unknown;
  readonly response: unknown;
} | undefined {
  if (record.event.eventType !== "tool.completed" || !isRecord(record.event.payload)) return undefined;
  const name = record.event.payload["toolName"];
  if (typeof name !== "string" || name.length === 0) return undefined;
  return { name, input: record.event.payload["toolInput"], response: record.event.payload["toolResponse"] };
}

function defaultProjectContext(session: NormalizedSession): ProjectContext {
  const context = session.contextKey ?? `session:${session.sessionId}`;
  const repositoryRoot = context.startsWith("cwd:") ? context.slice(4) : undefined;
  return Object.freeze({
    projectId: hash(["project-context", context]),
    ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
    portable: false,
  });
}

function normalizeProjectContext(value: ProjectContext): ProjectContext {
  if (!isRecord(value) || typeof value.projectId !== "string" || value.projectId.trim().length === 0) {
    throw new Error("projectResolver returned an invalid projectId");
  }
  if (typeof value.portable !== "boolean") {
    throw new Error("projectResolver returned an invalid portable flag");
  }
  const optionalFields = ["repositoryRoot", "repositoryRemote", "branch"] as const;
  for (const field of optionalFields) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && (typeof fieldValue !== "string" || fieldValue.trim().length === 0)) {
      throw new Error(`projectResolver returned an invalid ${field}`);
    }
  }
  return Object.freeze({
    projectId: value.projectId,
    ...(value.repositoryRoot === undefined ? {} : { repositoryRoot: value.repositoryRoot }),
    ...(value.repositoryRemote === undefined ? {} : { repositoryRemote: value.repositoryRemote }),
    ...(value.branch === undefined ? {} : { branch: value.branch }),
    portable: value.portable,
  });
}

function assertOptions(options: EpisodeBuilderOptions): {
  readonly builderVersion: string;
  readonly maxTextChars: number;
} {
  const builderVersion = options.builderVersion ?? DEFAULT_BUILDER_VERSION;
  if (!VERSION.test(builderVersion)) throw new Error("builderVersion must contain 1 to 100 safe identifier characters");
  const maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  if (!Number.isSafeInteger(maxTextChars) || maxTextChars < 1 || maxTextChars > MAX_TEXT_CHARS) {
    throw new Error(`maxTextChars must be between 1 and ${MAX_TEXT_CHARS}`);
  }
  return { builderVersion, maxTextChars };
}

function episodeStatus(draft: EpisodeDraft): EpisodeStatus {
  if (draft.forcedStatus !== undefined) return draft.forcedStatus;
  const assignedTurns = draft.session.turns.filter((turn) => draft.turnIdSet.has(turn.turnId));
  if (draft.session.status === "CLOSED") return "COMPLETED";
  return assignedTurns.some((turn) => turn.status === "OPEN") ? "OPEN" : "COMPLETED";
}

function freezeEpisode(draft: EpisodeDraft, builderVersion: string): Episode {
  const orderedRecords = [...draft.records].sort((left, right) => {
    const leftTime = Date.parse(left.event.occurredAt);
    const rightTime = Date.parse(right.event.occurredAt);
    if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
    if (left.sequence !== right.sequence) return left.sequence < right.sequence ? -1 : 1;
    return left.event.eventId.localeCompare(right.event.eventId);
  });
  const first = orderedRecords[0];
  const last = orderedRecords.at(-1);
  if (first === undefined || last === undefined) throw new Error("episode draft must contain at least one event");
  const evidenceRefs = [...new Set(orderedRecords.map((record) => record.event.eventId))];
  return Object.freeze({
    episodeId: hash([builderVersion, draft.session.sessionId, draft.primaryEventId]),
    builderVersion,
    sessionIds: Object.freeze([draft.session.sessionId]) as readonly [string, ...string[]],
    turnIds: Object.freeze([...draft.turnIds]),
    projectContext: Object.freeze({ ...draft.projectContext }),
    goal: draft.goal,
    goalRef: draft.primaryEventId,
    subgoals: Object.freeze([...draft.subgoals]),
    userStatements: Object.freeze([...draft.userStatements]),
    userCorrections: Object.freeze([...draft.corrections]),
    actions: Object.freeze([...draft.actions]),
    artifacts: Object.freeze([...draft.artifacts]),
    outcomes: Object.freeze([...draft.outcomes]),
    evidenceRefs: Object.freeze(evidenceRefs),
    status: episodeStatus(draft),
    createdAt: first.event.occurredAt,
    updatedAt: last.event.occurredAt,
  });
}

function classify(
  classifier: EpisodePromptClassifier,
  prompt: string,
  context: EpisodePromptContext,
): EpisodePromptClassification {
  const result = classifier(prompt, context);
  if (!isRecord(result) || !PROMPT_KINDS.has(String(result["kind"]))) {
    throw new Error("promptClassifier returned an unsupported kind");
  }
  if (typeof result["statement"] !== "string" || result["statement"].trim().length === 0) {
    throw new Error("promptClassifier returned an empty statement");
  }
  return {
    kind: result["kind"] as EpisodePromptClassification["kind"],
    statement: result["statement"].trim(),
  };
}

function commandText(input: unknown): string | undefined {
  return textField(input, ["cmd", "command"]);
}

function artifactPath(input: unknown): string | undefined {
  return textField(input, ["path", "filePath", "file_path", "filename"]);
}

function toolOutcome(response: unknown): "SUCCESS" | "FAILURE" | undefined {
  if (!isRecord(response)) return undefined;
  const exitCode = response["exitCode"] ?? response["exit_code"];
  if (typeof exitCode === "number") return exitCode === 0 ? "SUCCESS" : "FAILURE";
  const status = response["status"];
  if (typeof status !== "string") return undefined;
  if (/^(?:ok|passed|success|succeeded|completed)$/i.test(status)) return "SUCCESS";
  if (/^(?:error|failed|failure)$/i.test(status)) return "FAILURE";
  return undefined;
}

function pushUniqueArtifact(draft: EpisodeDraft, artifact: ArtifactRef): void {
  const key = `${artifact.kind}\0${artifact.uri}`;
  if (draft.artifactKeys.has(key)) return;
  draft.artifactKeys.add(key);
  draft.artifacts.push(Object.freeze(artifact));
}

function enrichFromRecord(
  draft: EpisodeDraft,
  record: LedgerEventRecord,
  limit: (text: string, turnId: string, eventId: string) => string,
  turnId: string,
): void {
  const tool = toolPayload(record);
  if (tool !== undefined) {
    const command = commandText(tool.input);
    const isCommand = /(?:shell|exec|command|terminal)/i.test(tool.name);
    const summary = command === undefined
      ? `Used tool: ${tool.name}`
      : `Ran command: ${limit(command, turnId, record.event.eventId)}`;
    draft.actions.push(Object.freeze({
      actionId: hash(["action", record.event.eventId]),
      kind: isCommand ? "COMMAND" : "TOOL",
      summary,
      sourceEventIds: Object.freeze([record.event.eventId]),
      occurredAt: record.event.occurredAt,
    }));
    const pathValue = artifactPath(tool.input);
    if (pathValue !== undefined && /(?:patch|write|edit|file)/i.test(tool.name)) {
      const uri = limit(pathValue, turnId, record.event.eventId);
      pushUniqueArtifact(draft, {
        artifactId: hash(["artifact", record.event.eventId, "FILE", uri]),
        kind: "FILE",
        uri,
      });
    }
    const outcomeKind = toolOutcome(tool.response);
    if (outcomeKind !== undefined) {
      draft.outcomes.push(Object.freeze({
        outcomeId: hash(["outcome", record.event.eventId, outcomeKind]),
        kind: outcomeKind,
        summary: `Tool ${tool.name} ${outcomeKind === "SUCCESS" ? "succeeded" : "failed"}`,
        evidenceRefs: Object.freeze([record.event.eventId]),
      }));
    }
  }

  if (record.event.eventType === "file.changed") {
    draft.actions.push(Object.freeze({
      actionId: hash(["action", record.event.eventId]),
      kind: "FILE_CHANGE",
      summary: "Observed a file change",
      sourceEventIds: Object.freeze([record.event.eventId]),
      occurredAt: record.event.occurredAt,
    }));
    const pathValue = textField(record.event.payload, ["path", "filePath", "file_path"]);
    if (pathValue !== undefined) {
      const uri = limit(pathValue, turnId, record.event.eventId);
      pushUniqueArtifact(draft, {
        artifactId: hash(["artifact", record.event.eventId, "FILE", uri]),
        kind: "FILE",
        uri,
        ...(record.event.contentHash.length === 0 ? {} : { contentHash: record.event.contentHash }),
      });
    }
  }

  const assistant = assistantText(record);
  if (assistant !== undefined) {
    draft.outcomes.push(Object.freeze({
      outcomeId: hash(["outcome", record.event.eventId, "UNKNOWN"]),
      kind: "UNKNOWN",
      summary: limit(assistant, turnId, record.event.eventId),
      evidenceRefs: Object.freeze([record.event.eventId]),
    }));
  }
}

function recordsForTurn(turn: NormalizedTurn, lookup: ReadonlyMap<string, LedgerEventRecord>): LedgerEventRecord[] {
  return turn.events.map((reference) => {
    const record = lookup.get(reference.eventId);
    if (record === undefined) throw new Error(`normalized event ${reference.eventId} is missing from the Ledger input`);
    if (
      record.sequence !== reference.sourceOrder ||
      record.event.source !== reference.source ||
      record.event.eventType !== reference.eventType ||
      record.event.occurredAt !== reference.occurredAt ||
      record.event.sessionId !== turn.sessionId
    ) {
      throw new Error(`normalized event ${reference.eventId} does not match its Ledger record`);
    }
    return record;
  });
}

function newDraft(
  session: NormalizedSession,
  projectContext: ProjectContext,
  goal: string,
  primaryEventId: string,
): EpisodeDraft {
  return {
    session,
    projectContext,
    primaryEventId,
    turnIds: [],
    turnIdSet: new Set(),
    records: [],
    subgoals: [],
    userStatements: [],
    corrections: [],
    actions: [],
    artifacts: [],
    artifactKeys: new Set(),
    outcomes: [],
    goal,
  };
}

export function buildEpisodes(
  records: readonly LedgerEventRecord[],
  sessions: readonly NormalizedSession[],
  options: EpisodeBuilderOptions = {},
): EpisodeBuildResult {
  const validated = assertOptions(options);
  const classifier = options.promptClassifier ?? classifyEpisodePrompt;
  const projectResolver = options.projectResolver ?? defaultProjectContext;
  const lookup = new Map<string, LedgerEventRecord>();
  for (const record of records) {
    if (lookup.has(record.event.eventId)) throw new Error(`duplicate Ledger eventId: ${record.event.eventId}`);
    lookup.set(record.event.eventId, record);
  }

  const diagnostics: EpisodeBuildDiagnostic[] = [];
  const episodes: Episode[] = [];
  const referenced = new Set<string>();
  const truncatedEvents = new Set<string>();
  const limit = (text: string, sessionId: string, turnId: string, eventId: string): string => {
    if (text.length <= validated.maxTextChars) return text;
    if (!truncatedEvents.has(eventId)) {
      truncatedEvents.add(eventId);
      diagnostics.push(Object.freeze({ code: "TEXT_TRUNCATED", sessionId, turnId, eventId }));
    }
    if (validated.maxTextChars === 1) return "…";
    return `${text.slice(0, validated.maxTextChars - 1)}…`;
  };

  for (const session of sessions) {
    const projectContext = normalizeProjectContext(projectResolver(session));
    let draft: EpisodeDraft | undefined;
    let lastStatement: VisibleStatement | undefined;
    const completedDrafts: EpisodeDraft[] = [];

    for (const turn of session.turns) {
      const turnRecords = recordsForTurn(turn, lookup);
      for (const record of turnRecords) {
        if (referenced.has(record.event.eventId)) {
          throw new Error(`normalized input references Ledger event ${record.event.eventId} more than once`);
        }
        referenced.add(record.event.eventId);
      }
      const prompts = turnRecords.flatMap((record) => {
        const prompt = promptText(record);
        if (record.event.eventType === "user.prompted" && prompt === undefined) {
          throw new Error(`user prompt ${record.event.eventId} is unavailable or invalid`);
        }
        return prompt === undefined ? [] : [{ record, prompt }];
      });
      const firstPrompt = prompts[0];
      let firstClassification: EpisodePromptClassification | undefined;
      if (firstPrompt !== undefined) {
        firstClassification = classify(classifier, firstPrompt.prompt, {
          hasEpisode: draft !== undefined,
          ...(draft === undefined ? {} : { currentGoal: draft.goal }),
          turnId: turn.turnId,
        });
        if (firstClassification.kind === "NEW_GOAL" && draft !== undefined) {
          const priorTurns = session.turns.filter((item) => draft?.turnIdSet.has(item.turnId));
          draft.forcedStatus = priorTurns.every((item) => item.status === "CLOSED") ? "COMPLETED" : "ABANDONED";
          completedDrafts.push(draft);
          draft = undefined;
          firstClassification = { kind: "PRIMARY", statement: firstClassification.statement };
        } else if (firstClassification.kind === "PRIMARY" && draft !== undefined) {
          diagnostics.push(Object.freeze({
            code: "MULTIPLE_PRIMARY_PROMPTS",
            sessionId: session.sessionId,
            turnId: turn.turnId,
            eventId: firstPrompt.record.event.eventId,
          }));
          firstClassification = { kind: "SUBGOAL", statement: firstClassification.statement };
        }
      }

      if (draft === undefined) {
        const primary = firstPrompt;
        const rawGoal = firstClassification?.statement ?? "Unattributed session activity";
        const primaryEventId = primary?.record.event.eventId ?? turnRecords[0]?.event.eventId;
        if (primaryEventId === undefined) continue;
        draft = newDraft(
          session,
          projectContext,
          limit(rawGoal, session.sessionId, turn.turnId, primaryEventId),
          primaryEventId,
        );
      }

      if (!draft.turnIdSet.has(turn.turnId)) {
        draft.turnIdSet.add(turn.turnId);
        draft.turnIds.push(turn.turnId);
      }
      draft.records.push(...turnRecords);
      for (const record of turnRecords) {
        enrichFromRecord(
          draft,
          record,
          (text, turnId, eventId) => limit(text, session.sessionId, turnId, eventId),
          turn.turnId,
        );
      }

      for (const [index, item] of prompts.entries()) {
        let classification = index === 0 && firstClassification !== undefined
          ? firstClassification
          : classify(classifier, item.prompt, { hasEpisode: true, currentGoal: draft.goal, turnId: turn.turnId });
        if (index > 0 && (classification.kind === "PRIMARY" || classification.kind === "NEW_GOAL")) {
          diagnostics.push(Object.freeze({
            code: "MULTIPLE_PRIMARY_PROMPTS",
            sessionId: session.sessionId,
            turnId: turn.turnId,
            eventId: item.record.event.eventId,
          }));
          classification = { kind: "SUBGOAL", statement: classification.statement };
        }
        const statement = classification.kind === "PRIMARY" && item.record.event.eventId === draft.primaryEventId
          ? draft.goal
          : limit(classification.statement, session.sessionId, turn.turnId, item.record.event.eventId);
        const statementKind = classification.kind === "PRIMARY" || classification.kind === "NEW_GOAL"
          ? "GOAL"
          : classification.kind;
        draft.userStatements.push(Object.freeze({
          turnId: turn.turnId,
          sourceEventId: item.record.event.eventId,
          kind: statementKind,
          statement,
          occurredAt: item.record.event.occurredAt,
        }));
        if (classification.kind === "CORRECTION") {
          const original = lastStatement ?? { text: draft.goal, eventId: draft.primaryEventId };
          draft.corrections.push(Object.freeze({
            correctionId: hash(["correction", item.record.event.eventId]),
            turnId: turn.turnId,
            originalRef: original.eventId,
            originalStatement: limit(original.text, session.sessionId, turn.turnId, item.record.event.eventId),
            correctedRef: item.record.event.eventId,
            correctedStatement: statement,
            occurredAt: item.record.event.occurredAt,
          }));
        } else if (classification.kind === "SUBGOAL") {
          draft.subgoals.push(Object.freeze({
            goalId: hash(["subgoal", item.record.event.eventId]),
            turnId: turn.turnId,
            sourceEventId: item.record.event.eventId,
            statement,
            occurredAt: item.record.event.occurredAt,
          }));
        }
        if (classification.kind !== "CONTINUATION") {
          lastStatement = { text: statement, eventId: item.record.event.eventId };
        }
      }

      for (const record of turnRecords) {
        const assistant = assistantText(record);
        if (assistant !== undefined) {
          lastStatement = {
            text: limit(assistant, session.sessionId, turn.turnId, record.event.eventId),
            eventId: record.event.eventId,
          };
        }
      }
    }

    if (draft !== undefined) completedDrafts.push(draft);
    const sessionRecords = session.sessionEvents.map((reference) => {
      if (referenced.has(reference.eventId)) {
        throw new Error(`normalized input references Ledger event ${reference.eventId} more than once`);
      }
      referenced.add(reference.eventId);
      const record = lookup.get(reference.eventId);
      if (record === undefined) throw new Error(`session boundary ${reference.eventId} is missing from the Ledger input`);
      if (
        record.sequence !== reference.sourceOrder ||
        record.event.source !== reference.source ||
        record.event.eventType !== reference.eventType ||
        record.event.occurredAt !== reference.occurredAt ||
        record.event.sessionId !== session.sessionId
      ) {
        throw new Error(`session boundary ${reference.eventId} does not match its Ledger record`);
      }
      return record;
    });
    if (completedDrafts.length > 0) {
      const firstDraft = completedDrafts[0] as EpisodeDraft;
      const lastDraft = completedDrafts.at(-1) as EpisodeDraft;
      firstDraft.records.unshift(...sessionRecords.filter((record) => record.event.eventType === "session.started"));
      lastDraft.records.push(...sessionRecords.filter((record) => record.event.eventType === "session.ended"));
      episodes.push(...completedDrafts.map((item) => freezeEpisode(item, validated.builderVersion)));
    }
  }

  for (const record of records) {
    if (!referenced.has(record.event.eventId)) throw new Error(`Ledger event ${record.event.eventId} is not referenced by normalized input`);
  }
  return Object.freeze({
    episodes: Object.freeze(episodes),
    diagnostics: Object.freeze(diagnostics),
  });
}
