## 1. Contracts and Identity

- [x] 1.1 Add USER_COMMITMENT stage, detection/correction/provenance payload types, and legacy missing-stage compatibility.
- [x] 1.2 Add request policyHash validation and immutable work identity binding; wire Snapshot policyHash from P2.

## 2. Commitment Compilation

- [x] 2.1 Aggregate detector results deterministically across Episodes and reject signal/provenance collisions.
- [x] 2.2 Apply only unique accepted/rejected signals to Candidates and persist ambiguities unchanged.
- [x] 2.3 Materialize deterministic correction relation drafts without generating or publishing inferred body text.

## 3. Verification and Review

- [x] 3.1 Add unit/integration tests for acceptance, rejection, ambiguity, correction, replay, provenance, legacy checkpoints, and P2 composition.
- [x] 3.2 Run dependency, lint, build, typecheck, full regression, coverage, and OpenSpec strict validation.
- [x] 3.3 Complete implementation documentation and code review before marking all tasks complete.
