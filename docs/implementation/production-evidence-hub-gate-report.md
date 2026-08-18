# Production Evidence Hub Gate Report

## Scope

This report closes OpenSpec change `compose-production-evidence-hub`. It records the production-composition gates for immutable Snapshot verification, Preview-only safety, real CodeGraph capability behavior, compatibility, and repository quality.

Observed at: `2026-08-19T03:10:43+08:00`

## Real Codex transcript replay

The gate ran:

```text
npm run verify:production-evidence -- --transcript <absolute-codex-rollout-jsonl>
```

The selected read-only source was session `019fbc7e-f203-7550-9b6f-bfb89e809d0f`. The runner writes only to a newly-created temporary directory and removes it on exit. It does not update the source transcript, user ZhiLoop state, business repository, Registry, or Markdown knowledge.

| Observation | Result |
|---|---:|
| Transcript size | 69,129,846 bytes |
| Transcript lines | 30,027 |
| Projected Ledger events | 126 |
| Ignored non-domain records | 29,901 |
| Projected event types | 1 `session.started`, 64 `user.prompted`, 61 `turn.stopped` |
| Snapshot | immutable identity generated from source identity, range, and cursor |
| Execution mode | `PREVIEW_ONLY` |
| Final checkpoint | `AWAITING_COMMIT` |
| Candidate count | 2 |
| Verification | 2 × `FILE_CONTAINS: SUPPORTED / FILE_LITERAL_FOUND` |
| Policy target | `PROPOSED` |
| `shouldPublish` | `false` |
| Registry assets after run | 0 |
| Markdown files after run | 0 |

The compiler in this acceptance runner is intentionally a deterministic gate fixture. The test is therefore evidence for the real transcript → Ledger → Episode → compiler contract → Candidate → evidence → policy → Preview boundary, not a quality evaluation of a live model response. It prevents model availability, user configuration, and token cost from weakening the repeatable production gate.

No prompt, assistant response, tool output, or Ledger payload is printed or retained in the report. The runner emits only bounded counts, identifiers, verdicts, reason codes, and revisions.

## Real CodeGraph failure and change replay

The runner created an isolated Git repository and used the installed CodeGraph CLI through `CodeGraphCliAdapter`.

| Phase | Result |
|---|---|
| Capability before initialization | `NOT_CONFIGURED / CODEGRAPH_NOT_INITIALIZED` |
| Adapter-created `.codegraph` directory | no |
| Capability after explicit `codegraph init -i` | `READY / CODEGRAPH_READY` |
| Symbol query | 1 current fact |
| Call-path trace | 1 current fact |
| Impact query | 4 current facts |
| Capability after source mutation, before sync | `UNAVAILABLE / CODEGRAPH_INDEX_STALE` |
| Capability after explicit `codegraph sync` | `READY / CODEGRAPH_READY` |
| Index revision across baseline/change/sync | changed at every state boundary |
| Newly-added symbol after sync | 1 current fact |

This proves that the production adapter does not initialize an unknown repository, does not treat a dirty graph as current, and resumes evidence production only after an explicit index refresh.

## Automated gates

The final repository gate is `npm run check`, covering:

- workspace dependency and source-import policy;
- direct-test and console-test policy;
- ESLint;
- TypeScript build and test typecheck;
- Node architecture and P0–P7 gates;
- Vitest unit and integration suites;
- statement, branch, function, and line coverage thresholds;
- strict OpenSpec validation.

The exact final counts are updated after the final run below:

| Gate | Result |
|---|---|
| `openspec validate compose-production-evidence-hub --strict` | passed |
| Workspace dependency policy | 68 workspaces passed |
| Node architecture/P0–P7 gates | 57 passed |
| Vitest | 176 files, 1,505 tests passed |
| Coverage | 90.00% statements, 85.07% branches, 91.89% functions, 93.77% lines |
| `npm run check` | passed |
| `git diff --check` | passed |

## Review disposition

The module review is recorded in `code_review.md`. Review findings covering ambiguous command success, serialized freshness verification, duplicate service construction, Git revision latency, and missing coverage ownership were fixed before this acceptance replay. The remaining production-closure gaps belong to the subsequent OpenSpec modules and do not reopen this module's evidence-composition boundary.
