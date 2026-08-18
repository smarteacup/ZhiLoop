# Semantic Evolution and Operational Alerts Gate Report

## Scope

This report closes OpenSpec change `wire-semantic-evolution-and-alerts`. It records the production boundary for one bounded Codex semantic judgment after deterministic evolution is exhausted, plus durable local operational alerts. It does not enable semantic judgment by default and does not grant publication authority.

Observed at: `2026-08-19T16:00:00+08:00`

## Module results

| Module | Implemented boundary | Acceptance evidence |
|---|---|---|
| Codex structured generation | shared read-only, ephemeral, schema-constrained JSON execution with bounded input/output and sanitized diagnostics | extraction compatibility, argument, size, timeout, cancellation and invalid-output tests |
| Semantic evolution adapter | summary-only projection, at most five targets, strict action/target parser and dynamic health | one-call, malformed response, invented/duplicate target, model failure and privacy tests |
| Domain enforcement | deterministic engine remains primary; semantic output can only select supplied versions and never publishes | invalid action/confidence/reason/target remains `PENDING`; scope cannot be supplied by the model |
| Operational alert store | SQLite WAL/FULL, `0600`, canonical hashes, event idempotency, revision CAS, cooldown aggregation and bounded reads | restart, corruption, cursor, collision, rollback and concurrent delivery tests |
| Producers and control plane | permanent job failure, CodeGraph unavailable and stale knowledge feed the local store under their existing switches | producer integration tests, bounded diagnostics projection and localized Console tests |

## Authority and privacy boundary

- Semantic arbitration runs only when deterministic classification returns `PENDING`; a single decision invokes the adapter at most once.
- The model receives candidate/target title, summary, scope, assertions and source identifiers. Candidate bodies, target bodies and full conversation text are structurally absent.
- The model cannot return scope or publication authority. The domain validates every selected `id@version` against the exact supplied target set.
- Invalid JSON, timeout, adapter failure, duplicate target or out-of-set target leaves the candidate `PENDING`.
- Operational alerts retain only stable IDs, entity references, reason codes, counters, timestamps and delivery metadata. They do not contain prompt text, knowledge bodies, environment values or raw Codex/CodeGraph output.
- External delivery is optional. Without a provider, persisted records report `LOCAL_ONLY`; local persistence is never presented as successful external notification.

## Persisted replay

The semantic acceptance test supplied one ambiguous candidate and observed exactly one `generateStructured` call. Alert acceptance used a real temporary SQLite database, emitted duplicate events with the same dedup identity inside the cooldown window, closed the store, reopened the same file and read the aggregate.

| Observation | Result |
|---|---:|
| Semantic model calls for one ambiguous decision | 1 |
| Target bodies/full conversation included | 0 |
| Durable alert rows for one dedup key | 1 |
| Aggregate occurrence count after duplicate events | 2 |
| Provider calls inside cooldown | 1 |
| Record after SQLite restart | preserved |
| Delivery state without provider | `LOCAL_ONLY` |

## Review fixes

Review corrected two consistency issues before closure. A reused dedup key is now rejected when it refers to another alert type/project/entity, preventing unrelated failures from being merged. Provider completion now merges into the latest alert revision, so an occurrence arriving while delivery is in flight cannot be overwritten or cause a false CAS failure.

## Automated gates

| Gate | Result |
|---|---|
| `openspec validate wire-semantic-evolution-and-alerts --strict` | passed |
| Workspace dependency/import/direct-test | 74 workspaces passed |
| ESLint | passed |
| TypeScript build and test typecheck | passed |
| Node architecture/P0–P7 gates | 60 passed |
| Vitest | 187 files, 1,612 tests passed |
| Coverage | 90.00% statements, 85.10% branches, 92.10% functions, 93.77% lines |
| Persisted semantic/alert replay | passed |
| `git diff --check` | passed |

## Remaining boundary

Fresh installs keep `semanticJudgeEnabled=false`; enabling it is an explicit cost/quality decision. The first production composition has no external alert provider, so alerts remain visible in the local Console as `LOCAL_ONLY`. Legacy knowledge migration and `MIGRATION_FAILED` production events belong to the next module; the alert contract is ready for that producer without simulating it early.
