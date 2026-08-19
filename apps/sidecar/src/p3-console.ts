import { createHash } from "node:crypto";
import { join } from "node:path";

import { DEFAULT_CONFIGURATION, type InjectionPolicy } from "@zhiloop/config";
import type { ConfigurationDraft, ConfigurationView } from "@zhiloop/configuration-service";
import type { SqliteKnowledgeRegistryProjection } from "@zhiloop/knowledge-registry";
import type { CodexKnowledgeQueryModel } from "@zhiloop/model-codex-exec";
import { resolveProjectIdentity } from "@zhiloop/project-identity";
import type { ProjectContext } from "@zhiloop/domain";
import {
  ExplicitP3PolicyResolver,
  P3ConsoleRuntime,
  SqliteP3ConsoleOperationStore,
  type ExplicitP3PolicyRevision,
  type P3ConsoleTransportRequest,
} from "@zhiloop/p3-console-runtime";
import { fingerprintConsoleRetrievalPolicy, SqliteRetrievalTraceStore } from "@zhiloop/retrieval-query-service";

export interface P3SidecarConsoleOptions {
  readonly stateDirectory: string;
  readonly registry: SqliteKnowledgeRegistryProjection;
  readonly configuration: (projectId?: string) => ConfigurationView;
  readonly drafts: () => readonly ConfigurationDraft[];
  readonly model?: CodexKnowledgeQueryModel;
  readonly resolveProject?: (root: string) => Promise<ProjectContext>;
  readonly clock?: () => Date;
}

export interface P3SidecarCapabilityState {
  readonly retrieval: {
    readonly state: "READY";
    readonly reasonCode: "COMPONENT_READY";
    readonly evidenceRefs: readonly string[];
  };
  readonly codexQuery: {
    readonly state: "READY" | "NOT_CONFIGURED";
    readonly reasonCode: "COMPONENT_READY" | "CAPABILITY_NOT_CONFIGURED";
    readonly evidenceRefs: readonly string[];
  };
}

function configurationIdentity(configuration: ConfigurationDraft["configuration"]): string {
  return createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
}

function injectionPolicy(configuration: ConfigurationView): InjectionPolicy {
  return Object.freeze({
    ...structuredClone(DEFAULT_CONFIGURATION.injection),
    defaultMaxTokens: Math.min(4_000, configuration.effective.future.injectionMaxTokens),
  });
}

function policyRevision(
  source: "CURRENT" | "DRAFT",
  revision: number,
  configurationHash: string,
  injection: InjectionPolicy,
  capability: P3SidecarCapabilityState,
): ExplicitP3PolicyRevision {
  const fingerprint = fingerprintConsoleRetrievalPolicy(DEFAULT_CONFIGURATION.retrieval, injection);
  return Object.freeze({
    reference: Object.freeze({
      policyId: `sidecar-${source.toLowerCase()}-${configurationHash.slice(0, 24)}`,
      revision: Math.max(1, revision),
      fingerprint,
      source,
    }),
    retrieval: structuredClone(DEFAULT_CONFIGURATION.retrieval),
    injection,
    consumers: Object.freeze({
      RETRIEVAL: Object.freeze({
        state: capability.retrieval.state,
        reasonCode: capability.retrieval.reasonCode,
        evidenceRefs: capability.retrieval.evidenceRefs,
      }),
      CODEX_QUERY: Object.freeze({
        state: capability.codexQuery.state,
        reasonCode: capability.codexQuery.reasonCode,
        evidenceRefs: capability.codexQuery.evidenceRefs,
      }),
    }),
  });
}

export class P3SidecarConsole {
  readonly #traces: SqliteRetrievalTraceStore;
  readonly #operations: SqliteP3ConsoleOperationStore;
  readonly capability: P3SidecarCapabilityState;
  #closed = false;

  constructor(private readonly options: P3SidecarConsoleOptions) {
    this.#traces = new SqliteRetrievalTraceStore(join(options.stateDirectory, "p3-retrieval-traces.sqlite"));
    this.#operations = new SqliteP3ConsoleOperationStore(join(options.stateDirectory, "p3-console-operations.sqlite"));
    const registryEvidence = `registry-index:${options.registry.activeIndexVersion}`;
    this.capability = Object.freeze({
      retrieval: Object.freeze({
        state: "READY" as const,
        reasonCode: "COMPONENT_READY" as const,
        evidenceRefs: Object.freeze([registryEvidence, "composition:p3-console-runtime"]),
      }),
      codexQuery: options.model === undefined
        ? Object.freeze({
          state: "NOT_CONFIGURED" as const,
          reasonCode: "CAPABILITY_NOT_CONFIGURED" as const,
          evidenceRefs: Object.freeze(["configuration:codex-query-disabled"]),
        })
        : Object.freeze({
          state: "READY" as const,
          reasonCode: "COMPONENT_READY" as const,
          evidenceRefs: Object.freeze(["composition:codex-knowledge-query-model"]),
        }),
    });
  }

