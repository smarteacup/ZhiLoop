import type { ProjectContext } from "@zhiloop/domain";

export interface GitProjectFacts {
  readonly repositoryRoot: string;
  readonly gitCommonDir: string;
  readonly remoteUrl?: string;
  readonly branch?: string;
}

export interface GitProjectProbe {
  inspect(cwd: string): Promise<GitProjectFacts | undefined>;
}

export type ProjectIdentitySource = "GIT_REMOTE" | "GIT_LOCAL" | "FILESYSTEM_LOCAL";

export interface ProjectIdentityResolution {
  readonly context: ProjectContext;
  readonly source: ProjectIdentitySource;
  readonly rootMarker: string;
  readonly reasonCodes: readonly string[];
}

export interface ProjectIdentityResolverOptions {
  readonly gitProbe?: GitProjectProbe;
  readonly markerNames?: readonly string[];
}

export interface CliGitProjectProbeOptions {
  readonly executable?: string;
  readonly timeoutMs?: number;
}
