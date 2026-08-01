import type { Episode, NormalizedSession, ProjectContext } from "@zhiloop/domain";

export type EpisodePromptKind = "PRIMARY" | "CONTINUATION" | "SUBGOAL" | "CORRECTION" | "NEW_GOAL";

export interface EpisodePromptClassification {
  readonly kind: EpisodePromptKind;
  readonly statement: string;
}

export interface EpisodePromptContext {
  readonly hasEpisode: boolean;
  readonly currentGoal?: string;
  readonly turnId: string;
}

export type EpisodePromptClassifier = (
  prompt: string,
  context: EpisodePromptContext,
) => EpisodePromptClassification;

export interface EpisodeBuilderOptions {
  readonly builderVersion?: string;
  readonly maxTextChars?: number;
  readonly promptClassifier?: EpisodePromptClassifier;
  readonly projectResolver?: (session: NormalizedSession) => ProjectContext;
}

export interface EpisodeBuildDiagnostic {
  readonly code: "TEXT_TRUNCATED" | "MULTIPLE_PRIMARY_PROMPTS";
  readonly sessionId: string;
  readonly turnId: string;
  readonly eventId: string;
}

export interface EpisodeBuildResult {
  readonly episodes: readonly Episode[];
  readonly diagnostics: readonly EpisodeBuildDiagnostic[];
}
