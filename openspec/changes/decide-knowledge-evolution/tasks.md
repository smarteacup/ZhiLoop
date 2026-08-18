## 1. Domain Contracts

- [x] 1.1 Add the knowledge-evolution package, discriminated decision types, validation, and stable identity helpers.
- [x] 1.2 Implement exact, duplicate, supplement, supersede, contradiction, scope-split, store, and pending rules.
- [x] 1.3 Add optional one-shot semantic arbitration with target confinement and fail-closed fallback.

## 2. Worker Integration

- [x] 2.1 Add bounded evolution lookup and EVOLUTION_MATCH checkpoint contracts.
- [x] 2.2 Persist decisions before Evidence Policy and pass conflict/ambiguity restrictions into policy.
- [x] 2.3 Materialize lineage-aware outbox assets only for publishable evolution actions.
- [x] 2.4 Wire Registry search in production and preserve legacy replay behavior.

## 3. Verification and Review

- [x] 3.1 Add domain and Worker tests for all actions, bounds, malformed adapters, replay, publication, and legacy checkpoints.
- [x] 3.2 Run package and full repository quality gates plus strict OpenSpec validation.
- [x] 3.3 Document the implemented boundary and complete a code review with all findings resolved.
