import type { CompilationPolicy } from "@zhiloop/config";
import type { KnowledgeKind } from "@zhiloop/domain";

export type PublicationDenialReason =
  | "PUBLICATION_INPUT_INVALID"
  | "PUBLICATION_DISABLED"
  | "EXECUTION_MODE_NOT_SAFE"
  | "PROJECT_NOT_ALLOWLISTED"
  | "KNOWLEDGE_KIND_NOT_ALLOWLISTED"
  | "SOURCE_OR_GROUNDING_INCOMPLETE"
  | "SCOPE_NOT_DETERMINISTIC"
  | "EVOLUTION_UNRESOLVED"
  | "FRESH_CODE_EVIDENCE_REQUIRED"
  | "PROTECTED_KNOWLEDGE_TARGET"
  | "EXPECTED_VERSION_CHANGED"
  | "GOLDEN_EVIDENCE_MISMATCH";

export interface PublicationGateInput {
  readonly candidateId: string;
  readonly projectId: string;
  readonly kind: KnowledgeKind;
  readonly sourceComplete: boolean;
  readonly groundingComplete: boolean;
  readonly deterministicScope: boolean;
  readonly evolutionAction: "CREATE" | "MERGE" | "SUPERSEDE" | "CONTRADICT" | "NO_CHANGE" | "PENDING";
  readonly freshnessStatus: "FRESH" | "NOT_REQUIRED" | "REVALIDATE" | "CONFLICT" | "UNKNOWN" | "NOT_PROJECTED";
  readonly protectedTarget: boolean;
  readonly expectedVersionCurrent: boolean;
  readonly evidence: {
    readonly datasetId: string;
    readonly datasetVersion: number;
    readonly configFingerprint: string;
  };
}

export type PublicationGateDecision =
  | { readonly authorized: true; readonly executionMode: "SAFE_AUTO_PUBLICATION"; readonly reasonCode: "ALL_PUBLICATION_GATES_PASSED" }
  | { readonly authorized: false; readonly executionMode: "PREVIEW_ONLY"; readonly reasonCode: PublicationDenialReason };

function denied(reasonCode: PublicationDenialReason): PublicationGateDecision {
  return Object.freeze({ authorized: false, executionMode: "PREVIEW_ONLY", reasonCode });
}

function validInput(input: PublicationGateInput): boolean {
  const actions = new Set(["CREATE", "MERGE", "SUPERSEDE", "CONTRADICT", "NO_CHANGE", "PENDING"]);
  const statuses = new Set(["FRESH", "NOT_REQUIRED", "REVALIDATE", "CONFLICT", "UNKNOWN", "NOT_PROJECTED"]);
  const safe = (value: unknown, maximum = 500) => typeof value === "string" && value.trim().length > 0
    && value.length <= maximum && !/[\0\r\n]/u.test(value);
  return safe(input.candidateId) && safe(input.projectId) && actions.has(input.evolutionAction)
    && statuses.has(input.freshnessStatus)
    && typeof input.sourceComplete === "boolean" && typeof input.groundingComplete === "boolean"
    && typeof input.deterministicScope === "boolean" && typeof input.protectedTarget === "boolean"
    && typeof input.expectedVersionCurrent === "boolean" && safe(input.evidence.datasetId, 200)
    && Number.isSafeInteger(input.evidence.datasetVersion) && input.evidence.datasetVersion > 0
    && /^[a-f0-9]{64}$/u.test(input.evidence.configFingerprint);
}

/** Evaluates one complete Candidate atomically; it never authorizes partial Candidate publication. */
export function evaluateAutomaticPublication(policy: CompilationPolicy, input: PublicationGateInput): PublicationGateDecision {
  if (!validInput(input)) return denied("PUBLICATION_INPUT_INVALID");
  if (!policy.publication.enabled) return denied("PUBLICATION_DISABLED");
  if (policy.mode !== "SAFE_AUTO_PUBLICATION") return denied("EXECUTION_MODE_NOT_SAFE");
  if (!policy.publication.allowedProjectIds.includes(input.projectId)) return denied("PROJECT_NOT_ALLOWLISTED");
  if (!policy.publication.allowedKinds.includes(input.kind)) return denied("KNOWLEDGE_KIND_NOT_ALLOWLISTED");
  if (!input.sourceComplete || !input.groundingComplete) return denied("SOURCE_OR_GROUNDING_INCOMPLETE");
  if (!input.deterministicScope) return denied("SCOPE_NOT_DETERMINISTIC");
  if (input.evolutionAction === "CONTRADICT" || input.evolutionAction === "PENDING") return denied("EVOLUTION_UNRESOLVED");
  if (policy.publication.requireFreshCodeEvidence && input.kind === "IMPLEMENTATION" && input.freshnessStatus !== "FRESH") {
    return denied("FRESH_CODE_EVIDENCE_REQUIRED");
  }
  if (input.protectedTarget) return denied("PROTECTED_KNOWLEDGE_TARGET");
  if (!input.expectedVersionCurrent) return denied("EXPECTED_VERSION_CHANGED");
  if (input.evidence.datasetId !== policy.publication.goldenDatasetId
    || input.evidence.datasetVersion !== policy.publication.goldenDatasetVersion
    || input.evidence.configFingerprint !== policy.publication.goldenConfigFingerprint) {
    return denied("GOLDEN_EVIDENCE_MISMATCH");
  }
  return Object.freeze({ authorized: true, executionMode: "SAFE_AUTO_PUBLICATION", reasonCode: "ALL_PUBLICATION_GATES_PASSED" });
}
