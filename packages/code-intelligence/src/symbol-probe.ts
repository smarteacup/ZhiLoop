import type { ProjectContext } from "@zhiloop/domain";
import type { ProbeContext, VerificationObservation, VerificationProbe, SymbolAssertion } from "@zhiloop/evidence-engine";

import type { CodeIntelligencePort, CodeProjectSnapshot } from "./types.js";
import { buildCodeGraphArtifact } from "./artifact.js";

const REASONS = {
  READY: "CODEGRAPH_SYMBOL_NOT_FOUND",
  NOT_CONFIGURED: "CODEGRAPH_NOT_CONFIGURED",
  INCOMPATIBLE: "CODEGRAPH_INCOMPATIBLE",
  UNAVAILABLE: "CODEGRAPH_UNAVAILABLE",
} as const;

export interface SymbolProbeOptions {
  readonly fingerprintFor: (project: ProjectContext) => string | undefined | Promise<string | undefined>;
}

function safe(value: string): boolean {
  return value.trim().length > 0 && value.length <= 1_000 && !/[\0\r\n]/u.test(value);
}

function target(assertion: SymbolAssertion): string {
  return `symbol:${assertion.parameters.projectId}:${assertion.parameters.symbol}${assertion.parameters.path === undefined ? "" : `:${assertion.parameters.path}`}`;
}

export function createCodeIntelligenceSymbolProbe(
  port: CodeIntelligencePort,
  options: SymbolProbeOptions,
): VerificationProbe<SymbolAssertion> {
  return Object.freeze({
    observe: async (assertion: SymbolAssertion, context: ProbeContext): Promise<VerificationObservation> => {
      const root = context.project.repositoryRoot;
      const fingerprint = await options.fingerprintFor(context.project);
      if (root === undefined || fingerprint === undefined || !safe(root) || !safe(fingerprint)) {
        return {
          status: "UNKNOWN",
          sourceRef: `project:${context.project.projectId}`,
          observedAt: context.requestedAt,
          target: target(assertion),
          reasonCode: "CODE_INTELLIGENCE_PROJECT_UNAVAILABLE",
        };
      }
      const project: CodeProjectSnapshot = { projectRoot: root, projectFingerprint: fingerprint };
      const result = await port.findSymbols(project, {
        symbol: assertion.parameters.symbol,
        ...(assertion.parameters.path === undefined ? {} : { path: assertion.parameters.path }),
        limit: 10,
      });
      if (result.capability.status !== "READY") {
        const sourceRef = `codegraph:${fingerprint}:${result.capability.indexRevision ?? "revision-unavailable"}:capability`;
        return {
          status: "UNKNOWN",
          sourceRef,
          observedAt: context.requestedAt,
          target: target(assertion),
          reasonCode: REASONS[result.capability.status],
          codeGraphArtifact: buildCodeGraphArtifact({
            project: context.project, projectFingerprint: fingerprint, capability: result.capability,
            operation: "SYMBOL", query: assertion.parameters.symbol, facts: [], bounded: result.bounded,
            sourceRef, observedAt: context.requestedAt, reasonCodes: [REASONS[result.capability.status]],
          }),
        };
      }
      const match = result.facts.find((fact) =>
        fact.symbol === assertion.parameters.symbol
        && (assertion.parameters.path === undefined || fact.path === assertion.parameters.path));
      const sourceRef = match === undefined
        ? `codegraph:${fingerprint}:${result.capability.indexRevision ?? "revision-unavailable"}:query`
        : `codegraph:${fingerprint}:${result.capability.indexRevision ?? "revision-unavailable"}:${match.path}:${match.startLine}`;
      const artifact = buildCodeGraphArtifact({
        project: context.project, projectFingerprint: fingerprint, capability: result.capability,
        operation: "SYMBOL", query: assertion.parameters.symbol,
        facts: result.facts.map((fact) => ({ kind: "SYMBOL", symbol: fact.symbol, qualifiedName: fact.qualifiedName,
          path: fact.path, startLine: fact.startLine, endLine: fact.endLine, language: fact.language, exported: fact.exported })),
        bounded: result.bounded, sourceRef, observedAt: context.requestedAt,
        reasonCodes: [match === undefined ? REASONS.READY : "CODEGRAPH_SYMBOL_FOUND"],
      });
      if (match === undefined) {
        return {
          status: "REFUTED",
          sourceRef,
          observedAt: context.requestedAt,
          target: target(assertion),
          reasonCode: REASONS.READY,
          details: { symbol: assertion.parameters.symbol },
          codeGraphArtifact: artifact,
        };
      }
      return {
        status: "SUPPORTED",
        sourceRef,
        observedAt: context.requestedAt,
        target: target(assertion),
        reasonCode: "CODEGRAPH_SYMBOL_FOUND",
        details: {
          symbol: match.symbol,
          kind: match.kind,
          path: match.path,
          startLine: match.startLine,
          endLine: match.endLine,
          language: match.language,
          exported: match.exported,
        },
        codeGraphArtifact: artifact,
      };
    },
  });
}
