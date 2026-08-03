import type { ContextEnvelope } from "@zhiloop/domain";
import { describe, expect, it } from "vitest";

import { parseContextEnvelope, schemas } from "./index.js";

const pointerEnvelope = {
  schemaVersion: 1,
  runId: "run-schema-context",
  projectId: "project-a",
  complexity: {
    level: "L1_POINTER",
    breadth: 1,
    depth: "POINTER",
    authority: "REFERENCE",
    evidence: "NONE",
    reasonCodes: ["REQUESTED_COMPLEXITY_LEVEL"],
  },
  budget: { maxTokens: 800, estimatedTokens: 120, truncated: false, disclosedItems: 1, omittedItems: 0 },
  items: [{
    id: "knowledge.context.pointer",
    version: 1,
    subjectKey: "knowledge.context.pointer",
    kind: "IMPLEMENTATION",
    status: "IMPLEMENTED",
    scope: { level: "PROJECT", projectId: "project-a" },
    authority: "REFERENCE",
    detailLevel: "L1_POINTER",
    title: "Pointer",
    summary: "One sentence summary.",
    retrievalRank: 1,
  }],
} satisfies ContextEnvelope;

describe("ContextEnvelope schema", () => {
  it("accepts a pointer envelope and preserves top-level extensions", () => {
    const result = parseContextEnvelope({ ...pointerEnvelope, futureField: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(pointerEnvelope);
      expect(result.extensions).toEqual({ futureField: true });
    }
  });

  it("rejects unsupported versions and detail fields forbidden at L1", () => {
    expect(parseContextEnvelope({ ...pointerEnvelope, schemaVersion: 2 })).toMatchObject({
      ok: false, error: { code: "UNSUPPORTED_SCHEMA_VERSION", schema: "context-envelope" },
    });
    expect(parseContextEnvelope({
      ...pointerEnvelope,
      items: [{ ...pointerEnvelope.items[0], content: "L1 must not contain body" }],
    }).ok).toBe(false);
  });

  it("requires L3 boundaries, failure paths, content, and evidence summary", () => {
    const base = {
      ...pointerEnvelope,
      complexity: { ...pointerEnvelope.complexity, level: "L3_EVIDENCED", depth: "EVIDENCED", evidence: "SUMMARY" },
      items: [{
        ...pointerEnvelope.items[0], detailLevel: "L3_EVIDENCED",
        applicability: ["project-a"], failurePaths: ["outside project-a"], symbols: ["ContextEnvelope"],
        content: "Evidence-backed content.", evidenceSummary: [{ evidenceId: "evidence-1", verdict: "SUPPORTS" }],
      }],
    };
    expect(parseContextEnvelope(base).ok).toBe(true);
    const withoutFailureItem: Partial<(typeof base.items)[number]> = structuredClone(base.items[0]!);
    delete withoutFailureItem.failurePaths;
    const withoutFailure = {
      ...base,
      items: [withoutFailureItem],
    };
    expect(parseContextEnvelope(withoutFailure).ok).toBe(false);
  });

  it("registers the versioned JSON schema", () => {
    expect(schemas["context-envelope"].$id).toBe("https://zhiloop.dev/schemas/context-envelope/v1");
  });
});
