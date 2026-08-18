## 1. Contracts and schema

- [x] 1.1 Add CALL_PATH_EXISTS and IMPACT_CONTAINS to domain assertion/evidence contracts, compiler drafts, schemas, policy maps, invalidation anchors, fixtures, and exhaustive tests.
- [x] 1.2 Change the Knowledge Worker evidence port to a request object carrying purpose, immutable loaded Snapshot, selected assertion IDs, and expected revision; migrate all adapters and tests.
- [x] 1.3 Extend CodeIntelligencePort with normalized index revision and bounded call-path facts while preserving existing operations.

## 2. CodeGraph facts

- [x] 2.1 Implement safe argv-based bounded CodeGraph callee traversal and normalized index-revision parsing with timeout, output, depth, visited-symbol, process-call, result, and cache bounds.
- [x] 2.2 Add symbol, call-path, and impact probe tests for exact support/refutation, unavailable capability, revision drift, malformed output, and vendor-field exclusion.
- [x] 2.3 Run a real temporary-repository CodeGraph query/trace/impact smoke test without initializing or mutating an unknown repository.

## 3. Read-only evidence probes

- [x] 3.1 Create the evidence-probes workspace and implement canonical repository containment, byte/depth limits, symlink-escape rejection, and exact file observations.
- [x] 3.2 Implement bounded dependency parsers for package.json, pom.xml, Gradle, Cargo.toml, and go.mod with version-aware UNKNOWN semantics.
- [x] 3.3 Implement bounded JSON, YAML, TOML, and properties configuration lookup plus registered safe REGEX/STRUCTURAL evaluator behavior.
- [x] 3.4 Implement SnapshotObservationIndex and Ledger user, command, and test probes without executing processes or storing raw output.
- [x] 3.5 Add probe security and failure tests for path traversal, symlink escape, oversized/binary files, parser damage, unsupported modes, timeout, and Snapshot boundaries.

## 4. Verification service and persistence

- [x] 4.1 Create the knowledge-verification workspace with strict request/batch validation and exactly-one-result enforcement for every selected assertion.
- [x] 4.2 Implement the SQLite recipe/run store with permissions, WAL/FULL durability, canonical hashes, idempotency conflicts, corruption checks, bounded summaries, and close lifecycle.
- [x] 4.3 Register verifiers for every Assertion Kind, including call path, impact, and cross-project current-proof semantics.
- [x] 4.4 Implement code/graph revision capture and before/after drift detection so mixed-revision results fail before persistence.
- [x] 4.5 Add service/store tests for mixed probes, cancellation/deadline, partial capability degradation, invalid output, replay, restart, corruption, privacy, and cross-project identity.

## 5. Production composition

- [x] 5.1 Compose the verification service into P2ProductionComposition, pass the exact loaded Snapshot at Candidate policy, and remove the synthetic evidenceFor fallback.
- [x] 5.2 Inject the shared verification port into P2FreshnessRuntime, remove its private registry/CodeGraph verifier, and preserve batch validation and cancellation.
- [x] 5.3 Add configuration/lifecycle ownership for knowledge-verification.sqlite with validate-then-swap and deterministic close ordering.
- [x] 5.4 Add Candidate and Freshness production integration tests proving real local/CodeGraph Evidence, historical command/test UNKNOWN behavior, fail-closed policy, and fail-open runtime degradation.

## 6. Architecture, security, and compatibility gates

- [x] 6.1 Update workspace dependency/import allowlists and add architecture tests that keep filesystem, Ledger, SQLite, and CodeGraph adapters out of domain packages.
- [x] 6.2 Update schemas, compatibility fixtures, reason-code labels, implementation documentation, and the capability/completion matrix.
- [x] 6.3 Run OpenSpec strict validation, dependency/import/direct-test checks, lint, build, test typecheck, all architecture/P0-P7 gates, unit/integration tests, and coverage thresholds.
- [x] 6.4 Perform code review across correctness, deletion/compatibility impact, concurrency, SQLite, performance, privacy, configuration, and failure semantics; fix every finding and update code_review.md.
- [x] 6.5 Run Preview-only real Codex replay plus real CodeGraph failure/change replay, confirm no automatic publication, and record the module Gate report.
