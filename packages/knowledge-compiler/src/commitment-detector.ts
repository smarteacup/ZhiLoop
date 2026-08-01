import { createHash } from "node:crypto";

import type {
  Correction,
  Episode,
  EpisodeUserStatement,
  KnowledgeAssertion,
  KnowledgeCandidate,
} from "@zhiloop/domain";

export type UserCommitmentKind = "USER_ACCEPTED" | "USER_REJECTED" | "CORRECTION";

export type UserCommitmentReasonCode =
  | "EXPLICIT_SOURCE_REFERENCE"
  | "EXPLICIT_TOPIC_MATCH"
  | "SINGLE_PROPOSAL"
  | "FOLLOWED_BY_IMPLEMENTATION"
  | "TARGET_UNRESOLVED";

export interface UserCommitmentSignal {
  readonly signalId: string;
  readonly episodeId: string;
  readonly kind: UserCommitmentKind;
  readonly candidateIds: readonly string[];
  readonly turnId: string;
  readonly statementRef: string;
  readonly statement: string;
  readonly occurredAt: string;
  readonly originalRef?: string;
  readonly originalStatement?: string;
  readonly correctedRef?: string;
  readonly correctedStatement?: string;
  readonly reasonCodes: readonly UserCommitmentReasonCode[];
}

export interface UserCommitmentAmbiguity {
  readonly kind: UserCommitmentKind;
  readonly turnId: string;
  readonly statementRef: string;
  readonly statement: string;
  readonly candidateIds: readonly string[];
  readonly reasonCode: "MULTIPLE_PLAUSIBLE_TARGETS";
}

export interface UserCommitmentDetectionResult {
  readonly signals: readonly UserCommitmentSignal[];
  readonly ambiguities: readonly UserCommitmentAmbiguity[];
}

type AssertionCommitmentKind = Extract<UserCommitmentKind, "USER_ACCEPTED" | "USER_REJECTED">;

interface TargetResolution {
  readonly candidateIds: readonly string[];
  readonly reasonCode?: Exclude<UserCommitmentReasonCode, "FOLLOWED_BY_IMPLEMENTATION" | "TARGET_UNRESOLVED">;
  readonly ambiguousCandidateIds: readonly string[];
}

interface CandidateProfile {
  readonly candidate: KnowledgeCandidate;
  readonly compactTitle: string;
  readonly topicTokens: readonly string[];
}

const LEADING_ACKNOWLEDGEMENT = "(?:(?:好(?:的)?|可以|确认|没问题)[\\s，,:：]+)?";
const ACCEPTANCE = new RegExp(
  `^${LEADING_ACKNOWLEDGEMENT}(?:按这个做|就按这个(?:做|方案)?|(?:采用|同意|确认采用)[^。；;\\n]{0,40}(?:方案|设计|实现)|可以实施|照此执行|approved?|proceed with this|use this approach)`,
  "iu",
);
const REJECTION = new RegExp(
  `^${LEADING_ACKNOWLEDGEMENT}(?:不是这个意思|不采用|不要使用|不要用|别用|否定|拒绝|不接受|do not use|don't use|reject(?:ed)?)`,
  "iu",
);
const PROPOSAL_KINDS = new Set(["REQUIREMENT", "DESIGN", "DECISION"]);
const STOP_WORDS = new Set([
  "the", "this", "that", "with", "from", "into", "use", "using", "used", "cache", "design", "approach",
  "solution", "proposal", "project", "apply", "proposed", "方案", "这个", "上述", "采用", "使用", "不要", "改用",
  "缓存", "设计", "意思", "实现", "项目",
]);

function hash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function compact(value: string): string {
  return normalize(value).replace(/\s+/g, "");
}

function topicTokens(candidate: KnowledgeCandidate): readonly string[] {
  const source = normalize(`${candidate.title} ${candidate.subjectKey.replace(/[.-]/g, " ")} ${candidate.summary}`);
  const tokens = source.match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
  return [...new Set(tokens.filter((token) => token.length >= 3 && !STOP_WORDS.has(token)))];
}

function candidateProfile(candidate: KnowledgeCandidate): CandidateProfile {
  return { candidate, compactTitle: compact(candidate.title), topicTokens: topicTokens(candidate) };
}

