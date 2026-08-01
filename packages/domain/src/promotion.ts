import type { KnowledgeKind } from "./knowledge.js";

export interface GlobalPromotionRequest {
  readonly kind: KnowledgeKind;
  readonly verifiedProjectIds: readonly string[];
  readonly hasProjectSpecificMarkers: boolean;
  readonly userExplicitlyApprovedGlobal: boolean;
}

export type GlobalPromotionDecision =
  | {
      readonly allowed: true;
      readonly reason: "USER_EXPLICITLY_APPROVED" | "CROSS_PROJECT_VERIFIED";
    }
  | {
      readonly allowed: false;
      readonly reason:
        | "EXPLICIT_APPROVAL_REQUIRED"
        | "PROJECT_SPECIFIC_CONTENT"
        | "INSUFFICIENT_DISTINCT_PROJECTS";
    };

export function evaluateGlobalPromotion(
  request: GlobalPromotionRequest,
): GlobalPromotionDecision {
  if (request.userExplicitlyApprovedGlobal) {
    return { allowed: true, reason: "USER_EXPLICITLY_APPROVED" };
  }

  if (request.kind === "RULE" || request.kind === "PREFERENCE") {
    return { allowed: false, reason: "EXPLICIT_APPROVAL_REQUIRED" };
  }

  if (request.hasProjectSpecificMarkers) {
    return { allowed: false, reason: "PROJECT_SPECIFIC_CONTENT" };
  }

  const distinctProjects = new Set(
    request.verifiedProjectIds.map((projectId) => projectId.trim()).filter(Boolean),
  );
  if (distinctProjects.size >= 2) {
    return { allowed: true, reason: "CROSS_PROJECT_VERIFIED" };
  }

  return { allowed: false, reason: "INSUFFICIENT_DISTINCT_PROJECTS" };
}
