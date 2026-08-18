## ADDED Requirements

### Requirement: Knowledge detail exposes version-bound freshness

The system SHALL return the current knowledge version together with its matching freshness state, code anchors and immutable transition history.

#### Scenario: A revalidation conflict is inspected

- **WHEN** an operator opens a knowledge version whose latest freshness state is CONFLICT
- **THEN** the Console shows the previous and current state, code and graph revisions, reason codes, affected assertions and occurrence time

### Requirement: Missing freshness is not presented as fresh

The system SHALL report `NOT_PROJECTED` when a code freshness projection is unavailable.

#### Scenario: A legacy knowledge version has no projection

- **WHEN** the detail is composed
- **THEN** the response excludes it from default retrieval and includes `FRESHNESS_NOT_PROJECTED`

### Requirement: Observability reads are non-mutating and bounded

The system SHALL bound anchors and history and SHALL NOT transition freshness or lifecycle state while composing a Console view.

#### Scenario: Detail is refreshed repeatedly

- **WHEN** the same detail endpoint is read multiple times
- **THEN** freshness revision and event count do not change
