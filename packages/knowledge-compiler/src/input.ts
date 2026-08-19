import type { Episode, ProjectContext } from "@zhiloop/domain";

import type { ExtractionProjectContext, KnowledgeExtractionInput } from "./types.js";

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function projectContext(context: ProjectContext): ExtractionProjectContext {
  return {
    projectId: context.projectId,
    ...(context.repositoryRemote === undefined ? {} : { repositoryRemote: context.repositoryRemote }),
    ...(context.branch === undefined ? {} : { branch: context.branch }),
    ...(context.revision === undefined ? {} : { commit: context.revision.commit, dirty: context.revision.dirty }),
    portable: context.portable,
  };
}

export function toKnowledgeExtractionInput(episode: Episode): KnowledgeExtractionInput {
  if (episode.status === "OPEN") throw new Error("OPEN Episode must not be sent to knowledge extraction");
  const allEvidence = new Set(episode.evidenceRefs);
  const relevantEvidence: string[] = [];
  const relevantEvidenceSet = new Set<string>();
  const addEvidence = (reference: string): void => {
    if (!allEvidence.has(reference)) throw new Error(`Episode evidence does not contain referenced event ${reference}`);
    if (!relevantEvidenceSet.has(reference)) {
      relevantEvidenceSet.add(reference);
      relevantEvidence.push(reference);
    }
  };

  addEvidence(episode.goalRef);
  for (const subgoal of episode.subgoals) addEvidence(subgoal.sourceEventId);
  for (const correction of episode.userCorrections) {
    addEvidence(correction.originalRef);
    addEvidence(correction.correctedRef);
  }
  for (const action of episode.actions) {
    if (action.sourceEventIds.length === 0) throw new Error(`Episode action ${action.actionId} has no source event`);
    for (const reference of action.sourceEventIds) addEvidence(reference);
  }
  for (const outcome of episode.outcomes) {
    if (outcome.evidenceRefs.length === 0) throw new Error(`Episode outcome ${outcome.outcomeId} has no evidence`);
    for (const reference of outcome.evidenceRefs) addEvidence(reference);
  }

  const firstEvidence = relevantEvidence[0];
  if (firstEvidence === undefined) throw new Error("Episode must expose at least one relevant evidence reference");
  return deepFreeze({
    schemaVersion: 1,
    episodeId: episode.episodeId,
    builderVersion: episode.builderVersion,
    projectContext: projectContext(episode.projectContext),
    goal: episode.goal,
    goalRef: episode.goalRef,
    subgoals: episode.subgoals.map((subgoal) => ({
      statement: subgoal.statement,
      sourceRef: subgoal.sourceEventId,
    })),
    corrections: episode.userCorrections.map((correction) => ({
      originalRef: correction.originalRef,
      originalStatement: correction.originalStatement,
      correctedRef: correction.correctedRef,
      correctedStatement: correction.correctedStatement,
    })),
    actions: episode.actions.map((action) => ({
      kind: action.kind,
      summary: action.summary,
      sourceRefs: [...action.sourceEventIds] as [string, ...string[]],
    })),
    artifacts: episode.artifacts.map((artifact) => ({
      kind: artifact.kind,
      uri: artifact.uri,
      ...(artifact.contentHash === undefined ? {} : { contentHash: artifact.contentHash }),
    })),
    outcomes: episode.outcomes.map((outcome) => ({
      kind: outcome.kind,
      summary: outcome.summary,
      evidenceRefs: [...outcome.evidenceRefs] as [string, ...string[]],
    })),
    evidenceRefs: relevantEvidence as [string, ...string[]],
  });
}
