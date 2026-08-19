import type { ProjectContext } from "@zhiloop/domain";
import type {
  CallPathAssertion,
  ImpactAssertion,
  ProbeContext,
  VerificationObservation,
  VerificationProbe,
} from "@zhiloop/evidence-engine";

import type { CodeIntelligencePort, CodeProjectSnapshot } from "./types.js";
import { buildCodeGraphArtifact } from "./artifact.js";

export interface RelationshipProbeOptions {
  readonly fingerprintFor: (project: ProjectContext) => string | undefined | Promise<string | undefined>;
  readonly resultLimit?: number;
}

function safe(value: string): boolean {
  return value.trim().length > 0 && value.length <= 1_000 && !/[\0\r\n]/u.test(value);
}

async function projectSnapshot(
  context: ProbeContext,
  options: RelationshipProbeOptions,
): Promise<CodeProjectSnapshot | undefined> {
  const root = context.project.repositoryRoot;
  const fingerprint = await options.fingerprintFor(context.project);
  return root !== undefined && fingerprint !== undefined && safe(root) && safe(fingerprint)
    ? { projectRoot: root, projectFingerprint: fingerprint }
    : undefined;
}

function graphSource(fingerprint: string, revision: string | undefined, operation: string): string {
  return `codegraph:${fingerprint}:${revision ?? "revision-unavailable"}:${operation}`;
}

export function createCodeIntelligenceCallPathProbe(
  port: CodeIntelligencePort,
  options: RelationshipProbeOptions,
): VerificationProbe<CallPathAssertion> {
  return Object.freeze({
    observe: async (assertion: CallPathAssertion, context: ProbeContext): Promise<VerificationObservation> => {
      const project = await projectSnapshot(context, options);
      const target = `call-path:${assertion.parameters.projectId}:${assertion.parameters.from}->${assertion.parameters.to}:${assertion.parameters.maxDepth ?? 8}`;
      if (project === undefined) return { status: "UNKNOWN", sourceRef: `project:${context.project.projectId}`,
        observedAt: context.requestedAt, target, reasonCode: "CODE_INTELLIGENCE_PROJECT_UNAVAILABLE" };
      const output = await port.trace(project, assertion.parameters.from, assertion.parameters.to,
        assertion.parameters.maxDepth ?? 8, options.resultLimit ?? 50);
      const sourceRef = graphSource(project.projectFingerprint, output.capability.indexRevision, "trace");
      const artifact = buildCodeGraphArtifact({
        project: context.project, projectFingerprint: project.projectFingerprint, capability: output.capability,
        operation: "CALL_PATH", query: `${assertion.parameters.from}->${assertion.parameters.to}`,
        facts: output.facts.map((fact) => ({ kind: "CALL_PATH", from: fact.from, to: fact.to,
          symbols: fact.symbols, paths: fact.paths })), bounded: output.bounded, sourceRef,
        observedAt: context.requestedAt, reasonCodes: [output.capability.reasonCode],
      });
      if (output.capability.status !== "READY" || output.bounded === true) {
        return { status: "UNKNOWN", sourceRef, observedAt: context.requestedAt, target,
          reasonCode: output.capability.reasonCode === "CODEGRAPH_TRACE_BOUNDED"
            ? "CODEGRAPH_CALL_PATH_BOUNDED" : "CODEGRAPH_CALL_PATH_UNAVAILABLE", codeGraphArtifact: artifact };
      }
      const fact = output.facts.find((item) => item.from === assertion.parameters.from && item.to === assertion.parameters.to);
      return fact === undefined
        ? { status: "REFUTED", sourceRef, observedAt: context.requestedAt, target, reasonCode: "CODEGRAPH_CALL_PATH_NOT_FOUND",
          codeGraphArtifact: artifact }
        : { status: "SUPPORTED", sourceRef, observedAt: context.requestedAt, target, reasonCode: "CODEGRAPH_CALL_PATH_FOUND",
          details: { hops: Math.max(0, fact.symbols.length - 1), pathCount: fact.paths.length }, codeGraphArtifact: artifact };
    },
  });
}

export function createCodeIntelligenceImpactProbe(
  port: CodeIntelligencePort,
  options: RelationshipProbeOptions,
): VerificationProbe<ImpactAssertion> {
  return Object.freeze({
    observe: async (assertion: ImpactAssertion, context: ProbeContext): Promise<VerificationObservation> => {
      const project = await projectSnapshot(context, options);
      const target = `impact:${assertion.parameters.projectId}:${assertion.parameters.symbol}->${assertion.parameters.impactedSymbol}`;
      if (project === undefined) return { status: "UNKNOWN", sourceRef: `project:${context.project.projectId}`,
        observedAt: context.requestedAt, target, reasonCode: "CODE_INTELLIGENCE_PROJECT_UNAVAILABLE" };
      const output = await port.impact(project, assertion.parameters.symbol, options.resultLimit ?? 50);
      const sourceRef = graphSource(project.projectFingerprint, output.capability.indexRevision, "impact");
      const artifact = buildCodeGraphArtifact({
        project: context.project, projectFingerprint: project.projectFingerprint, capability: output.capability,
        operation: "IMPACT", query: assertion.parameters.symbol,
        facts: output.facts.map((fact) => ({ kind: "RELATION", symbol: fact.symbol,
          relationKind: fact.kind, path: fact.path, startLine: fact.startLine })), bounded: output.bounded,
        sourceRef, observedAt: context.requestedAt, reasonCodes: [output.capability.reasonCode],
      });
      if (output.capability.status !== "READY" || output.bounded === true) {
        return { status: "UNKNOWN", sourceRef, observedAt: context.requestedAt, target,
          reasonCode: "CODEGRAPH_IMPACT_UNAVAILABLE", codeGraphArtifact: artifact };
      }
      const fact = output.facts.find((item) => item.symbol === assertion.parameters.impactedSymbol);
      return fact === undefined
        ? { status: "REFUTED", sourceRef, observedAt: context.requestedAt, target, reasonCode: "CODEGRAPH_IMPACT_TARGET_NOT_FOUND",
          codeGraphArtifact: artifact }
        : { status: "SUPPORTED", sourceRef,
          observedAt: context.requestedAt, target, reasonCode: "CODEGRAPH_IMPACT_TARGET_FOUND",
          details: { symbol: fact.symbol, kind: fact.kind, path: fact.path, startLine: fact.startLine }, codeGraphArtifact: artifact };
    },
  });
}
