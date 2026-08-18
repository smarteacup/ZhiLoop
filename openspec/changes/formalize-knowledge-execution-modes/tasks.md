## 1. Execution Mode Contract

- [x] 1.1 Add execution-mode and publication-authorization types, validation, checkpoint audit fields, and backward-compatible parsing behavior.
- [x] 1.2 Replace the boolean publication boundary with mode-based stage caps and a fail-closed default.
- [x] 1.3 Enforce stable authorization before and during publication, including lower-privilege replay behavior.

## 2. P2 Durable Job Integration

- [x] 2.1 Map Candidate Preview jobs to `PREVIEW_ONLY` and explicit Commit jobs to authorized `SAFE_AUTO_PUBLICATION`.
- [x] 2.2 Update P2 worker test doubles and integration tests for mode propagation, missing authorization, retry, and automatic-preview isolation.

## 3. Compatibility and Verification

- [x] 3.1 Add runtime tests for all modes, default fail-closed behavior, Preview-to-Commit resume, changed authorization, legacy checkpoint, and successful-stage replay.
- [x] 3.2 Run dependency, lint, build, typecheck, unit/integration, coverage, and OpenSpec strict validation gates.
- [x] 3.3 Complete code review and implementation documentation, recording accepted limitations before marking the change complete.
