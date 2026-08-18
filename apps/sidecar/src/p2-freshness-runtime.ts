import type { ProjectContext } from "@zhiloop/domain";
import type { KnowledgeChangeSet } from "@zhiloop/invalidation-engine";
import { GitKnowledgeChangeSource } from "@zhiloop/knowledge-change-intake";
import {
  KnowledgeFreshnessScheduler,
  KnowledgeFreshnessWorker,
  type FreshnessBatchVerificationResult,
  type FreshnessRevalidationItem,
  type FreshnessSchedulerConfiguration,
  type FreshnessSchedulerState,
  type SqliteKnowledgeFreshnessStore,
} from "@zhiloop/knowledge-freshness";
import type {
  KnowledgeVerificationBatch,
  KnowledgeVerificationRequest,
  VerificationExecutionControls,
} from "@zhiloop/knowledge-verification";

const MAX_VERIFICATION_CONCURRENCY = 4;

export { GitKnowledgeChangeSource } from "@zhiloop/knowledge-change-intake";

interface SharedVerificationPort {
  verifyBatch(request: KnowledgeVerificationRequest, controls?: VerificationExecutionControls): Promise<KnowledgeVerificationBatch>;
}

export class ProductionFreshnessVerifier {
  readonly #projects = new Map<string, string>();

  constructor(
    private readonly verification: SharedVerificationPort,
    private readonly onVerified?: (revision: { readonly projectId: string; readonly codeRevision: string; readonly graphRevision?: string }) => void,
  ) {}
  observe(projectId: string, root: string): void { this.#projects.set(projectId, root); }

  async verifyBatch(input: {
    readonly projectId: string;
    readonly changes: KnowledgeChangeSet;
    readonly items: readonly FreshnessRevalidationItem[];
    readonly signal?: AbortSignal;
  }): Promise<FreshnessBatchVerificationResult> {
    if (input.signal?.aborted) throw new Error("FRESHNESS_REVALIDATION_ABORTED");
    const root = this.#projects.get(input.projectId);
    if (root === undefined) throw new Error("FRESHNESS_PROJECT_ROOT_UNAVAILABLE");
    const project: ProjectContext = { projectId: input.projectId, repositoryRoot: root, portable: false };
    const batches = new Array<KnowledgeVerificationBatch>(input.items.length);
    let cursor = 0;
    let failed = false;
    let failure: unknown;
    const worker = async (): Promise<void> => {
      while (!failed) {
        const index = cursor;
        cursor += 1;
        if (index >= input.items.length) return;
        const item = input.items[index]!;
        try {
          batches[index] = await this.verification.verifyBatch({
            candidate: item.candidate, project, requestedAt: input.changes.observedAt, purpose: "FRESHNESS",
            assertionIds: item.assertionIds, expectedCodeRevision: input.changes.sourceRef,
            knowledgeVersion: { assetId: item.assetId, assetVersion: item.assetVersion },
          }, { ...(input.signal === undefined ? {} : { signal: input.signal }) });
        } catch (error) {
          failed = true;
          failure = error;
        }
        if (input.signal?.aborted) {
          failed = true;
          failure = new Error("FRESHNESS_REVALIDATION_ABORTED");
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(MAX_VERIFICATION_CONCURRENCY, input.items.length) },
      async () => worker(),
    ));
    if (failed) throw failure;

    const results: Record<string, FreshnessBatchVerificationResult["results"][string]> = {};
    const runIds: Record<string, string> = {};
    let graphRevision: string | undefined;
    for (const [index, item] of input.items.entries()) {
      const batch = batches[index]!;
      if (batch.codeRevision !== input.changes.sourceRef) throw new Error("FRESHNESS_VERIFICATION_REVISION_MISMATCH");
      if (batch.graphRevision !== undefined) {
        if (graphRevision !== undefined && graphRevision !== batch.graphRevision) throw new Error("FRESHNESS_GRAPH_REVISION_MIXED");
        graphRevision = batch.graphRevision;
      }
      results[item.assetId] = batch.results;
      runIds[item.assetId] = batch.runId;
    }
    const verified = Object.freeze({
      projectId: input.projectId, codeRevision: input.changes.sourceRef,
      ...(graphRevision === undefined ? {} : { graphRevision }),
      observedAt: input.changes.observedAt, runIds: Object.freeze(runIds), results: Object.freeze(results),
    });
    this.onVerified?.({ projectId: input.projectId, codeRevision: input.changes.sourceRef,
      ...(graphRevision === undefined ? {} : { graphRevision }) });
    return verified;
  }
}

export class P2FreshnessRuntime {
  readonly #source: GitKnowledgeChangeSource;
  readonly #verifier: ProductionFreshnessVerifier;
  readonly #scheduler: KnowledgeFreshnessScheduler;

  constructor(options: {
    readonly statePath: string;
    readonly store: SqliteKnowledgeFreshnessStore;
    readonly configuration: FreshnessSchedulerConfiguration;
    readonly verification: SharedVerificationPort;
    readonly onState?: (state: FreshnessSchedulerState) => void;
  }) {
    this.#source = new GitKnowledgeChangeSource(options.statePath);
    this.#verifier = new ProductionFreshnessVerifier(options.verification);
    const worker = new KnowledgeFreshnessWorker(options.store, this.#verifier);
    this.#scheduler = new KnowledgeFreshnessScheduler(worker, options.configuration, {
      source: this.#source,
      onResult: () => options.onState?.(this.#scheduler.state()),
      onError: () => options.onState?.(this.#scheduler.state()),
    });
  }

  observeProject(projectId: string, projectRoot: string): void {
    this.#source.observe(projectId, projectRoot);
    this.#verifier.observe(projectId, projectRoot);
    void this.#scheduler.flush().catch(() => undefined);
  }
  start(): boolean { return this.#scheduler.start(); }
  trigger(): Promise<void> { return this.#scheduler.flush(); }
  state(): FreshnessSchedulerState { return this.#scheduler.state(); }
  applyConfiguration(configuration: FreshnessSchedulerConfiguration): Promise<() => Promise<void>> { return this.#scheduler.applyConfiguration(configuration); }
  async close(): Promise<void> { await this.#scheduler.close(); this.#source.close(); }
}
