## Context

The current production composition already has three important pieces: `SqliteDurableJobStore`/`DurableJobWorker`, an immutable P2 Knowledge Worker checkpoint, and `GitKnowledgeChangeSource` plus `FreshnessScheduler`/`FreshnessWorker`. The gap is orchestration. Freshness work is held in an in-memory pending map and timer; the Git adapter keeps its pending acknowledgement only in memory; affected assets are bounded without a durable page cursor; and the injection path uses a synchronous projection-only filter. A restart can therefore delay or repeat work, and the system cannot prove that the Git baseline advanced only after all affected assets completed.

This change composes those capabilities instead of replacing their domain logic. The existing Verification Service remains the only evidence entry point, the existing Freshness Store remains the state/event projection, and the existing P2 checkpoint remains the fine-grained compile/publication checkpoint. A new Sidecar-owned orchestration layer records coarse work identity, leases, attempts, page progress, and effect receipts.

## Goals / Non-Goals

**Goals:**

- Persist compilation and revalidation orchestration before execution and recover it after a Sidecar restart.
- Make a canonical Git observation replayable until every affected page has completed and the baseline acknowledgement has been recorded idempotently.
- Deduplicate concurrent wakeups and prevent stale lease holders from applying new side effects.
- Replace process-local Freshness retries with bounded durable attempts while keeping Hook/background failure isolation.
- Give pre-injection filtering a strict deadline-aware path to reuse current evidence, perform small targeted verification, or enqueue compensation.
- Preserve exact version, project, code revision, graph revision, reason-code, and job provenance across all transitions.

**Non-Goals:**

- Repair-draft generation, semantic evolution judging, migration, CodeGraph initialization execution, and their UI are later changes.
- This change does not execute tests or arbitrary commands, automatically initialize CodeGraph, edit knowledge bodies, or enable automatic publication.
- This change does not make filesystem watcher delivery authoritative and does not require a watcher for correctness.
- This change does not add cross-process parallelism; the first production composition runs one evolution worker, while all contracts retain fencing for later concurrency.

## Decisions

### 1. Reuse the generic job runtime behind a typed evolution orchestration package

Create `@zhiloop/evolution-job-runtime` as the typed boundary over `@zhiloop/job-runtime`. It owns strict input schemas, idempotency-key construction, typed enqueue/query operations, handler registration, capability state, and aggregate read models. It does not duplicate lease/attempt/checkpoint tables.

The stable job type set is:

```text
KNOWLEDGE_COMPILE
KNOWLEDGE_REVALIDATE
KNOWLEDGE_REPAIR_DRAFT
CODEGRAPH_INITIALIZE
LEGACY_KNOWLEDGE_MIGRATION
```

Only `KNOWLEDGE_COMPILE` and `KNOWLEDGE_REVALIDATE` are registered in this change. Enqueueing an unregistered type fails with `EVOLUTION_JOB_CAPABILITY_NOT_CONFIGURED`; it must not create a doomed job. Later modules register handlers without changing persisted job identity.

Alternative: extend the P2 extraction job store directly. Rejected because Candidate preview/commit jobs have extraction-specific payloads and lifecycle, while revalidation, migration, and initialization have independent authority and recovery rules.

### 2. Use immutable job inputs plus idempotent target-store effects

Job inputs are canonical JSON and immutable. Revalidation identity is:

```text
projectId + sourceRef + changeSetHash + recipeSelectionHash
```

Compile identity remains:

```text
sessionId + sourceRange + pipelineHash
```

Each handler calls `context.heartbeat()` immediately before a side effect and supplies `context.effectKey(step)` to an idempotent target boundary. Page projection, verification-run persistence, Freshness transition, compile dispatch, and Git baseline acknowledgement must all be replay-safe. A stale worker cannot save a new job checkpoint because the generic store validates job ID, attempt ID, worker ID, and fencing token.

Alternative: use one SQLite transaction across jobs, verification, freshness, and Git baseline. Rejected because these are separate owned databases and a cross-database transaction would create tighter lifecycle coupling. Stable effect receipts plus replay are the chosen consistency model.