  #runtime(projectId?: string): {
    readonly runtime: P3ConsoleRuntime;
    readonly current: ExplicitP3PolicyRevision;
    readonly draft?: ExplicitP3PolicyRevision;
  } {
    if (this.#closed) throw new Error("P3 Sidecar Console is closed");
    const currentConfiguration = this.options.configuration(projectId);
    const current = policyRevision(
      "CURRENT",
      currentConfiguration.revision + 1,
      currentConfiguration.hash,
      injectionPolicy(currentConfiguration),
      this.capability,
    );
    const draftConfiguration = [...this.options.drafts()]
      .filter((value) => value.scope === "GLOBAL" || value.projectId === projectId)
      .sort((left, right) => {
        const scopePriority = Number(right.projectId === projectId) - Number(left.projectId === projectId);
        return scopePriority !== 0 ? scopePriority : right.draftRevision - left.draftRevision;
      })[0];
    const draft = draftConfiguration === undefined ? undefined : policyRevision(
      "DRAFT",
      draftConfiguration.draftRevision,
      configurationIdentity(draftConfiguration.configuration),
      injectionPolicy({ ...currentConfiguration, effective: draftConfiguration.configuration }),
      this.capability,
    );
    const policies = new ExplicitP3PolicyResolver([current, ...(draft === undefined ? [] : [draft])]);
    const resolveProject = async (input: {
      readonly projectId?: string | undefined;
      readonly repositoryRoot?: string | undefined;
      readonly cwd?: string | undefined;
    }): Promise<ProjectContext | undefined> => {
      const root = input.cwd ?? input.repositoryRoot;
      if (root === undefined) {
        return input.projectId === undefined ? undefined : { projectId: input.projectId, portable: true };
      }
      const context = this.options.resolveProject === undefined
        ? (await resolveProjectIdentity(root)).context
        : await this.options.resolveProject(root);
      if (input.projectId !== undefined && input.projectId !== context.projectId) {
        throw new Error("P3_PROJECT_IDENTITY_MISMATCH");
      }
      return context;
    };
    return {
      runtime: new P3ConsoleRuntime({
        projection: this.options.registry,
        policies,
        traces: this.#traces,
        operations: this.#operations,
        resolveProject,
        ...(this.options.model === undefined ? {} : { model: this.options.model }),
        ...(this.options.clock === undefined ? {} : { now: this.options.clock }),
      }),
      current,
      ...(draft === undefined ? {} : { draft }),
    };
  }

  async handle(request: P3ConsoleTransportRequest, signal?: AbortSignal): Promise<unknown> {
    const composed = this.#runtime(request.projectId);
    const timeoutMs = request.type === "p3.retrieval.trace"
      ? undefined
      : request.timeoutMs ?? this.options.configuration(request.projectId).effective.future.codexQueryTimeoutMs;
    const abortOptions = signal === undefined ? {} : { signal };
    switch (request.type) {
      case "p3.knowledge.search":
        return await composed.runtime.search({
          ...request,
          type: "knowledge.search",
          mode: "SEARCH_ONLY",
          policy: composed.current.reference,
          timeoutMs,
        }, abortOptions);
      case "p3.knowledge.ask":
        return await composed.runtime.ask({
          ...request,
          type: "knowledge.ask",
          mode: "CODEX_ASSISTED",
          policy: composed.current.reference,
          timeoutMs,
        }, abortOptions);
      case "p3.retrieval.simulate":
        return await composed.runtime.simulate({
          ...request,
          type: "retrieval.simulate",
          currentPolicy: composed.current.reference,
          ...(composed.draft === undefined ? {} : { draftPolicy: composed.draft.reference }),
          timeoutMs,
        }, abortOptions);
      case "p3.retrieval.trace":
        return composed.runtime.trace({
          schemaVersion: 1,
          type: "retrieval.trace",
          traceId: request.traceId,
          ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
          ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        });
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#operations.close();
    this.#traces.close();
    this.#closed = true;
  }
}
