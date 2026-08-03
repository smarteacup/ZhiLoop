## ADDED Requirements

### Requirement: Effective, draft, and historical configuration
The system SHALL expose effective configuration with field source, allow draft revisions, and preserve immutable activation and rollback history.

#### Scenario: Project override is effective
- **WHEN** a project-scoped value overrides a global default
- **THEN** the Console displays both values, the effective result, source, and configuration hash used by a run

### Requirement: Field-level baseline configuration
The configuration Schema SHALL define bounded fields for injection budget, background scheduling, categorized retry, alerts, Codex query, retention, and privacy.

#### Scenario: User configures background processing
- **WHEN** the user edits scan interval, worker poll, extraction delay, batch size, retry attempts, backoff, jitter, or concurrency
- **THEN** the server validates safe ranges that prevent a zero-delay busy loop, unbounded retry, or call storm

#### Scenario: User configures alerts
- **WHEN** the user changes severity, spool lag, cursor lag, job failure, Hook silence, or quiet hours
- **THEN** the system changes notification behavior without hiding underlying `DEGRADED` or `FAILED` state

### Requirement: Validate preview before activation
The system SHALL require server-side validation, expected revision, diff, affected components, restart impact, and capability checks before a draft can become effective.

#### Scenario: Configuration references an uncomposed capability
- **WHEN** a valid draft configures a future injection or compiler consumer that is disabled
- **THEN** the draft can be preserved but activation of that field is rejected with a stable capability reason

#### Scenario: Expected revision is stale
- **WHEN** another activation changed current configuration after the draft was based
- **THEN** activation is rejected without overwriting the newer revision

### Requirement: Atomic activation and rollback
The system SHALL prepare and apply configuration across affected components atomically from the user's perspective and retain last-known-good configuration on any failure.

#### Scenario: One component fails to apply
- **WHEN** any affected component rejects or fails the new configuration
- **THEN** all prepared changes are rolled back, the prior effective revision remains active, and failure evidence is recorded

#### Scenario: User rolls back configuration
- **WHEN** the user selects a compatible historical revision
- **THEN** the system validates it and creates a new rollback revision rather than deleting history or moving an untracked pointer

### Requirement: Configuration writes are audited and secret-safe
The system SHALL record operator, revision, changed field paths, result, and timestamps without storing secret values or full knowledge/prompt content in audit logs.

#### Scenario: A secret-bearing field changes
- **WHEN** a configuration revision changes a protected value
- **THEN** the audit records the field path and redacted change metadata but not the old or new secret

