import { createHash } from "node:crypto";
import path from "node:path";

import type { ActiveKnowledgeRetrievalPort, ActiveKnowledgeRetrievalResult } from "@zhiloop/active-knowledge-runtime";
import { DEFAULT_CONFIGURATION } from "@zhiloop/config";
import type { ProjectContext } from "@zhiloop/domain";
import { KnowledgeReranker } from "@zhiloop/knowledge-reranker";
import {
  SqliteRegistryKnowledgeRetrievalSource,
  type RegistryProjectionReadPort,
} from "@zhiloop/p3-console-runtime";
import {
  resolveProjectIdentity,
  type ProjectIdentityResolution,
} from "@zhiloop/project-identity";
import { resolveQueryContext, type QueryContext } from "@zhiloop/query-context";
import { MultiChannelRetrievalEngine } from "@zhiloop/retrieval-engine";

import type { P4AuthoritativeContextPort } from "./p4-active-runtime.js";

const SAFE_HOST_ID = /^[^\0\r\n]{1,500}$/u;

export type P4ProjectIdentityResolver = (cwd: string) => Promise<ProjectIdentityResolution>;

export interface P4RetrievalCompositionDependencies {
  readonly projection: RegistryProjectionReadPort;
  /** Test seam only; production uses the filesystem/Git-backed resolver. */
  readonly projectResolver?: P4ProjectIdentityResolver;
}

export interface P4RetrievalComposition {
  readonly authority: P4AuthoritativeContextPort;
  readonly retrieval: ActiveKnowledgeRetrievalPort;
}

function digest(prefix: string, value: unknown): string {
  return `${prefix}-${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32)}`;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("P4 retrieval was aborted");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)).catch(() => undefined);
  });
}

function canonicalCwd(cwd: string): string {
  if (typeof cwd !== "string" || cwd.trim().length === 0 || cwd.includes("\0") || !path.isAbsolute(cwd)) {
    throw new Error("authoritative cwd must be an absolute existing directory");
  }
  return path.normalize(cwd);
}

function assertHostIdentity(sessionId: string, turnId: string): void {
  if (!SAFE_HOST_ID.test(sessionId) || !SAFE_HOST_ID.test(turnId)) {
    throw new Error("authoritative Hook session or turn identity is invalid");
  }
}

/**
 * Production authority and retrieval composition. The same instance is deliberately
 * shared by Hook and MCP so all consumers use one filesystem-derived project cache.
 */
export class P4RegistryRetrievalComposition implements P4AuthoritativeContextPort, ActiveKnowledgeRetrievalPort {
  readonly #projection: RegistryProjectionReadPort;
  readonly #resolver: P4ProjectIdentityResolver;
  readonly #projects = new Map<string, Promise<ProjectContext>>();

  constructor(dependencies: P4RetrievalCompositionDependencies) {
    this.#projection = dependencies.projection;
    this.#resolver = dependencies.projectResolver ?? resolveProjectIdentity;
  }

  async scopeForHook(input: Parameters<P4AuthoritativeContextPort["scopeForHook"]>[0]) {
    assertHostIdentity(input.session_id, input.turn_id);
    const project = await this.#project(input.cwd);
    return Object.freeze({
      sessionId: input.session_id,
      turnId: input.turn_id,
      projectId: project.projectId,
      taskId: input.turn_id,
      worktree: project.repositoryRoot ?? canonicalCwd(input.cwd),
      branch: project.branch ?? "UNKNOWN",
    });
  }

  async authorizeMcp(requested: QueryContext, signal: AbortSignal): Promise<QueryContext> {
    throwIfAborted(signal);
    if (requested.cwd === undefined) throw new Error("authoritative MCP cwd is required");
    const project = await this.#project(requested.cwd, signal);
    throwIfAborted(signal);
    // project, task and retrievalBoundary are intentionally not copied from the model request.
    return resolveQueryContext({ prompt: requested.prompt, cwd: requested.cwd, project });
  }

  async retrieve(
    request: Parameters<ActiveKnowledgeRetrievalPort["retrieve"]>[0],
    signal: AbortSignal,
  ): Promise<ActiveKnowledgeRetrievalResult> {
    throwIfAborted(signal);
    assertHostIdentity(request.sessionId, request.turnId);
    const project = await this.#project(request.cwd, signal);
    throwIfAborted(signal);
    const queryContext = resolveQueryContext({
      prompt: request.prompt,
      cwd: request.cwd,
      project,
      taskId: request.turnId,
    });
    const source = new SqliteRegistryKnowledgeRetrievalSource(this.#projection, {
      projectId: project.projectId,
      taskId: request.turnId,
      allowGlobalKnowledge: true,
    });
    const policy = structuredClone(DEFAULT_CONFIGURATION.retrieval);
    const retrieval = await new MultiChannelRetrievalEngine(source, undefined, {
      channels: { vector: false },
    }).retrieve({ context: queryContext, policy });
    throwIfAborted(signal);
    // No model port is supplied: ordering is deterministic RRF fallback only.
    const fullRerank = await new KnowledgeReranker().rerank(queryContext, retrieval.items);
    throwIfAborted(signal);
    const items = Object.freeze(fullRerank.items.slice(0, policy.output.maxItems)
      .map((item, index) => Object.freeze({ ...item, rank: index + 1 })));
    const rerank = Object.freeze({ ...fullRerank, items });
    const identity = [
      request.sessionId,
      request.turnId,
      project.projectId,
      request.prompt,
      policy,
    ] as const;
    return Object.freeze({
      runId: digest("run-p4-retrieval", identity),
      traceId: digest("trace-p4-retrieval", identity),
      queryContext,
      retrieval,
      rerank,
      candidates: items,
    });
  }

  async #project(cwd: string, signal?: AbortSignal): Promise<ProjectContext> {
    const key = canonicalCwd(cwd);
    let pending = this.#projects.get(key);
    if (pending === undefined) {
      pending = this.#resolver(key).then((resolution) => resolution.context);
      this.#projects.set(key, pending);
      void pending.catch(() => {
        if (this.#projects.get(key) === pending) this.#projects.delete(key);
      });
    }
    return signal === undefined ? await pending : await abortable(pending, signal);
  }
}

export function createP4RetrievalComposition(
  dependencies: P4RetrievalCompositionDependencies,
): P4RetrievalComposition {
  const runtime = new P4RegistryRetrievalComposition(dependencies);
  return Object.freeze({ authority: runtime, retrieval: runtime });
}
