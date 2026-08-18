# Knowledge Repair Drafts Gate Report

## Scope

This report closes OpenSpec change `generate-knowledge-repair-drafts`. It records the production boundary from an exact Freshness conflict to one durable, reviewable repair draft. It does not claim semantic replacement generation or publication.

Observed at: `2026-08-19T05:20:00+08:00`

## Module results

| Module | Implemented boundary | Acceptance evidence |
|---|---|---|
| Repair Draft Store | deterministic draft ID, exact source/run snapshot, SQLite WAL/FULL, canonical hashes, bounded reads, revision CAS and effect receipts | duplicate/conflict, corruption, pagination, restart, stale revision and terminal-state tests |
| Verification identity | exact `KnowledgeVerificationBatch.runId` propagated per asset through Freshness worker output | missing, unknown, malformed and cardinality-mismatched run maps fail closed |
| Durable handler | validates project, Candidate, asset version, code/graph revision, conflict state and refuted assertions before creating `PENDING` | mismatch matrix, checkpoint replay, retry classification and process-exit-after-write recovery |
| Revalidation scheduling | enqueues repair after the Freshness conflict effect and before the page checkpoint | failure-after-enqueue replay calls twice but resolves to one canonical repair identity |
| Sidecar composition | owns `knowledge-repair-drafts.sqlite`, registers handler as `READY`, exposes bounded read methods, and closes resources deterministically | disabled/start/restart/close lifecycle and capability tests |

## Authority and semantic boundary

- The old Registry asset, Markdown document, lifecycle status and content hash are never mutated by draft creation.
- Automatic handling creates `PENDING` only. A verifier can prove that an assertion is refuted, but cannot by itself prove replacement wording.
- A later generator may attach only a new domain Candidate whose status is `PROPOSED`; the source Candidate ID cannot be reused.
- `PROMOTED` requires a durable downstream Candidate-intake receipt and still does not mean accepted, implemented, verified, or published.
- `inheritedAuthorization` is structurally fixed to `false` and checked on storage reads and transitions.

## Persisted restart replay

The integration gate used real temporary SQLite files for Freshness, Verification, Evolution Jobs, and Repair Drafts. It terminated the first durable attempt after the draft insert but before its checkpoint, closed the job runtime, advanced the retry clock, and opened a second worker on the same files.

| Observation | Result |
|---|---:|
| Durable repair jobs for the conflict | 1 |
| Repair drafts after retry/restart | 1 |
| Draft state | `PENDING`, revision 0 |
| Source asset/version/content hash | exact match |
| Changed assertion | exact refuted assertion/run |
| Source Freshness content hash after replay | unchanged |
| Registry writes | 0 |
| Markdown writes | 0 |
| Proposed Candidate generated automatically | 0 |

## Review fixes

Review corrected six issues before closure: effect replay initially depended on the current later draft state; effect hashes omitted command revision/time; Candidate validation rejected legitimate multiline content; source Candidate structure was under-validated; Sidecar construction/close failures could leak a newly owned database; and the new package was initially absent from global coverage instrumentation.

## Automated gates

| Gate | Result |
|---|---|
| `openspec validate generate-knowledge-repair-drafts --strict` | passed |
| Workspace dependency/import/direct-test | 72 workspaces passed |
| ESLint | passed |
| TypeScript build and test typecheck | passed |
| Node architecture/P0–P7 gates | 60 passed |
| Vitest | 185 files, 1,593 tests passed |
| Coverage | 90.02% statements, 85.13% branches, 92.06% functions, 93.80% lines |
| Persisted repair/restart replay | passed |
| `git diff --check` | passed |

## Remaining boundary

Drafts deliberately remain `PENDING` until the semantic evolution module can produce grounded replacement assertions from live facts. Operator commands and the Console repair-draft page are also separate modules. Neither limitation weakens the current injection gate: conflicted code knowledge remains excluded while repair work is pending.