### 3. Persist canonical Git observations separately from the acknowledged baseline

`GitKnowledgeChangeSource` is extended from an in-memory pending map to two durable records:

- acknowledged baseline: HEAD, status fingerprint, dirty path snapshot, revision;
- immutable observation: sourceRef, base revision, target HEAD/status, normalized path pages, observation hash, acknowledgement effect key/status.

`scan()` compares the repository to the acknowledged baseline. An equal observation returns the existing sourceRef. `acknowledge(sourceRef, effectKey)` performs an idempotent compare-and-set from the recorded base revision to the target revision. If a newer baseline is already acknowledged, the exact replay is a no-op only when the effect receipt matches; otherwise it is a conflict.

Rename records retain both old and new canonical relative paths. If the previous commit object is missing, the adapter records a bounded full tracked-file observation rather than advancing the baseline. More than 10,000 paths are stored and consumed in pages of at most 10,000; the adapter rejects output-byte overflow and invalid paths rather than silently truncating.

### 4. Wakeups are hints; the Git observation is authority

`KnowledgeChangeIntake` accepts `CODEX_FILE_CHANGED`, `WORKTREE_WATCHER`, `GIT_LIFECYCLE`, `FALLBACK_SCAN`, and `PRE_INJECTION`. It validates that the project/root pair was previously observed, coalesces project wakeups for the configured debounce window, then calls the Git source. It never constructs a `KnowledgeChangeSet` from watcher paths alone.

Fallback scans are persisted as scheduled-at metadata in the orchestration store so restart calculates the next due scan instead of resetting the interval. Watcher loss is repaired by this scan. Wakeup paths may reduce latency but cannot exclude paths found by Git.

### 5. Revalidation is one durable job with durable page progress

The revalidation handler performs these checkpoints:

1. load the immutable Git observation and validate its hash/project/root;
2. process changed-path pages into a stable, deduplicated affected-version list;
3. save `affectedAssetVersionsHash`, total count, and `afterAssetVersion` cursor;
4. for each bounded asset page, load the exact Verification Recipe, call the shared Verification Service, and CAS-project Freshness;
5. save the completed page and Verification run IDs;
6. after the final page, heartbeat/fence and idempotently acknowledge the Git baseline.

Paging uses `(assetId, assetVersion)` lexical order and a maximum page size from configuration. It never relies on Freshness state to skip a cursor, so a crash cannot change page membership. Replayed Verification requests and Freshness transitions use stable request/effect identities.

Missing Recipe becomes `UNKNOWN / RECIPE_MISSING`; it is a successful fail-closed projection, not an infinite retry. Store corruption, incomplete result cardinality, revision drift, and baseline CAS conflict are retryable or terminal according to their stable error classification.

### 6. Compilation gets a durable outer dispatch without replacing P2 checkpoints

Automatic compilation selection enqueues `KNOWLEDGE_COMPILE`; the evolution handler invokes the existing candidate-preview coordinator with a stable effect key. The coordinator and P2 job remain responsible for Snapshot creation and detailed compile stages. A replay sees the existing P2 job/preview and completes without creating duplicate Candidates or publication work.

### 7. `ensureFresh` is a bounded service, not an unbounded Hook worker

Add `FreshnessGateService` above `ProjectionFreshnessGate`:

```ts
ensureFresh({ project, assets, deadlineMs, signal })
  -> { eligible, excluded, revalidationJobIds, capability, completedWithinBudget }
```

Rules:

- non-code knowledge and exact current-revision `FRESH` records are returned immediately;
- only final retrieved candidates are considered, with a hard maximum;
- a `REVALIDATE` item may be synchronously verified only when a Recipe exists, the configured synchronous item cap is not exceeded, and at least the minimum verification budget remains;
- synchronous verification uses an abort signal bounded by the smaller of the caller deadline and configured `gateTimeoutMs`;
- `CONFLICT`, projection mismatch, missing Recipe, `UNKNOWN`, timeout, or unavailable capability is excluded from the current-fact partition and creates/reuses a `KNOWLEDGE_REVALIDATE` job;
- errors become structured exclusion diagnostics and never fail the Codex Hook.

