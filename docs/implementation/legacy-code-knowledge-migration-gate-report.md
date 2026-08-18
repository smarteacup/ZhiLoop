# Legacy Code Knowledge Migration Gate Report

## Scope

This report closes OpenSpec change `migrate-legacy-code-knowledge`. It covers an operator-started, two-phase migration that makes historical code-related knowledge eligible for the current Recipe, Verification and Freshness pipeline without changing formal knowledge.

Observed at: `2026-08-19T18:00:00+08:00`

## Implemented boundary

| Module | Implemented behavior | Acceptance evidence |
|---|---|---|
| Classification | exact Freshness, Recipe or explicit symbol reconstruction; no prose/model inference | missing, mixed candidate, scope, project, Recipe/Freshness mismatch fixtures |
| Preview store | immutable SQLite preview/items, canonical hashes, revision CAS, receipts and bounded forward/reverse pages | 0600, restart, corruption, invalid input, paging and effect replay tests |
| Durable commit | exact migration/preview job identity, first-effect Registry gate, stable verification and checkpoints | target-write crash replay, terminal-checkpoint crash replay, revision and page failure tests |
| Owned targets | transactionally owned Recipe and Freshness projection/state | collision, restart, preexisting data, idempotency and ownership tests |
| Rollback | reverse traversal; delete only unchanged migration-owned rows; later activity is retained | successful reverse rollback, exact replay, new-command rejection and Freshness conflict tests |
| Sidecar/control | READY handler, bounded P2 requests/views and durable terminal alerts | real Unix Socket routing, localized failure codes and sanitized `MIGRATION_FAILED` test |

## Authority and privacy boundary

- Dry-run reads Registry, Recipe and Freshness only. It performs no Verification, publication, Markdown or Registry write.
- Candidate assertions come only from exact persisted provenance or explicit symbol anchors. Summary, body, aliases and keywords are not evidence sources.
- Project identity is checked on both Knowledge Scope and every graph-backed assertion carrying `projectId`.
- Commit adds only Recipe, Verification summary, Freshness projection/state and migration audit data.
- Control responses and alerts contain identifiers, hashes, counts, revisions, states and bounded reason codes; knowledge bodies and raw tool output are absent.

## Persisted replay

The acceptance suite used real temporary SQLite files. One exact legacy asset was previewed, durably committed, verified and rolled back. The original `KnowledgeAsset` was cloned before execution and remained equal after commit and rollback.

| Observation | Result |
|---|---:|
| Formal Registry/Markdown writes | 0 |
| Target-write crash duplicate Recipe/Freshness rows | 0 |
| Completion/checkpoint crash duplicate verification calls | 0 |
| Exact rollback command replay | same terminal receipt |
| New rollback command after terminal state | rejected |
| Later Freshness activity | retained with `ROLLBACK_CONFLICT` |
| Terminal migration failure | durable sanitized `MIGRATION_FAILED` |

## Review fixes

Review fixed 12 issues before closure: concurrent target ownership, completion-effect time stability, completed-state recovery, rollback traversal order, rollback command replay, rollback terminal revision identity, preview run identity, Recipe/Freshness consistency, assertion project identity, transport request routing, commit replay after Registry movement and exception classification during Recipe rollback.

## Automated gates

| Gate | Result |
|---|---|
| `openspec validate migrate-legacy-code-knowledge --strict` | passed |
| Workspace dependency/import/direct-test | 75 workspaces passed |
| ESLint | passed |
| TypeScript build and test typecheck | passed |
| Node architecture/P0–P7 gates | 60 passed |
| Vitest | 191 files, 1,647 tests passed |
| Coverage | 90.00% statements, 85.24% branches, 92.24% functions, 93.78% lines |
| `git diff --check` | passed |

## Remaining boundary

Migration remains operator-started and does not automatically initialize CodeGraph or publish replacement knowledge. The control transport is implemented; a dedicated migration-center Console page and browser workflow belong to the subsequent operator-console module.
