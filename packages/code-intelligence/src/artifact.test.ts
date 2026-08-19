import { describe, expect, it } from "vitest";

import { buildCodeGraphArtifact } from "./artifact.js";

describe("buildCodeGraphArtifact", () => {
  it("binds an artifact to authoritative revisions and canonical bounded facts", () => {
    const facts = Array.from({ length: 55 }, (_, index) => ({
      kind: "SYMBOL" as const,
      symbol: `Symbol${String(54 - index).padStart(2, "0")}`,
      path: `src/${index}.ts`,
      startLine: index + 1,
    }));
    const value = buildCodeGraphArtifact({
      project: { projectId: "project-a", branch: "main",
        revision: { commit: "abcdef1234567", dirty: false }, portable: true },
      projectFingerprint: "fallback-fingerprint", dependencyFingerprint: "deps-1",
      capability: { provider: "CODEGRAPH", status: "READY", reasonCode: "READY", indexRevision: "graph-1" },
      operation: "SYMBOL", query: "Symbol", facts, bounded: false, sourceRef: "codegraph:test",
      observedAt: "2026-08-20T00:00:00.000Z", reasonCodes: ["READY", "READY", "BOUNDED"],
    });
    expect(value).toMatchObject({ codeRevision: "abcdef1234567", graphRevision: "graph-1",
      dependencyFingerprint: "deps-1", bounded: true, status: "ACTIVE", reasonCodes: ["BOUNDED", "READY"] });
    expect(value.facts).toHaveLength(50);
    expect(value.facts[0]).toMatchObject({ symbol: "Symbol54" });
    expect(value.contentHash).toMatch(/^cg_[a-f0-9]{32}$/u);
    expect(Object.isFrozen(value)).toBe(true);
  });

  it("uses a project fingerprint and explicit bounded flag when revisions are unavailable", () => {
    const value = buildCodeGraphArtifact({
      project: { projectId: "project-local", portable: false }, projectFingerprint: "fingerprint-local",
      capability: { provider: "CODEGRAPH", status: "UNAVAILABLE", reasonCode: "NO_INDEX" },
      operation: "CALL_PATH", query: "A->B",
      facts: [{ kind: "CALL_PATH", from: "A", to: "B", symbols: ["A", "B"], paths: ["src/a.ts"] }],
      bounded: undefined, sourceRef: "codegraph:fallback", observedAt: "2026-08-20T00:00:00.000Z",
      reasonCodes: ["NO_INDEX"],
    });
    expect(value).toMatchObject({ codeRevision: "fingerprint-local", bounded: false });
    expect(value).not.toHaveProperty("graphRevision");
    expect(value).not.toHaveProperty("dependencyFingerprint");
  });
});