The production default gate timeout is at most 200ms. No model, command, test, Git scan, or CodeGraph initialization is started from the Hook. A synchronous batch may only use already-observed project/revision data and read-only probes; all other work is asynchronous.

Alternative: keep projection-only filtering. Rejected because it cannot close a small, already-known stale set within the current prompt and cannot return durable compensation identifiers. Alternative: synchronously scan Git on every prompt. Rejected because it violates the latency/failure-open boundary.

### 8. Lifecycle, configuration, and observability

The Sidecar owns `evolution-jobs.sqlite` and the durable Git observation database. Startup order is stores → handler composition → worker recovery → intake timers. Shutdown stops intake, awaits in-flight flush/worker tails, then closes Git and job stores after dependent runtimes.

Configuration is normalized before swap and includes enabled state, poll/debounce/fallback intervals, lease/heartbeat, retry count, affected page size, gate timeout, synchronous item cap, and minimum remaining budget. Invalid reload leaves the old runtime active. The capability reports `READY`, `DEGRADED`, `DISABLED`, or `NOT_CONFIGURED` from real handler/store state.

The read model exposes job type/status, attempt/maxAttempts, progress, nextAttemptAt, last failure code/retryability, project/entity references, sourceRef, and checkpoint phase. It excludes prompts, knowledge bodies, command output, environment, and raw CodeGraph/Git output.

## Risks / Trade-offs

- **[Risk] A crash occurs between a target-store effect and job success.** → Every effect uses a stable effect key and replay returns the existing result before the job is marked succeeded.
- **[Risk] Baseline acknowledgement races a newer Git observation.** → Persist base revision and use CAS; a conflict leaves the baseline unchanged and schedules a fresh scan.
- **[Risk] A dirty worktree changes while a multi-page job runs.** → The observation is immutable; a later scan creates a new sourceRef and a later job. Evidence revision drift fails the current batch closed.
- **[Risk] Large repositories produce excessive paths/assets.** → Bound Git output bytes, store path pages, cap assets per page/total, persist cursors, and surface bounded/degraded status instead of truncation.
- **[Risk] Pre-injection verification consumes the Hook budget.** → Enforce an absolute monotonic deadline, a small item cap, abort propagation, and immediate asynchronous exclusion when budget is insufficient.
- **[Risk] One global worker delays independent projects.** → Default concurrency one is deliberate for SQLite safety; contracts and project keys permit later bounded cross-project workers.
- **[Risk] Job DB corruption hides stale knowledge.** → Capability becomes `DEGRADED`; current code facts remain excluded while Codex continues without injected current facts.

## Migration Plan

1. Add typed job contracts/store composition and tests without changing current scheduling.
2. Persist Git observations and effect receipts; migrate the current baseline table in place and prove existing baselines remain readable.
3. Add durable revalidation handler and dual-run it in tests against the existing Freshness worker outputs.
4. Route background Freshness scheduling to durable enqueue/worker execution; keep configuration default behavior unchanged.
5. Route automatic compilation dispatch through the durable outer job.
6. Compose `FreshnessGateService` into active injection and MCP current-fact filtering with the 200ms ceiling.
7. Run crash/restart, lease expiry, watcher-loss, force-push, dirty/rename, multi-page, no-duplicate-effect, and Hook latency gates.

Rollback stops new enqueueing and restores projection-only Freshness filtering. Existing evolution jobs and Git observations are derived operational data and may remain for a forward retry; rollback does not touch Ledger, Markdown, Registry, Verification recipes, or Knowledge versions. The old acknowledged baseline is retained during schema migration.

## Open Questions

None blocking. The first release intentionally uses one evolution worker, a 200ms maximum gate timeout, 10,000-path pages, and local-only observability. Later modules add Repair, CodeGraph initialization, Migration handlers, and their control-plane commands.
