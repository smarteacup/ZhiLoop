## 1. Protocol and Read Models

- [x] 1.1 Define bounded evolution operations, CodeGraph initialization, migration, alert, knowledge evolution, and session timeline DTOs with revision and localized diagnostic fields
- [x] 1.2 Compose authoritative Sidecar operations snapshots from Job, Verification, Freshness, Migration, Alert, Runtime Audit, and capability stores without read side effects
- [x] 1.3 Register versioned query and command request parsers, Socket routing, project authorization, response bounds, and stable error mappings

## 2. CodeGraph Lifecycle

- [x] 2.1 Implement the durable observed-project registry with canonical repository identities and safe server-side lookup
- [x] 2.2 Implement immutable expiring initialization previews with root, Home, directory, project, and symlink-escape validation
- [x] 2.3 Implement idempotent `CODEGRAPH_INITIALIZE` jobs using fixed argv, timeout/output bounds, durable attempts, and crash-safe checkpoints
- [x] 2.4 Publish CodeGraph capability revisions only after status, version, and bounded query smoke-test evidence succeeds
- [x] 2.5 Add path-boundary, stale revision, duplicate commit, process timeout, output redaction, retry, and recovery tests

## 3. Migration and Alert Operations

- [x] 3.1 Expose migration preview, bounded item pages, commit progress, rollback preview/commit, and conflict diagnostics through the control protocol
- [x] 3.2 Implement durable alert operator-state projections for acknowledgement and time-bounded suppression without altering source alerts
- [x] 3.3 Add idempotency, revision conflict, cross-project, redaction, pagination, critical suppression, and no-side-effect tests

## 4. Console Workflows

- [x] 4.1 Add centralized Chinese enum/reason rendering and complete operation failure/progress components with raw-code diagnostics
- [x] 4.2 Add CodeGraph lifecycle page with capability, preview, explicit confirmation, job progress, retry, and revision conflict handling
- [x] 4.3 Add migration center with dry-run summary, bounded item inspection, commit progress, rollback conflicts, and safe confirmation
- [x] 4.4 Add alert center with filters, aggregation, related entity navigation, acknowledgement, suppression, and critical-state visibility
- [x] 4.5 Extend overview, session, knowledge, and injection areas with authoritative evolution timelines, Evidence/Freshness/Repair details, revalidation, repair submission, and source navigation
- [x] 4.6 Implement single-flight abortable refresh with SSE invalidation, bounded polling fallback, terminal stop, unmount cleanup, and one-time preview refresh

## 5. Verification and Delivery

- [x] 5.1 Cover all seven areas with normal, empty, loading, degraded, failure, unknown-enum, revision-conflict, accessibility, and unmount tests
- [x] 5.2 Add browser and security acceptance for CodeGraph initialization → revalidation → Evidence → conflict → Repair Draft → migration preview, CSRF, project isolation, duplicate clicks, and oversized responses
- [x] 5.3 Prove all read-only Console navigation leaves Ledger, Candidate, Knowledge, Job, and operator-state revisions unchanged
- [x] 5.4 Run package tests, workspace/import checks, lint, TypeScript build, full regression, coverage, and strict OpenSpec validation
- [x] 5.5 Perform code review, fix all material findings, update implementation report and capability/version matrix, deploy locally, and complete browser smoke verification
