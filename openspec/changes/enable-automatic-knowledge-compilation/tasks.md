## 1. Scheduler Domain and Storage

- [x] 1.1 Scaffold the `knowledge-compilation-scheduler` workspace package and define bounded configuration, checkpoint, trigger, dispatch, report, timer, and store contracts.
- [x] 1.2 Implement deterministic trigger evaluation for turn threshold, idle, session end, maximum wait, capture eligibility, and no-new-event cases with unit tests.
- [x] 1.3 Implement the SQLite CAS checkpoint store, validation, due index, restart recovery, corruption handling, and concurrency tests.

## 2. Automatic Scheduling Runtime

- [x] 2.1 Implement bounded catalog pagination, per-session checkpoint transitions, stable dispatch identities, CAS conflict retries, and aggregate diagnostics.
- [x] 2.2 Implement the non-overlapping completion-based scheduler lifecycle and deterministic timer tests.
- [x] 2.3 Add service tests for repeat scans, source revision races, manual/automatic convergence responses, bounds, failure isolation, and restart behavior.

## 3. Shared P2 Preview Coordination

- [x] 3.1 Extract immutable range planning and Preview dispatch from `P2ConsoleRuntime` into a shared `P2CandidatePreviewCoordinator` while preserving manual stale-revision behavior.
- [x] 3.2 Add the automatic dispatch adapter with Ledger/source revalidation and stable `ENQUEUED`, `EXISTING`, `CURRENT`, `STALE`, and `INELIGIBLE` outcomes.
- [x] 3.3 Verify that automatic dispatch can only enqueue Candidate Preview and cannot invoke Policy Commit or publication.

## 4. Sidecar Composition and Configuration

- [x] 4.1 Wire the checkpoint store, compilation service, scheduler, catalog, and P2 adapter into Sidecar startup, shutdown, and safe reconfiguration.
- [x] 4.2 Add validated automatic compilation configuration defaults and expose `READY`, `STOPPED`, `DEGRADED`, or `DISABLED` runtime state plus bounded last-run diagnostics.
- [x] 4.3 Add production composition and control-plane tests for enabled, disabled, degraded, restart, and invalid-reconfiguration paths.

## 5. Verification and Review

- [x] 5.1 Run package unit tests, Sidecar integration tests, dependency checks, lint, build, typecheck, and the full regression suite.
- [x] 5.2 Review idempotency, SQLite locking, scan complexity, content leakage, shutdown races, and the PREVIEW_ONLY gate; document any accepted limitation.
- [x] 5.3 Update the implementation documentation and mark the OpenSpec tasks complete only when current evidence covers every requirement scenario.
