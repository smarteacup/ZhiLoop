import type { ConsoleApi } from "../../api/client.js";

export const observedAt = "2026-08-19T02:00:00.000Z";

export function testApi(overrides: Partial<ConsoleApi>): ConsoleApi {
  return {
    overview: async () => { throw new Error("unused"); }, capabilities: async () => ({ items: [] }), sessions: async () => ({ items: [] }),
    session: async () => { throw new Error("unused"); }, events: async () => ({ items: [] }), jobs: async () => ({ items: [] }),
    diagnostics: async () => { throw new Error("unused"); }, previewCapture: async () => { throw new Error("unused"); },
    commitCapture: async () => { throw new Error("unused"); }, ...overrides,
  };
}

export const codeGraphPage = {
  revision: 0, bounded: false, observedAt,
  items: [{ schemaVersion: 1 as const, projectId: "project-1", repositoryIdentity: "a".repeat(64), repositoryRootLabel: "repo · …/workspace/repo",
    status: "NOT_CONFIGURED" as const, reasonCode: "CODEGRAPH_NOT_INITIALIZED", revision: 0, providerVersion: "0.9.3", evidenceRefs: [], observedAt }],
};
