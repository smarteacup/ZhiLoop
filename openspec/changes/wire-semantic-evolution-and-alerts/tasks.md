## 1. Semantic execution boundary

- [x] 1.1 Extend the Codex exec model with a generic bounded structured-generation contract while preserving extraction compatibility and sanitized diagnostics.
- [x] 1.2 Create the semantic evolution Codex adapter, summary projection, strict response parser, health state, and direct tests.
- [x] 1.3 Harden domain validation for target uniqueness/cardinality and prove invalid, timeout, error, and out-of-set output remain `PENDING`.

## 2. Composition and capability

- [x] 2.1 Make semantic arbitration opt-in with a fresh-install default of `false`; compose no adapter when disabled.
- [x] 2.2 Wire the adapter into `KnowledgeWorkerRuntime` and project truthful `READY`, `DEGRADED`, or `DISABLED` capability state.
- [x] 2.3 Add restart/configuration and privacy-boundary tests.

## 3. Durable operational alerts

- [x] 3.1 Create alert contracts and a hardened SQLite store with canonical integrity checks, cooldown aggregation, bounded reads, delivery state, and restart tests.
- [x] 3.2 Add optional provider delivery without weakening local persistence or claiming delivery when none is configured.
- [x] 3.3 Wire real producers for permanent evolution-job failure, CodeGraph unavailable, and stale knowledge, honoring all existing switches.

## 4. Control and console

- [x] 4.1 Extend control contracts, Sidecar query composition, gateway/client routes, and schemas for bounded durable alert reads.
- [x] 4.2 Add a localized console view for durable alerts and semantic capability/failure reasons.
- [x] 4.3 Verify operational responses never expose prompts, knowledge bodies, raw CodeGraph/Codex output, or environment values.

## 5. Review and gates

- [x] 5.1 Run OpenSpec strict validation, dependency/import/direct-test checks, lint, build, test typecheck, focused suites, and full coverage gates.
- [x] 5.2 Review security, scope/authority invariants, timeout/cancellation, SQLite durability, producer replay, privacy, configuration truthfulness, and deletion impact; fix every finding.
- [x] 5.3 Run a persisted replay demonstrating one semantic call for one ambiguous candidate and cooldown aggregation of duplicate alerts; record a Gate report.
