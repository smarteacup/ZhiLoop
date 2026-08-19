import {
  calculateCodeGraphArtifactHash,
  deriveCodeGraphArtifactId,
  type CodeGraphArtifact,
  type CodeGraphArtifactFact,
  type CodeGraphArtifactOperation,
  type ProjectContext,
} from "@zhiloop/domain";

import type { CodeIntelligenceCapability } from "./types.js";

const MAX_FACTS = 50;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
}

export function buildCodeGraphArtifact(input: {
  readonly project: ProjectContext;
  readonly projectFingerprint: string;
  readonly capability: CodeIntelligenceCapability;
  readonly operation: CodeGraphArtifactOperation;
  readonly query: string;
  readonly facts: readonly CodeGraphArtifactFact[];
  readonly bounded: boolean | undefined;
  readonly sourceRef: string;
  readonly observedAt: string;
  readonly reasonCodes: readonly string[];
  readonly dependencyFingerprint?: string;
}): CodeGraphArtifact {
  const facts = [...input.facts]
    .sort((left, right) => canonical(left).localeCompare(canonical(right)))
    .slice(0, MAX_FACTS);
  const codeRevision = input.project.revision?.commit ?? input.projectFingerprint;
  const identity = {
    projectId: input.project.projectId,
    codeRevision,
    ...(input.capability.indexRevision === undefined ? {} : { graphRevision: input.capability.indexRevision }),
    ...(input.dependencyFingerprint === undefined ? {} : { dependencyFingerprint: input.dependencyFingerprint }),
    operation: input.operation,
    query: input.query,
  };
  const artifactWithoutHash = {
    schemaVersion: 1 as const,
    artifactId: deriveCodeGraphArtifactId(identity),
    ...identity,
    facts,
    bounded: input.bounded === true || input.facts.length > MAX_FACTS,
    sourceRef: input.sourceRef,
    observedAt: input.observedAt,
    reasonCodes: [...new Set(input.reasonCodes)].sort(),
  };
  return Object.freeze({
    ...artifactWithoutHash,
    status: "ACTIVE" as const,
    contentHash: calculateCodeGraphArtifactHash(artifactWithoutHash),
  });
}
