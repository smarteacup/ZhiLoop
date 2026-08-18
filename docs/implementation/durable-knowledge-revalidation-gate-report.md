# Durable Knowledge Revalidation Gate Report

## Scope

This report closes OpenSpec change `durabilize-knowledge-revalidation`. It records the acceptance evidence for typed durable evolution jobs, authoritative Git change intake, restart-safe compilation/revalidation, exact pre-injection freshness gating, Sidecar lifecycle, and operational projections.

Observed at: `2026-08-19T04:51:00+08:00`

## Module results

| Module | Implemented production boundary | Acceptance evidence |
|---|---|---|
| Evolution Job Runtime | Five strict job contracts; two configured handlers; canonical idempotency; lease/fencing; bounded privacy-safe projections | duplicate/conflict, capability rejection, retry exhaustion, cancellation, lease replacement, corruption and restart tests |
| Git Change Intake | persisted observed projects, baseline revision, immutable observations, paged paths, fallback schedule and acknowledgement effect | dirty/untracked, rename, commit/checkout, missing object, watcher loss, more than 10,000 paths, CAS race and corruption tests |
| Revalidation | frozen exact-version affected set, resumable pages, shared production verification, Freshness effect receipts, baseline-last acknowledgement | multi-page success, failure before/after effect, checkpoint replay, revision drift, Recipe missing and incomplete output tests |
| Compilation | durable outer `KNOWLEDGE_COMPILE` dispatch over the existing Snapshot/Candidate Preview checkpoint | response-loss replay, CURRENT reuse, pipeline/range drift, visibility lag and no duplicate inner work tests |
| Freshness Gate | exact project/content/code/graph revision matching; optional targeted verification; deterministic compensation | current/missing/mismatch/conflict/unknown, timeout, cancellation, degraded stores, repeat prompt and P95 latency tests |
| Sidecar/Console | startup recovery, single worker, timer drain, validate-before-swap configuration, health/capability/job projection and Chinese labels | composition, configuration rollback, actual release install, SIGTERM/restart and API compatibility tests |

The future job types `KNOWLEDGE_REPAIR_DRAFT`, `CODEGRAPH_INITIALIZE`, and `LEGACY_KNOWLEDGE_MIGRATION` are intentionally persisted as typed capabilities but remain `NOT_CONFIGURED`. Enqueue is rejected before persistence until a later change registers their handlers.

## Real Codex and CodeGraph replay

The gate ran:

```text
npm run verify:production-evidence -- --transcript <absolute-codex-rollout-jsonl>
```

The read-only source was session `019fbc7e-f203-7550-9b6f-bfb89e809d0f`. All derived state was written to a new temporary directory and removed on exit.

| Observation | Result |
|---|---:|
| Transcript size | 69,129,846 bytes |
| Transcript lines | 30,027 |
| Projected Ledger events | 126 |
| Candidate Preview count | 2 |
| Execution mode | `PREVIEW_ONLY` |
| Registry/Markdown mutations | 0 / 0 |
| CodeGraph before initialization | `NOT_CONFIGURED` |
| CodeGraph after explicit initialization | `READY` |
| Source changed before sync | `UNAVAILABLE / CODEGRAPH_INDEX_STALE` |
| After explicit sync | `READY`, new index revision and changed symbol visible |

This proves that capability detection does not initialize CodeGraph, a stale index is never treated as current, and source mutation only becomes queryable after an explicit sync.

## Restart and duplicate-effect evidence

The built local release was installed in an isolated temporary home, started as a real Sidecar process, captured a real JSONL fixture, and received `SIGTERM`. A second Sidecar process then started with the same config and state directory. Health returned `READY`, and replaying the same capture appended zero events.

The lower-level evolution recovery suites complement that process replay:

- an observation persisted before enqueue is recovered and creates one stable revalidation job;
- an effect committed before its checkpoint is not duplicated after retry;
- a baseline acknowledgement committed before its checkpoint replays idempotently;
- a completed affected page is not re-verified after restart;
- the Git baseline remains at the old revision until every page has completed;
- an old code revision is never admitted by injection while a newer revision is pending.

Together these gates prove no duplicate Ledger, Candidate Preview dispatch, Freshness transition, Verification page, or baseline acknowledgement across the tested failure boundaries.

## Automated gates

| Gate | Result |
|---|---|
| `openspec validate durabilize-knowledge-revalidation --strict` | passed |
| Workspace dependency/import/direct-test | 71 workspaces passed |
| ESLint | passed |
| TypeScript build and test typecheck | passed |
| Node architecture/P0–P7 gates | 60 passed |
| Vitest | 183 files, 1,580 tests passed |
| Coverage | 90.00% statements, 85.02% branches, 92.02% functions, 93.81% lines |
| Real production evidence replay | passed |
| Built Sidecar terminate/restart replay | passed |
| `git diff --check` | passed |

## Review disposition

The code review is recorded in `code_review.md`. Findings concerning exact revision coverage, legacy baseline migration, restart root recovery, package dependency direction, validate-before-swap configuration, graph applicability, compensation traceability, degraded capability projection, and shutdown order were fixed before this report.

Repair Draft generation, semantic evolution judgment, CodeGraph initialization execution, legacy migration execution, and their operator commands remain intentionally outside this change and continue to report `NOT_CONFIGURED`; they are not silently simulated by the completed revalidation path.
