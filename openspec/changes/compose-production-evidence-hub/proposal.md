## Why

ZhiLoop 0.4.0 has verifier contracts and a real CodeGraph symbol adapter, but the production Candidate composition still returns `UNKNOWN` for every non-user assertion and Freshness only composes `SYMBOL_EXISTS`. This leaves code, file, dependency, configuration, command, test, call-path, impact, and cross-project claims without one production verification boundary, so the system cannot prove that knowledge is current before policy or injection decisions.

## What Changes

- Add one production `KnowledgeVerificationService` used by Candidate compilation and Freshness revalidation.
- Add read-only local file, manifest, configuration, Ledger statement, and current-Snapshot command/test observation probes.
- Extend normalized code intelligence with index revision and bounded call-path facts; use existing impact facts for `IMPACT_CONTAINS`.
- Add `CALL_PATH_EXISTS` and `IMPACT_CONTAINS` domain assertions and register every domain assertion kind with a verifier, including `CROSS_PROJECT_VERIFIED`.
- Persist immutable, bounded verification-run summaries and versioned verification recipes without duplicating conversation or knowledge bodies.
- Replace the production `snapshot-bounded-v1` fallback and the symbol-only Freshness verifier with the shared service.
- Preserve fail-closed publication and fail-open Codex behavior: unavailable or unsafe sources produce `UNKNOWN`, and no probe executes commands or mutates a repository.

## Capabilities

### New Capabilities

- `production-evidence-hub`: Shared revision-bound verification, safe local/session/cross-project probes, recipes, immutable run summaries, and production composition requirements.

### Modified Capabilities

- `codegraph-fact-layer`: Adds normalized index revision and bounded call-path facts without exposing vendor payloads or adding repository mutation.
- `freshness-revalidation`: Requires Freshness to consume the shared production verification service for every selected assertion rather than a symbol-only composition.

## Impact

- Domain and schemas: `packages/domain`, `packages/schemas`.
- Verification: `packages/evidence-engine` plus new production probe/service/store packages.
- Code facts: `packages/code-intelligence`, `packages/codegraph-adapter`.
- Runtime composition: `apps/sidecar/src/p2-production.ts`, `apps/sidecar/src/p2-freshness-runtime.ts`, P2 lifecycle/configuration.
- Persistence: new Sidecar-owned `knowledge-verification.sqlite`; no Markdown or Ledger migration.
- Security/dependencies: repository-contained read-only access, bounded parsers/outputs/deadlines, no shell invocation, no background command/test execution.
