## ADDED Requirements

### Requirement: Durable bounded alert catalog
The system SHALL list durable operational alerts with severity, type, stable reason codes, aggregate count, first/last observation, related entity, delivery state, local operator state, and suggested action using bounded stable pagination.

#### Scenario: Repeated failure is aggregated
- **WHEN** the same alert deduplication key is observed repeatedly
- **THEN** the Console shows one alert with the durable occurrence count and latest observation rather than duplicate rows

#### Scenario: Alert contains unsafe source detail
- **WHEN** a provider or job error contains transcript, knowledge body, token, or raw tool output
- **THEN** the query returns only a redacted bounded diagnostic summary

### Requirement: Alert acknowledgement and suppression
The system SHALL record acknowledgement and time-bounded suppression as independent operator-state revisions and MUST NOT delete or alter the underlying alert or related health state.

#### Scenario: Operator acknowledges an alert
- **WHEN** a valid acknowledgement command carries the current alert revision and an idempotency key
- **THEN** subsequent reads show who/when acknowledged it while the underlying issue remains visible until resolved

#### Scenario: Critical alert is suppressed
- **WHEN** a CRITICAL alert has an active local suppression window
- **THEN** notification delivery may be muted but the alert remains in unresolved and critical views

### Requirement: Alert command concurrency safety
The system SHALL reject stale, cross-entity, cross-project, unauthenticated, or CSRF-invalid alert commands and SHALL never silently replay a state-changing command after refreshing a revision.

#### Scenario: Two tabs change the same alert
- **WHEN** the second tab submits an older expected revision
- **THEN** it receives the current revision and must ask the operator to retry from refreshed state

