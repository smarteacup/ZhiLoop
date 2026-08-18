import type { ProjectContext } from "@zhiloop/domain";
import type { ProbeContext, VerificationObservation, VerificationProbe, SymbolAssertion } from "@zhiloop/evidence-engine";

import type { CodeIntelligencePort, CodeProjectSnapshot } from "./types.js";

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
          target: `symbol:${assertion.parameters.symbol}`,
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
        return {
          status: "UNKNOWN",
          sourceRef: `codegraph:${fingerprint}:capability`,
          observedAt: context.requestedAt,
          target: `symbol:${assertion.parameters.symbol}`,
          reasonCode: REASONS[result.capability.status],
        };
      }
      const match = result.facts.find((fact) =>
        fact.symbol === assertion.parameters.symbol
        && (assertion.parameters.path === undefined || fact.path === assertion.parameters.path));
      if (match === undefined) {
        return {
          status: "REFUTED",
          sourceRef: `codegraph:${fingerprint}:query`,
          observedAt: context.requestedAt,
          target: `symbol:${assertion.parameters.symbol}`,
          reasonCode: REASONS.READY,
          details: { symbol: assertion.parameters.symbol },
        };
      }
      return {
        status: "SUPPORTED",
        sourceRef: `codegraph:${fingerprint}:${match.path}:${match.startLine}`,
        observedAt: context.requestedAt,
        target: `symbol:${assertion.parameters.symbol}`,
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
      };
    },
  });
}
