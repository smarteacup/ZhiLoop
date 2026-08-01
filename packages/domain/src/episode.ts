import type { ProjectContext } from "./scope.js";

export type EpisodeStatus = "OPEN" | "COMPLETED" | "ABANDONED";

export interface Correction {
  readonly correctionId: string;
  readonly turnId: string;
  readonly originalRef?: string;
  readonly correctedStatement: string;
  readonly occurredAt: string;
}

export interface ActionRecord {
  readonly actionId: string;
  readonly kind: "TOOL" | "COMMAND" | "FILE_CHANGE" | "DECISION";
  readonly summary: string;
  readonly sourceEventIds: readonly string[];
  readonly occurredAt: string;
}

export interface ArtifactRef {
  readonly artifactId: string;
  readonly kind: "FILE" | "DIFF" | "DOCUMENT" | "URL";
  readonly uri: string;
  readonly contentHash?: string;
}

export interface Outcome {
  readonly outcomeId: string;
  readonly kind: "SUCCESS" | "FAILURE" | "PARTIAL" | "UNKNOWN";
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
}

export interface Episode {
  readonly episodeId: string;
  readonly sessionIds: readonly [string, ...string[]];
  readonly turnIds: readonly string[];
  readonly projectContext: ProjectContext;
  readonly goal: string;
  readonly userCorrections: readonly Correction[];
  readonly actions: readonly ActionRecord[];
  readonly artifacts: readonly ArtifactRef[];
  readonly outcomes: readonly Outcome[];
  readonly evidenceRefs: readonly string[];
  readonly status: EpisodeStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

