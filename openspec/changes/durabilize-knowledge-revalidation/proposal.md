## Why

ZhiLoop can detect Git changes and revalidate knowledge, but the current scheduler is process-local: a Sidecar crash can lose work, concurrent wakeups can duplicate it, and the Git baseline can advance without a durable record that every affected page completed. The injection path also excludes stale knowledge without a bounded mechanism to reuse or enqueue the exact revalidation work needed to make it current again.

## What Changes

- Add a Sidecar-owned Evolution Durable Job runtime for knowledge compilation, revalidation, future repair/migration work, and explicit CodeGraph initialization, with stable idempotency keys, leases, fencing tokens, bounded attempts, retry timing, and restart recovery.
- Add a Change Intake service that treats Codex events, filesystem watchers, Git lifecycle events, fallback scans, and pre-injection misses as wakeups while deriving authoritative change sets only from the existing Git change adapter.
- Move Freshness revalidation dispatch from process-local timers to durable `KNOWLEDGE_REVALIDATE` jobs; preserve fine-grained P2 checkpoints and advance a Git baseline only after all pages for one change set succeed.
- Add a bounded pre-injection `ensureFresh` gate that reuses current `FRESH` results, performs only deadline-safe targeted verification, and otherwise excludes code facts while creating or reusing an asynchronous durable job.
- Define fail-open Codex behavior and fail-closed current-code injection when the job store, CodeGraph, Git revision, or verifier is unavailable.
- Add restart, lease-expiry, concurrent-wakeup, dirty worktree, rename, force-push, watcher-loss, page-boundary, deadline, and Hook-latency acceptance gates.

## Capabilities

### New Capabilities

- `evolution-durable-jobs`: Durable multi-type job identity, lease/fencing execution, retry/recovery, bounded storage, and effect checkpoints for knowledge evolution work.
- `knowledge-change-intake`: Wakeup normalization, authoritative Git change-set derivation, affected-knowledge paging, and commit-after-success baseline semantics.
- `freshness-injection-gate`: Revision-aware targeted freshness checks with a strict latency budget, safe exclusion, and idempotent asynchronous compensation.

### Modified Capabilities

None. Existing console and governance contracts remain compatible; later changes will expose the new read models and operations.

## Impact

- Adds a durable evolution job package and a Sidecar-owned SQLite database with strict lifecycle ownership.
- Changes Sidecar Freshness scheduling, Git change-source acknowledgement, pre-injection filtering, configuration consumers, health/read-model projection, and runtime composition.
- Reuses `job-runtime`, `knowledge-freshness`, `knowledge-verification`, `invalidation-engine`, `project-identity`, Registry, and existing immutable P2 worker checkpoints.
- Does not execute arbitrary commands, initialize CodeGraph automatically, mutate Knowledge Markdown, block the Codex Hook on background failure, or enable automatic publication.