function lexicalScore(
  normalizedStatement: string,
  compactStatement: string,
  profile: CandidateProfile,
): number {
  const { compactTitle } = profile;
  let score = compactTitle.length >= 4 && compactStatement.includes(compactTitle) ? 1_000 + compactTitle.length : 0;
  for (const token of profile.topicTokens) {
    if (normalizedStatement.includes(token)) score = Math.max(score, token.length);
  }
  return score;
}

function sortedIds(candidates: readonly KnowledgeCandidate[]): readonly string[] {
  return candidates.map((candidate) => candidate.candidateId).sort((left, right) => left.localeCompare(right));
}

function resolveByText(
  statement: string,
  profiles: readonly CandidateProfile[],
): TargetResolution {
  const normalizedStatement = normalize(statement);
  const compactStatement = compact(statement);
  const scored = profiles
    .map((profile) => ({ candidate: profile.candidate, score: lexicalScore(normalizedStatement, compactStatement, profile) }))
    .filter((item) => item.score > 0);
  const topScore = Math.max(0, ...scored.map((item) => item.score));
  const lexicalTargets = scored.filter((item) => item.score === topScore).map((item) => item.candidate);
  if (lexicalTargets.length === 1) {
    return {
      candidateIds: sortedIds(lexicalTargets),
      reasonCode: "EXPLICIT_TOPIC_MATCH",
      ambiguousCandidateIds: [],
    };
  }
  if (lexicalTargets.length > 1) {
    return { candidateIds: [], ambiguousCandidateIds: sortedIds(lexicalTargets) };
  }

  const proposals = profiles
    .map((profile) => profile.candidate)
    .filter((candidate) => PROPOSAL_KINDS.has(candidate.kind));
  if (proposals.length === 1) {
    return {
      candidateIds: sortedIds(proposals),
      reasonCode: "SINGLE_PROPOSAL",
      ambiguousCandidateIds: [],
    };
  }
  return {
    candidateIds: [],
    ambiguousCandidateIds: proposals.length > 1 ? sortedIds(proposals) : [],
  };
}

function sourceTargets(reference: string, candidates: readonly KnowledgeCandidate[]): readonly KnowledgeCandidate[] {
  return candidates.filter((candidate) =>
    candidate.evidenceHints.some((hint) => hint.sourceRef === reference)
    || candidate.assertions.some((assertion) =>
      (assertion.kind === "USER_ACCEPTED" || assertion.kind === "USER_REJECTED")
      && assertion.parameters.statementRef === reference));
}

function markerKind(statement: string): AssertionCommitmentKind | undefined {
  if (REJECTION.test(statement)) return "USER_REJECTED";
  if (ACCEPTANCE.test(statement)) return "USER_ACCEPTED";
  return undefined;
}

function hasLaterImplementation(episode: Episode, statement: EpisodeUserStatement): boolean {
  const statementTime = Date.parse(statement.occurredAt);
  return episode.actions.some((action) => Date.parse(action.occurredAt) > statementTime);
}

function createSignal(
  episode: Episode,
  kind: UserCommitmentKind,
  statement: EpisodeUserStatement,
  candidateIds: readonly string[],
  reasonCodes: readonly UserCommitmentReasonCode[],
  correction?: Correction,
): UserCommitmentSignal {
  const stableCandidateIds = [...candidateIds].sort((left, right) => left.localeCompare(right));
  return deepFreeze({
    signalId: hash([
      "user-commitment-signal-v1",
      episode.episodeId,
      kind,
      statement.sourceEventId,
      correction?.originalRef ?? "",
      ...stableCandidateIds,
    ]),
    episodeId: episode.episodeId,
    kind,
    candidateIds: stableCandidateIds,
    turnId: statement.turnId,
    statementRef: statement.sourceEventId,
    statement: statement.statement,
    occurredAt: statement.occurredAt,
    ...(correction === undefined ? {} : {
      originalRef: correction.originalRef,
      originalStatement: correction.originalStatement,
      correctedRef: correction.correctedRef,
      correctedStatement: correction.correctedStatement,
    }),
    reasonCodes: [...reasonCodes],
  });
}

