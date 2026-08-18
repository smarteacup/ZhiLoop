# Design: Knowledge evolution decision boundary

## Context

Knowledge identity already uses `subjectKey + kind + resolved scope`, and Markdown enforces contiguous immutable versions. Registry offers bounded FTS search, while Evidence Policy already understands conflict IDs and adoption ambiguity. The missing boundary is a pure classifier between Candidate compilation and policy evaluation.

## Decisions

### Two-phase matching

The Worker owns I/O and supplies the domain package with:

1. the exact current asset for the deterministic identity, if one exists;
2. no more than five Registry search candidates;
3. the resolved Candidate scope and correction drafts.

The package deduplicates and validates these inputs. Exact identity wins over search rank. Subject/kind/scope equality, normalized content equality, symbols, aliases, and scope identity are deterministic signals. FTS rank is never treated as semantic truth.

### Explicit pending result

`EvolutionDecision` is a discriminated union. A decided result has one of `STORE`, `SUPPLEMENT`, `SUPERSEDE`, `CONTRADICT`, `SCOPE_SPLIT`, or `SKIP`. An unresolved result has status `PENDING`, target versions, reason codes, and requires confirmation. Pending is not encoded as STORE or SKIP.

The first implementation exposes a semantic-arbitration port in the domain API but does not require a model adapter in the production composition. If deterministic evidence is ambiguous, the result remains PENDING. A later adapter can make at most one bounded call and its output must reference only supplied target versions.

### Publication matrix

| Decision | Worker behavior |
|---|---|
| STORE | Build a new asset lineage if Evidence Policy permits. |
| SUPPLEMENT | Publish the immediate next version of the matched lineage; preserve prior metadata and add a DERIVED_FROM relation. |
| SUPERSEDE | Publish the immediate next version; add a SUPERSEDES relation to the previous version. Verified targets require confirmation and therefore do not auto-publish. |
| SCOPE_SPLIT | Build a new, narrower lineage and add RELATED_TO relations to the matched scopes. |
| CONTRADICT | Pass target IDs as conflicts and never create an outbox item. |
| SKIP | Record the duplicate target and never create an outbox item. |
| PENDING | Mark adoption ambiguous and never create an outbox item. |

Evidence Policy remains authoritative for lifecycle and scope. Evolution can further restrict publication but cannot promote status or widen scope.

### Replay and compatibility

Decisions and ordered target versions are checkpointed. Replays skip the completed stage. A legacy checkpoint missing `EVOLUTION_MATCH` runs the new stage; any previously completed downstream policy/outbox remains immutable, preventing a deployment upgrade from silently changing an already-authorized publication batch.

## Failure handling

- More than five search results, duplicate IDs with different content, malformed target versions, or exact-identity mismatch fail closed.
- Registry lookup failure is retryable and cannot degrade to STORE.
- Semantic adapter failure returns PENDING with a diagnostic code and cannot publish.
- Two Candidates claiming the same asset lineage remain protected by the existing outbox collision gate.
