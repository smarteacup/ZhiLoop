import type { CrossProjectAssertion, ProbeContext, VerificationObservation, VerificationProbe } from "@zhiloop/evidence-engine";

import type { CrossProjectProbeDependencies } from "./types.js";

export function createCurrentCrossProjectProbe(
  dependencies: CrossProjectProbeDependencies,
  currentProjectId: string,
): VerificationProbe<CrossProjectAssertion> {
  return Object.freeze({
    observe: async (assertion: CrossProjectAssertion, context: ProbeContext): Promise<VerificationObservation> => {
      const target = `cross-project:${assertion.parameters.subjectKey}:${assertion.parameters.minimumProjects}`;
      let proofs;
      try { proofs = dependencies.store.listSupportingProofs(assertion.parameters.subjectKey, 1_000); }
      catch {
        return { status: "UNKNOWN", sourceRef: `verification-store:${assertion.parameters.subjectKey}`,
          observedAt: context.requestedAt, target, reasonCode: "CROSS_PROJECT_STORE_UNAVAILABLE" };
      }
      const current = new Set<string>();
      let unknown = false;
      for (const proof of proofs) {
        let status;
        try { status = await dependencies.eligibility.classify(proof); }
        catch { unknown = true; continue; }
        if (status === "CURRENT") current.add(proof.canonicalProjectId);
        else if (status === "UNKNOWN") unknown = true;
      }
      const count = current.size;
      const sourceRef = `verification-store:${assertion.parameters.subjectKey}:projects:${count}:current:${current.has(currentProjectId) ? "yes" : "no"}`;
      if (count >= assertion.parameters.minimumProjects) return { status: "SUPPORTED", sourceRef,
        observedAt: context.requestedAt, target, reasonCode: "CROSS_PROJECT_CURRENT_PROOF_SUFFICIENT", details: { projectCount: count } };
      if (unknown) return { status: "UNKNOWN", sourceRef, observedAt: context.requestedAt, target,
        reasonCode: "CROSS_PROJECT_ELIGIBILITY_UNKNOWN", details: { projectCount: count } };
      return { status: "REFUTED", sourceRef, observedAt: context.requestedAt, target,
        reasonCode: "CROSS_PROJECT_CURRENT_PROOF_INSUFFICIENT", details: { projectCount: count } };
    },
  });
}