function createAmbiguity(
  kind: UserCommitmentKind,
  statement: EpisodeUserStatement,
  candidateIds: readonly string[],
): UserCommitmentAmbiguity {
  return deepFreeze({
    kind,
    turnId: statement.turnId,
    statementRef: statement.sourceEventId,
    statement: statement.statement,
    candidateIds: [...candidateIds],
    reasonCode: "MULTIPLE_PLAUSIBLE_TARGETS",
  });
}

function assertEpisodeTraceability(episode: Episode): void {
  if (episode.status === "OPEN") throw new Error("cannot detect commitments from an OPEN Episode");
  const evidenceRefs = new Set(episode.evidenceRefs);
  if (evidenceRefs.size !== episode.evidenceRefs.length) throw new Error("Episode evidenceRefs must be unique");
  const statementRefs = new Set<string>();
  for (const statement of episode.userStatements) {
    if (statementRefs.has(statement.sourceEventId)) {
      throw new Error(`duplicate user statement reference: ${statement.sourceEventId}`);
    }
    statementRefs.add(statement.sourceEventId);
    if (statement.turnId.trim().length === 0 || statement.statement.trim().length === 0) {
      throw new Error(`user statement ${statement.sourceEventId} is invalid`);
    }
    if (!Number.isFinite(Date.parse(statement.occurredAt))) {
      throw new Error(`user statement ${statement.sourceEventId} has an invalid occurredAt`);
    }
    if (!evidenceRefs.has(statement.sourceEventId)) {
      throw new Error(`user statement ${statement.sourceEventId} is absent from Episode evidence`);
    }
  }
  const correctedRefs = new Set<string>();
  for (const correction of episode.userCorrections) {
    if (correctedRefs.has(correction.correctedRef)) {
      throw new Error(`duplicate correction reference: ${correction.correctedRef}`);
    }
    correctedRefs.add(correction.correctedRef);
    if (!evidenceRefs.has(correction.originalRef) || !evidenceRefs.has(correction.correctedRef)) {
      throw new Error(`correction ${correction.correctionId} is absent from Episode evidence`);
    }
    const statement = episode.userStatements.find((item) => item.sourceEventId === correction.correctedRef);
    if (statement !== undefined && (
      statement.turnId !== correction.turnId
      || statement.statement !== correction.correctedStatement
      || statement.occurredAt !== correction.occurredAt
    )) {
      throw new Error(`correction ${correction.correctionId} conflicts with its user statement`);
    }
  }
}

