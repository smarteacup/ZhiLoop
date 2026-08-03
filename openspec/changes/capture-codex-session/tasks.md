## 1. Capture Domain and Persistence

- [x] 1.1 Add bounded exact-session transcript locator with symlink, escape, metadata-line, depth, and file-count protections
- [x] 1.2 Add reusable incremental capture service and privacy-safe result/diagnostic types around `readTranscriptIncrement()`
- [x] 1.3 Add ledger-backed ingestion cursor storage with validation and append-before-cursor ordering
- [x] 1.4 Test discovery success, missing/ambiguous IDs, limits, dry-run, incremental resume, malformed input, and idempotent replay

## 2. Sidecar and CLI Integration

- [x] 2.1 Extend Sidecar config and local deployment rendering with the canonical Codex sessions root
- [x] 2.2 Add serialized `capture-session` Sidecar request handling without blocking the Hook spool fast path
- [x] 2.3 Add `zhiloop capture --session <id> [--dry-run] [--json]` parsing, timeout, stable exit codes, and content-free output
- [x] 2.4 Test transport validation, unavailable Sidecar behavior, concurrent capture serialization, and Hook operation during capture

## 3. Documentation and Release

- [x] 3.1 Document active capture usage, event projection boundaries, SHADOW behavior, diagnostics, and repeat-capture semantics
- [x] 3.2 Update release metadata and local artifact acceptance coverage for the capture command and upgraded config
- [x] 3.3 Run architecture, lint, build, typecheck, unit, integration, and coverage gates; review performance and privacy boundaries

## 4. Real Session Acceptance

- [ ] 4.1 Upgrade the local deployment through the journaled installer and verify READY health
- [ ] 4.2 Dry-run session `019f837a-34d4-7e60-800c-6361f6fb6d49` and verify no ledger mutation
- [ ] 4.3 Capture the session, verify expected canonical events and empty spool, then repeat and verify zero new rows
- [ ] 4.4 Commit and push the completed change with a clean worktree
