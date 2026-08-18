## 1. Durable State

- [x] 1.1 Add version-bound freshness state and transition contracts.
- [x] 1.2 Extend SQLite schema, projection initialization, CAS transition, history and idempotency.

## 2. Worker

- [x] 2.1 Resolve bounded affected records and derive assertion batches.
- [x] 2.2 Validate one-revision batch verifier output before writes.
- [x] 2.3 Persist plans with CAS and return repair-oriented run results.

## 3. Verification

- [x] 3.1 Test state history, replay, CAS, supported/refuted/unknown and invalid output.
- [x] 3.2 Run full Gate, strict OpenSpec validation and code review.