export function detectUserCommitments(
  episode: Episode,
  candidates: readonly KnowledgeCandidate[],
): UserCommitmentDetectionResult {
  assertEpisodeTraceability(episode);
  const candidateIds = new Set<string>();
  for (const candidate of candidates) {
    if (candidateIds.has(candidate.candidateId)) throw new Error(`duplicate candidateId: ${candidate.candidateId}`);
    candidateIds.add(candidate.candidateId);
  }
  const localCandidates = candidates.filter((candidate) => candidate.sourceEpisodes.includes(episode.episodeId));
  const localProfiles = localCandidates.map(candidateProfile);
  const statements = new Map(episode.userStatements.map((statement) => [statement.sourceEventId, statement]));
  const handledCorrections = new Set<string>();
  const signals: UserCommitmentSignal[] = [];
  const ambiguities: UserCommitmentAmbiguity[] = [];

  for (const correction of episode.userCorrections) {
    const correctionStatement = statements.get(correction.correctedRef) ?? {
      turnId: correction.turnId,
      sourceEventId: correction.correctedRef,
      kind: "CORRECTION" as const,
      statement: correction.correctedStatement,
      occurredAt: correction.occurredAt,
    };
    handledCorrections.add(correction.correctedRef);
    const referenced = sourceTargets(correction.originalRef, localCandidates);
    const resolution = referenced.length > 0
      ? {
          candidateIds: sortedIds(referenced),
          reasonCode: "EXPLICIT_SOURCE_REFERENCE" as const,
          ambiguousCandidateIds: [],
        }
      : resolveByText(correction.originalStatement, localProfiles);
    const reasons: UserCommitmentReasonCode[] = resolution.reasonCode === undefined
      ? ["TARGET_UNRESOLVED"]
      : [resolution.reasonCode];
    signals.push(createSignal(episode, "CORRECTION", correctionStatement, resolution.candidateIds, reasons, correction));
    if (resolution.ambiguousCandidateIds.length > 0) {
      ambiguities.push(createAmbiguity("CORRECTION", correctionStatement, resolution.ambiguousCandidateIds));
    }
    if (markerKind(correction.correctedStatement) === "USER_REJECTED" && resolution.candidateIds.length > 0) {
      signals.push(createSignal(
        episode,
        "USER_REJECTED",
        correctionStatement,
        resolution.candidateIds,
        reasons,
        correction,
      ));
    }
  }

  for (const statement of episode.userStatements) {
    if (handledCorrections.has(statement.sourceEventId)) continue;
    const kind = markerKind(statement.statement);
    if (kind === undefined) continue;
    const referenced = sourceTargets(statement.sourceEventId, localCandidates);
    const resolution: TargetResolution = referenced.length === 1
      ? {
          candidateIds: sortedIds(referenced),
          reasonCode: "EXPLICIT_SOURCE_REFERENCE",
          ambiguousCandidateIds: [],
        }
      : referenced.length > 1
        ? { candidateIds: [], ambiguousCandidateIds: sortedIds(referenced) }
        : resolveByText(statement.statement, localProfiles);
    if (resolution.candidateIds.length === 0) {
      if (resolution.ambiguousCandidateIds.length > 0) {
        ambiguities.push(createAmbiguity(kind, statement, resolution.ambiguousCandidateIds));
      }
      continue;
    }
    const reasons: UserCommitmentReasonCode[] = resolution.reasonCode === undefined ? [] : [resolution.reasonCode];
    if (kind === "USER_ACCEPTED" && hasLaterImplementation(episode, statement)) {
      reasons.push("FOLLOWED_BY_IMPLEMENTATION");
    }
    signals.push(createSignal(episode, kind, statement, resolution.candidateIds, reasons));
  }

  return deepFreeze({ signals, ambiguities });
}

export function applyUserCommitments(
  candidates: readonly KnowledgeCandidate[],
  detection: UserCommitmentDetectionResult,
): readonly KnowledgeCandidate[] {
  const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const additions = new Map<string, KnowledgeAssertion[]>();
  for (const signal of detection.signals) {
    if (signal.kind !== "CORRECTION" && signal.kind !== "USER_ACCEPTED" && signal.kind !== "USER_REJECTED") {
      throw new Error(`unsupported commitment signal kind: ${String(signal.kind)}`);
    }
    if (signal.statementRef.trim().length === 0 || !Number.isFinite(Date.parse(signal.occurredAt))) {
      throw new Error(`commitment signal ${signal.signalId} is invalid`);
    }
    if (new Set(signal.candidateIds).size !== signal.candidateIds.length) {
      throw new Error(`commitment signal ${signal.signalId} has duplicate candidate targets`);
    }
    if (signal.kind === "CORRECTION") continue;
    for (const candidateId of signal.candidateIds) {
      const candidate = byId.get(candidateId);
      if (candidate === undefined) throw new Error(`commitment signal targets unknown candidate: ${candidateId}`);
      const duplicate = candidate.assertions.some((assertion) =>
        assertion.kind === signal.kind && assertion.parameters.statementRef === signal.statementRef)
        || (additions.get(candidateId) ?? []).some((assertion) =>
          assertion.kind === signal.kind && assertion.parameters.statementRef === signal.statementRef);
      if (duplicate) continue;
      const assertion: KnowledgeAssertion = {
        assertionId: hash(["user-commitment-assertion-v1", candidateId, signal.kind, signal.statementRef]),
        candidateId,
        kind: signal.kind,
        parameters: { statementRef: signal.statementRef },
        createdAt: signal.occurredAt,
      };
      const current = additions.get(candidateId) ?? [];
      current.push(assertion);
      additions.set(candidateId, current);
    }
  }

  const enriched = candidates.map((candidate) => {
    const candidateAdditions = additions.get(candidate.candidateId) ?? [];
    return {
      ...structuredClone(candidate),
      assertions: [...candidate.assertions.map((assertion) => structuredClone(assertion)), ...candidateAdditions],
    } as KnowledgeCandidate;
  });
  return deepFreeze(enriched);
}
