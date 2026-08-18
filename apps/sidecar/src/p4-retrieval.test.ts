import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { KnowledgeAsset } from "@zhiloop/domain";
import type { ProjectedKnowledgeAsset } from "@zhiloop/knowledge-registry";
import type { RegistryProjectionReadPort } from "@zhiloop/p3-console-runtime";
import type { ProjectIdentityResolution } from "@zhiloop/project-identity";
import { resolveQueryContext } from "@zhiloop/query-context";
import { describe, expect, it, vi } from "vitest";

import {
  P4RegistryRetrievalComposition,
  createP4RetrievalComposition,
  type P4ProjectIdentityResolver,
} from "./p4-retrieval.js";

const now = "2026-08-04T00:00:00.000Z";

function asset(overrides: Partial<KnowledgeAsset> = {}): KnowledgeAsset {
  return {
    schemaVersion: 1,
    id: "knowledge-current",
    subjectKey: "symbol.runtime.beacon",
    kind: "IMPLEMENTATION",
    scope: { level: "PROJECT", projectId: "project-a" },
    version: 1,
    status: "IMPLEMENTED",
    title: "RuntimeBeacon",
    summary: "Deterministic runtime retrieval.",
    body: "RuntimeBeacon is retrieved from the current registry projection.",
    aliases: [],
    keywords: ["RuntimeBeacon"],
    applicability: ["project-a"],
    nonApplicability: [],
    symbols: ["RuntimeBeacon"],
    relations: [],
    evidence: [{ evidenceId: "evidence-1", verdict: "SUPPORTS" }],
    confidence: 0.9,
    sourceEpisodes: ["episode-1"],
    contentHash: "sha256:current-v1",
    correlationId: "correlation-1",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function projected(value: KnowledgeAsset, indexVersion = 1): ProjectedKnowledgeAsset {
  return { asset: value, tombstone: false, indexVersion };
}

function projection(options: {
  readonly listed?: readonly ProjectedKnowledgeAsset[];
  readonly searched?: readonly ProjectedKnowledgeAsset[];
  readonly current?: ReadonlyMap<string, ProjectedKnowledgeAsset>;
} = {}): RegistryProjectionReadPort {
  const listed = options.listed ?? [];
  const searched = options.searched ?? listed;
  const current = options.current ?? new Map(listed.map((item) => [item.asset.id, item]));
  return {
    listAssets: ({ offset = 0 } = {}) => offset === 0 ? listed : [],
    getAsset: (assetId) => current.get(assetId),
    search: (_query, { limit = 20 } = {}) => searched.slice(0, limit).map((item, index) => ({
      asset: item.asset,
      rank: index + 1,
      score: 1 / (index + 1),
      indexVersion: item.indexVersion,
    })),
    getRelations: (assetId, version) => ({
      assetId,
      assetVersion: version,
      relations: current.get(assetId)?.asset.relations ?? [],
    }),
  };
}

function resolution(cwd: string, projectId = "project-a"): ProjectIdentityResolution {
  return Object.freeze({
    context: Object.freeze({ projectId, repositoryRoot: cwd, branch: "main", portable: false }),
    source: "FILESYSTEM_LOCAL" as const,
    rootMarker: "package.json",
    reasonCodes: ["NO_GIT_REPOSITORY", "FILESYSTEM_ROOT_MARKER"],
  });
}

function hook(cwd = "/workspace/project-a") {
  return {
    hook_event_name: "UserPromptSubmit" as const,
    session_id: "session-1",
    turn_id: "turn-1",
    cwd,
    prompt: "How does `RuntimeBeacon` work?",
  };
}

describe("P4RegistryRetrievalComposition", () => {
  it("shares a successful project cache and rebuilds MCP scope from cwd instead of forged boundaries", async () => {
    const resolver = vi.fn<P4ProjectIdentityResolver>(async (cwd) => resolution(cwd));
    const composition = createP4RetrievalComposition({ projection: projection(), projectResolver: resolver });

    await expect(composition.authority.scopeForHook(hook())).resolves.toEqual({
      sessionId: "session-1", turnId: "turn-1", projectId: "project-a", taskId: "turn-1",
      worktree: "/workspace/project-a", branch: "main",
    });
    const forgedBase = resolveQueryContext({
      prompt: "inspect `RuntimeBeacon`",
      project: { projectId: "project-forged", repositoryRoot: "/workspace/forged", portable: false },
      cwd: "/workspace/forged",
      taskId: "task-forged",
    });
    const authorized = await composition.authority.authorizeMcp({
      ...forgedBase,
      cwd: "/workspace/project-a",
      retrievalBoundary: {
        allowProjectKnowledge: true,
        allowGlobalKnowledge: false,
        projectId: "project-forged",
        taskId: "task-forged",
      },
    }, new AbortController().signal);
    expect(authorized).toMatchObject({
      cwd: "/workspace/project-a",
      project: { projectId: "project-a" },
      retrievalBoundary: { allowProjectKnowledge: true, allowGlobalKnowledge: true, projectId: "project-a" },
    });
    expect(authorized).not.toHaveProperty("taskId");

    await composition.retrieval.retrieve({
      sessionId: "session-1", turnId: "turn-1", cwd: "/workspace/project-a", prompt: "RuntimeBeacon",
    }, new AbortController().signal);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("uses deterministic identities, DEFAULT retrieval and non-model rerank without automatic L4", async () => {
    const value = projected(asset());
    const runtime = new P4RegistryRetrievalComposition({
      projection: projection({ listed: [value] }),
      projectResolver: async (cwd) => resolution(cwd),
    });
    const request = {
      sessionId: "session-1", turnId: "turn-1", cwd: "/workspace/project-a", prompt: "Explain `RuntimeBeacon`",
    };
    const first = await runtime.retrieve(request, new AbortController().signal);
    const second = await runtime.retrieve(request, new AbortController().signal);
    const changed = await runtime.retrieve({ ...request, prompt: "Change `RuntimeBeacon`" }, new AbortController().signal);

    expect(second.runId).toBe(first.runId);
    expect(second.traceId).toBe(first.traceId);
    expect(changed.runId).not.toBe(first.runId);
    expect(changed.traceId).not.toBe(first.traceId);
    expect(first.candidates).toHaveLength(1);
    expect(first.candidates[0]).toMatchObject({ asset: { id: "knowledge-current" }, rerank: { applied: false } });
    expect(first.rerank.diagnostics).toContainEqual(expect.objectContaining({ code: "UNAVAILABLE" }));
    expect(first).not.toHaveProperty("requestedLevel");
  });

  it("keeps only current eligible in-scope assets", async () => {
    const accepted = projected(asset());
    const rejected = projected(asset({ id: "knowledge-rejected", subjectKey: "symbol.runtime.rejected", status: "REJECTED" }));
    const otherProject = projected(asset({
      id: "knowledge-other", subjectKey: "symbol.runtime.other", scope: { level: "PROJECT", projectId: "project-other" },
    }));
    const runtime = new P4RegistryRetrievalComposition({
      projection: projection({ listed: [accepted, rejected, otherProject] }),
      projectResolver: async (cwd) => resolution(cwd),
    });
    const result = await runtime.retrieve({
      sessionId: "session-1", turnId: "turn-1", cwd: "/workspace/project-a", prompt: "Use `RuntimeBeacon`",
    }, new AbortController().signal);
    expect(result.candidates.map((item) => item.asset.id)).toEqual(["knowledge-current"]);
  });

  it("rejects stale channel hits when the registry current version changed", async () => {
    const stale = projected(asset({ version: 1, contentHash: "sha256:stale-v1" }), 1);
    const current = projected(asset({ version: 2, contentHash: "sha256:current-v2" }), 2);
    const runtime = new P4RegistryRetrievalComposition({
      projection: projection({ searched: [stale], current: new Map([[current.asset.id, current]]) }),
      projectResolver: async (cwd) => resolution(cwd),
    });
    const result = await runtime.retrieve({
      sessionId: "session-1", turnId: "turn-1", cwd: "/workspace/project-a", prompt: "RuntimeBeacon stale check",
    }, new AbortController().signal);
    expect(result.candidates).toEqual([]);
    expect(result.retrieval.diagnostics).toContainEqual(expect.objectContaining({
      code: "STALE_SOURCE_HIT", assetId: "knowledge-current",
    }));
  });

  it("fails closed for abort, resolver errors and a nonexistent cwd", async () => {
    let release: ((value: ProjectIdentityResolution) => void) | undefined;
    const waiting = new Promise<ProjectIdentityResolution>((resolve) => { release = resolve; });
    const runtime = new P4RegistryRetrievalComposition({
      projection: projection(),
      projectResolver: async () => await waiting,
    });
    const controller = new AbortController();
    const pending = runtime.retrieve({
      sessionId: "session-1", turnId: "turn-1", cwd: "/workspace/project-a", prompt: "RuntimeBeacon",
    }, controller.signal);
    controller.abort(new Error("host cancelled"));
    await expect(pending).rejects.toThrow("host cancelled");
    release?.(resolution("/workspace/project-a"));

    const failedResolver = vi.fn<P4ProjectIdentityResolver>(async () => { throw new Error("identity unavailable"); });
    const failed = new P4RegistryRetrievalComposition({ projection: projection(), projectResolver: failedResolver });
    await expect(failed.scopeForHook(hook())).rejects.toThrow("identity unavailable");
    await expect(failed.scopeForHook(hook())).rejects.toThrow("identity unavailable");
    expect(failedResolver).toHaveBeenCalledTimes(2);

    const missing = mkdtempSync(path.join(tmpdir(), "zhiloop-p4-missing-"));
    rmSync(missing, { recursive: true });
    const production = new P4RegistryRetrievalComposition({ projection: projection() });
    await expect(production.scopeForHook(hook(missing))).rejects.toThrow();

    const guarded = new P4RegistryRetrievalComposition({
      projection: projection(), projectResolver: async (cwd) => resolution(cwd),
    });
    await expect(guarded.scopeForHook(hook("relative/project"))).rejects.toThrow("absolute existing directory");
    await expect(guarded.scopeForHook({ ...hook(), session_id: "bad\nsession" })).rejects.toThrow("identity is invalid");
    const noCwd = resolveQueryContext({ prompt: "RuntimeBeacon" });
    await expect(guarded.authorizeMcp(noCwd, new AbortController().signal)).rejects.toThrow("MCP cwd is required");
    const preAborted = new AbortController();
    preAborted.abort("cancelled");
    await expect(guarded.authorizeMcp({ ...noCwd, cwd: "/workspace/project-a" }, preAborted.signal))
      .rejects.toThrow("P4 retrieval was aborted");
  });
});
