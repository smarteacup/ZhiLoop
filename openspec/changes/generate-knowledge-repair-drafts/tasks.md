## 1. Repair draft domain and persistence

- [x] 1.1 Create `@zhiloop/knowledge-repair-drafts` contracts, deterministic identities, bounds, canonical hashing, status machine, and package boundary metadata.
- [x] 1.2 Implement the durable SQLite store with idempotent create, exact reads, bounded listing, revision CAS transitions, effect receipts, corruption checks, and deterministic close.
- [x] 1.3 Add tests for duplicate/conflicting create, bounds, corruption, concurrent revisions, terminal states, idempotent attach/dismiss/fail/promote, and restart persistence.

## 2. Conflict identity and durable handler

- [x] 2.1 Propagate exact verification run IDs through ProductionFreshnessVerifier and KnowledgeFreshnessWorker with cardinality/identity validation.
- [x] 2.2 Implement `KNOWLEDGE_REPAIR_DRAFT` handler validation, unsupported-assertion derivation, idempotent persistence, checkpointing, and retry classification.
- [x] 2.3 Enqueue repair jobs only for durable `CONFLICT` results before page checkpoint and prove duplicate/restart replay reuses one job and one draft.
- [x] 2.4 Add negative tests for non-conflicts, missing/stale/mismatched run, changed content/version/revision, unsupported cardinality, cancellation, and store failure.

## 3. Sidecar composition and read boundary

- [x] 3.1 Register the repair handler, own/close the repair database, expose bounded draft reads to the composition, and report capability `READY`.
- [x] 3.2 Add startup/restart, health capability, privacy-safe job projection, and shutdown-order tests without exposing knowledge bodies in operational job lists.

## 4. Review and gates

- [x] 4.1 Run OpenSpec strict validation, dependency/import/direct-test checks, lint, build, test typecheck, focused suites, and full coverage gates.
- [x] 4.2 Review identity, CAS/idempotency, SQLite durability, privacy, stale-work rejection, authority separation, scheduling order, restart recovery, and deletion impact; fix every finding.
- [x] 4.3 Run a real persisted conflict/restart replay proving one draft, unchanged source content hash, zero Registry/Markdown writes, and record a Gate report.
