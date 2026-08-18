## 1. Projection and Anchors

- [x] 1.1 Add freshness contracts and deterministic projection builder from Candidate, asset, and Evidence.
- [x] 1.2 Add integrity-checked SQLite projection with indexed anchors and idempotent version semantics.
- [x] 1.3 Add bounded affected-knowledge lookup for normalized change sets.

## 2. Planning and Worker Integration

- [x] 2.1 Map invalidation-engine decisions to independent freshness state and CAS mutation plans.
- [x] 2.2 Add FRESHNESS_PROJECT worker stage and replay-safe outbox checkpoint.
- [x] 2.3 Wire and close the production freshness store.

## 3. Verification and Review

- [x] 3.1 Test anchor mapping, integrity, idempotency, bounds, all freshness states, and partial publication recovery.
- [x] 3.2 Run full gates and strict OpenSpec validation.
- [x] 3.3 Complete implementation notes and code review.
