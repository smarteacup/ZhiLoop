## ADDED Requirements

### Requirement: Freshness state transitions are version-bound and auditable

The system SHALL persist current freshness separately from immutable knowledge content and append an immutable event for each non-idempotent transition.

#### Scenario: An identical observation is replayed

- **WHEN** the same asset version, status, revisions, reasons, and affected assertions are committed again
- **THEN** the state revision and event count do not increase

### Requirement: Revalidation is bounded and batch-consistent

The system SHALL resolve at most the configured affected asset limit and verify all selected assertions in one batch bound to one code revision and optional graph revision.

#### Scenario: The affected set exceeds the limit

- **WHEN** anchor lookup reports more active versions than the hard limit
- **THEN** the run is marked bounded and only the returned versions are processed

### Requirement: Invalid verifier output fails before transitions

The system SHALL reject duplicate, unrequested, cross-project, or revision-mismatched verifier results before changing freshness state.

#### Scenario: A verifier returns an assertion that was not requested

- **WHEN** batch output contains that result
- **THEN** no freshness transition is committed

### Requirement: Conflicts preserve knowledge content

The system SHALL record CONFLICT and propose MARK_STALE when fresh Evidence refutes an affected assertion, without rewriting the body.

#### Scenario: A code symbol disappears

- **WHEN** batch revalidation returns REFUTED for its anchored assertion
- **THEN** current freshness is CONFLICT and the result contains a body-preserving MARK_STALE action
