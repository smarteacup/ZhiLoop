# Change: Decide knowledge evolution before publication policy

## Why

The worker currently maps every publishable Candidate directly to the deterministic asset identity. It can create a new version, but it cannot explain whether that version is a duplicate, a supplement, a replacement, a contradiction, or a scope-specific branch. This makes automatic knowledge refresh unsafe and leaves conflict handling to storage side effects.

## What Changes

- Add a storage-independent `knowledge-evolution` domain package.
- Resolve exact identity first, then inspect at most five Registry search candidates.
- Persist one deterministic or explicitly pending evolution decision for every Candidate.
- Feed conflicts and ambiguity into Evidence Policy so unresolved evolution cannot publish.
- Materialize only allowed STORE, SUPPLEMENT, SUPERSEDE, and SCOPE_SPLIT decisions; SKIP and CONTRADICT remain side-effect free.
- Preserve prior versions and relation provenance when an existing lineage evolves.

## Impact

- Adds one required bounded Registry lookup port to the knowledge worker composition.
- Adds an `EVOLUTION_MATCH` checkpoint stage and evolution payload records.
- Changes publication outbox construction, but does not change Markdown/Registry storage schemas.
- Existing completed work remains immutable; legacy in-flight work can populate the new stage without rewriting already-created outboxes.
