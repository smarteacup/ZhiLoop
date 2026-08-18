## 1. Typed durable evolution jobs

- [x] 1.1 Create the evolution-job-runtime workspace with strict job-type/input schemas, canonical hashes, stable compile/revalidate idempotency keys, handler capability registration, and workspace boundary tests.
- [x] 1.2 Compose SqliteDurableJobStore and DurableJobWorker behind typed enqueue/query/state/lifecycle APIs while rejecting unregistered future job types before persistence.
- [x] 1.3 Add privacy-safe aggregate job projections for status, revision, progress, attempt/maxAttempts, retry timing, failure classification, project/entity references, and checkpoint phase.
- [x] 1.4 Add tests for duplicate/conflicting enqueue, future NOT_CONFIGURED types, retry exhaustion, cancellation, store restart, lease expiry, fencing rejection, bounded listings, corruption, and deterministic close.

## 2. Durable Git observation and Change Intake

- [x] 2.1 Migrate GitKnowledgeChangeSource to persist baseline revisions, immutable observations, paged canonical paths, hashes, acknowledgement effects, and recovery of unacknowledged observations.
- [x] 2.2 Correct Git parsing for rename old/new paths, dirty/untracked files, missing prior objects, byte/path limits, and deterministic pages above 10,000 paths without silent truncation.
- [x] 2.3 Implement idempotent compare-and-set baseline acknowledgement bound to sourceRef, base revision, and effect key; preserve the baseline on incomplete work or conflict.
- [x] 2.4 Implement KnowledgeChangeIntake validation, observed-project registry, source coalescing/debounce, persisted fallback schedule, authoritative scans, recovery enqueue, and graceful stop/drain.
- [x] 2.5 Add temporary-repository fixtures for watcher loss, concurrent signals, dirty changes, rename, commit/checkout, force-push, more-than-10,000 paths, restart-before-enqueue, acknowledgement replay, and baseline races.

## 3. Durable revalidation and compilation handlers

- [x] 3.1 Extend affected-knowledge lookup with a stable exact-version snapshot/hash and `(assetId, assetVersion)` page cursor that does not depend on mutable Freshness state.
- [x] 3.2 Implement KNOWLEDGE_REVALIDATE checkpoints for observation load, affected-set freeze, per-page Recipe verification, Freshness CAS projection, effect receipts, and final baseline acknowledgement.
- [x] 3.3 Implement RECIPE_MISSING as a successful UNKNOWN fail-closed projection and classify revision drift, incomplete verification cardinality, store errors, and baseline conflicts for bounded retry or terminal failure.
- [x] 3.4 Implement KNOWLEDGE_COMPILE as a durable outer dispatch that reuses the existing Snapshot/P2 preview job and checkpoint without duplicate Candidates or publication work.
- [x] 3.5 Add handler tests for multi-page success, failure before/mid/after effects, kill/restart recovery, lease replacement, concurrent enqueue, changed repository during work, exact run/event cardinality, and no duplicate publication.

## 4. Freshness pre-injection gate

- [x] 4.1 Extend Freshness projection identity with the code and required graph revisions needed to prove exact current-fact eligibility while preserving existing stored-record compatibility.
- [x] 4.2 Implement FreshnessGateService for immediate non-code/current-FRESH decisions, strict input bounds, exact project/version/content/revision matching, structured exclusions, and deterministic compensation keys.
- [x] 4.3 Implement optional targeted synchronous Recipe verification with a monotonic deadline, item cap, abort propagation, exactly-one-result checks, and no Git scan/model/command/CodeGraph initialization from the Hook.
- [x] 4.4 Compose ensureFresh into active injection and MCP current-fact filtering, return compensation job IDs and stable diagnostics, and preserve fail-open Codex behavior on all gate failures.
- [x] 4.5 Add gate tests for current, missing, mismatch, REVALIDATE, CONFLICT, UNKNOWN, non-code, missing Recipe, insufficient budget, timeout/hang, degraded stores/CodeGraph, repeated prompts, cancellation, and unhandled-rejection absence.
- [x] 4.6 Add a production Hook latency fixture proving P95 below 200ms for the gate and no Hook blockage or unsafe code-fact injection during background failure.

## 5. Sidecar composition, configuration, and compatibility

- [x] 5.1 Add evolution job/Git observation database ownership, startup recovery, single-worker polling, intake timers, stop/drain, and dependency-safe close order to the Sidecar composition.
- [x] 5.2 Route automatic compilation and Freshness wakeups through the durable runtime, remove the process-local revalidation retry owner, and retain compatibility adapters only where required.
- [x] 5.3 Add normalized validate-before-swap configuration consumers for enablement, polling/debounce/fallback, lease/heartbeat, retries, page limits, and gate budgets with READY/DEGRADED/DISABLED/NOT_CONFIGURED capability state.
- [x] 5.4 Update health/operational read models, configuration audit, control API compatibility fixtures, Chinese enum/reason labels, architecture boundaries, and the version capability matrix.

## 6. Review and acceptance gates

- [x] 6.1 Add focused architecture and security tests proving domain packages do not import SQLite, timers, child processes, Sidecar, raw Git/CodeGraph DTOs, or job adapters.
- [x] 6.2 Run OpenSpec strict validation, dependency/import/direct-test checks, lint, build, test typecheck, all architecture/P0-P7 gates, integration suites, and coverage thresholds.
- [x] 6.3 Perform code review across lease/fencing, idempotency, baseline advancement, paging, timers, cancellation, SQLite durability, privacy, latency, configuration rollback, deletion impact, and failure semantics; fix every finding and update code_review.md.
- [x] 6.4 Run a real temporary Git/CodeGraph change replay and a Sidecar terminate/restart replay, confirm no duplicate Candidate/Verification/Freshness/baseline effect and no unsafe injection, and record the module Gate report.
