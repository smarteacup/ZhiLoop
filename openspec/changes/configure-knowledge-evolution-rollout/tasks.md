## 1. Versioned configuration

- [x] 1.1 Add strict configuration v2 schemas, defaults and deterministic v1 migration.
- [x] 1.2 Reject future versions and unsafe publication combinations with precise diagnostics.

## 2. Runtime application

- [x] 2.1 Upgrade the online Console configuration and map it to the live compilation scheduler.
- [x] 2.2 Add a bounded, non-reentrant freshness ChangeSet scheduler with runtime reconfiguration.
- [x] 2.3 Add the evidence-bound per-Candidate automatic-publication rollout gate.

## 3. Console and operations

- [x] 3.1 Expose the new fields through the existing draft/validate/activate/rollback page with Chinese component grouping.
- [x] 3.2 Document migration, safety defaults, production ownership and rollback.

## 4. Verification

- [x] 4.1 Test migration determinism, future rejection, safety invariants, runtime activation/rollback, scheduling and rollout denials.
- [x] 4.2 Run the full Gate, strict OpenSpec validation and code review.
