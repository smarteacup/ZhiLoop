## 1. Contracts and dry run

- [x] 1.1 Create migration types, strict validation, classification and deterministic Candidate/assertion reconstruction.
- [x] 1.2 Implement the hardened SQLite preview/audit store with immutable item snapshots, canonical hashes, revision CAS, paging and restart tests.
- [x] 1.3 Implement bounded dry-run scanning and prove it performs zero Recipe, Freshness, Verification and Registry/Markdown writes.

## 2. Durable commit

- [x] 2.1 Extend the legacy migration job input with exact migration/preview identity and preserve enqueue compatibility for previously rejected job types.
- [x] 2.2 Implement a paginated, checkpointed migration handler with per-target drift validation, stable verification requests and replay-safe effects.
- [x] 2.3 Add initial verification classification and explicit missing-recipe/project/corruption/concurrent-version fixtures.

## 3. Owned writes and rollback

- [x] 3.1 Add transactionally owned Recipe writes/deletes to the verification store with corruption, collision, restart and rollback tests.
- [x] 3.2 Add transactionally owned Freshness project/delete operations with later-event conflict detection and rollback tests.
- [x] 3.3 Implement migration rollback, reverse traversal, conflict reporting, idempotency and index-rebuild signaling.

## 4. Production composition and control

- [x] 4.1 Register `LEGACY_KNOWLEDGE_MIGRATION` as a READY Sidecar handler and compose lifecycle ownership safely.
- [x] 4.2 Expose bounded migration preview/status/item/commit/rollback contracts and truthful capability state.
- [x] 4.3 Emit durable `MIGRATION_FAILED` alerts on terminal job failure without exposing bodies or raw tool output.

## 5. Review and gates

- [x] 5.1 Run focused restart/replay/revision/rollback/privacy tests and a real temporary-database persisted migration.
- [x] 5.2 Review authority, no-guess classification, transaction boundaries, crash recovery, concurrency, deletion impact, privacy and performance; fix all findings.
- [x] 5.3 Run OpenSpec strict validation, dependency/import/direct-test checks, lint, build, test typecheck, full tests and coverage; record the Gate report.
