import { createHash } from "node:crypto";

import type { CreateKnowledgeRepairDraftInput } from "./types.js";

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
}

export function repairDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function knowledgeRepairDraftId(input: Pick<CreateKnowledgeRepairDraftInput, "projectId" | "sourceKnowledge" | "conflict">): string {
  return `repair_${repairDigest(["knowledge-repair-draft-v1", input.projectId, input.sourceKnowledge.assetId,
    input.sourceKnowledge.assetVersion, input.sourceKnowledge.contentHash, input.conflict.runId])}`;
}
