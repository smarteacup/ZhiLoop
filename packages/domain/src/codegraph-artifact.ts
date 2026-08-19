export const CODEGRAPH_ARTIFACT_OPERATIONS = ["SYMBOL", "CALL_PATH", "IMPACT"] as const;
export type CodeGraphArtifactOperation = (typeof CODEGRAPH_ARTIFACT_OPERATIONS)[number];

export type CodeGraphArtifactFact =
  | {
      readonly kind: "SYMBOL" | "RELATION";
      readonly symbol: string;
      readonly relationKind?: string;
      readonly qualifiedName?: string;
      readonly path: string;
      readonly startLine: number;
      readonly endLine?: number;
      readonly language?: string;
      readonly exported?: boolean;
    }
  | {
      readonly kind: "CALL_PATH";
      readonly from: string;
      readonly to: string;
      readonly symbols: readonly string[];
      readonly paths: readonly string[];
    };

export interface CodeGraphArtifact {
  readonly schemaVersion: 1;
  readonly artifactId: string;
  readonly projectId: string;
  readonly codeRevision: string;
  readonly graphRevision?: string;
  readonly dependencyFingerprint?: string;
  readonly operation: CodeGraphArtifactOperation;
  readonly query: string;
  readonly facts: readonly CodeGraphArtifactFact[];
  readonly bounded: boolean;
  readonly sourceRef: string;
  readonly observedAt: string;
  readonly status: "ACTIVE" | "SUSPECT";
  readonly reasonCodes: readonly string[];
  readonly contentHash: string;
}

export interface CodeGraphArtifactReuseContext {
  readonly projectId: string;
  readonly codeRevision: string;
  readonly graphRevision?: string;
  readonly dependencyFingerprint?: string;
  readonly changedPaths?: readonly string[];
  readonly changedSymbols?: readonly string[];
}

export interface CodeGraphArtifactReuseDecision {
  readonly reusable: boolean;
  readonly markSuspect: boolean;
  readonly reasonCodes: readonly string[];
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
}

function hash(value: string): string {
  const state = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  const primes = [0x01000193, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f];
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    for (let lane = 0; lane < state.length; lane += 1) {
      state[lane] = Math.imul((state[lane] ?? 0) ^ (code + lane), primes[lane] ?? 0x01000193);
    }
  }
  return state.map((part) => (part >>> 0).toString(16).padStart(8, "0")).join("");
}

export function calculateCodeGraphArtifactHash(
  artifact: Omit<CodeGraphArtifact, "contentHash" | "status">,
): string {
  return `cg_${hash(canonical(artifact))}`;
}

export function deriveCodeGraphArtifactId(input: {
  readonly projectId: string;
  readonly codeRevision: string;
  readonly graphRevision?: string;
  readonly dependencyFingerprint?: string;
  readonly operation: CodeGraphArtifactOperation;
  readonly query: string;
}): string {
  return `codegraph-artifact_${hash(canonical(input))}`;
}

function referencedPaths(artifact: CodeGraphArtifact): ReadonlySet<string> {
  return new Set(artifact.facts.flatMap((fact) => fact.kind === "CALL_PATH" ? fact.paths : [fact.path]));
}

function referencedSymbols(artifact: CodeGraphArtifact): ReadonlySet<string> {
  return new Set(artifact.facts.flatMap((fact) => fact.kind === "CALL_PATH"
    ? [fact.from, fact.to, ...fact.symbols]
    : [fact.symbol, ...(fact.qualifiedName === undefined ? [] : [fact.qualifiedName])]));
}

export function evaluateCodeGraphArtifactReuse(
  artifact: CodeGraphArtifact,
  context: CodeGraphArtifactReuseContext,
): CodeGraphArtifactReuseDecision {
  const reasons = new Set<string>();
  if (artifact.status !== "ACTIVE") reasons.add("ARTIFACT_ALREADY_SUSPECT");
  if (artifact.projectId !== context.projectId) reasons.add("ARTIFACT_PROJECT_MISMATCH");
  if (artifact.codeRevision !== context.codeRevision) reasons.add("ARTIFACT_CODE_REVISION_MISMATCH");
  if (artifact.graphRevision !== context.graphRevision) reasons.add("ARTIFACT_GRAPH_REVISION_MISMATCH");
  if (artifact.dependencyFingerprint !== context.dependencyFingerprint
    && (artifact.dependencyFingerprint !== undefined || context.dependencyFingerprint !== undefined)) {
    reasons.add("ARTIFACT_DEPENDENCY_FINGERPRINT_MISMATCH");
  }
  const paths = referencedPaths(artifact);
  const symbols = referencedSymbols(artifact);
  if ((context.changedPaths ?? []).some((path) => paths.has(path))) reasons.add("ARTIFACT_REFERENCED_PATH_CHANGED");
  if ((context.changedSymbols ?? []).some((symbol) => symbols.has(symbol))) reasons.add("ARTIFACT_REFERENCED_SYMBOL_CHANGED");
  const markSuspect = [...reasons].some((reason) => reason.endsWith("_CHANGED")
    || reason.includes("REVISION_MISMATCH") || reason.includes("DEPENDENCY_FINGERPRINT_MISMATCH"));
  return Object.freeze({
    reusable: reasons.size === 0,
    markSuspect,
    reasonCodes: Object.freeze(reasons.size === 0 ? ["ARTIFACT_COMPATIBLE"] : [...reasons].sort()),
  });
}
