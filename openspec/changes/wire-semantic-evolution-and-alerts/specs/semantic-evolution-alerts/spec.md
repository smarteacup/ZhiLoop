## ADDED Requirements

### Requirement: Semantic evolution SHALL remain a bounded advisory step

The system SHALL call semantic arbitration at most once only for a non-empty unresolved deterministic match and SHALL accept only validated actions over exact supplied target versions.

#### Scenario: Adapter returns an out-of-set target

- **WHEN** semantic output references a target version not present in the bounded request
- **THEN** the evolution decision remains `PENDING`
- **AND** no knowledge is published or mutated

#### Scenario: Adapter is disabled or unavailable

- **WHEN** semantic arbitration is disabled or its adapter fails
- **THEN** deterministic decisions remain unchanged and unresolved decisions remain `PENDING`
- **AND** capability state truthfully reports `DISABLED` or `DEGRADED`

### Requirement: Semantic input SHALL minimize retained and transmitted content

The adapter SHALL send only bounded candidate/target summaries, scopes, assertions, identifiers and allowed actions, and SHALL NOT send a full conversation or complete knowledge body.

#### Scenario: Ambiguous candidate is judged

- **WHEN** an unresolved candidate has up to five target versions
- **THEN** exactly one read-only structured Codex call receives only the reduced projection
- **AND** sanitized diagnostics retain neither prompt nor result content

### Requirement: Operational evolution alerts SHALL be durable and honest about delivery

The system SHALL persist privacy-safe alerts locally, aggregate identical deduplication keys within a cooldown window, and distinguish local-only, delivered and failed-delivery state.

#### Scenario: No external provider is configured

- **WHEN** a producer emits an enabled alert
- **THEN** the alert is queryable after restart with delivery state `LOCAL_ONLY`
- **AND** the system does not claim an external notification was sent

#### Scenario: A duplicate alert is replayed

- **WHEN** the same deduplication key is emitted again within its cooldown window
- **THEN** occurrence count and last-observed time advance on the existing alert
- **AND** no repeated provider delivery is attempted

### Requirement: Existing evolution alert switches SHALL have real producers

The configured permanent-job-failure, CodeGraph-unavailable and stale-knowledge switches SHALL control actual runtime producers writing to the durable local sink.

#### Scenario: Durable revalidation finds a conflict

- **WHEN** stale-knowledge alerting is enabled and an exact Freshness version reaches `CONFLICT`
- **THEN** one sanitized `STALE_KNOWLEDGE` alert is persisted for that version

### Requirement: Operators SHALL be able to inspect durable alerts

The control API and console SHALL expose bounded sanitized durable alerts with localized type, severity, delivery state, occurrence count, entity reference, reason codes and timestamps.

#### Scenario: Console loads the alert center

- **WHEN** locally persisted evolution alerts exist
- **THEN** the console displays their current state without exposing prompt, conversation, knowledge body, process output or environment data
