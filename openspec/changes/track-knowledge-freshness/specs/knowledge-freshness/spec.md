## ADDED Requirements

### Requirement: Published knowledge has durable reverse anchors

The system SHALL project every published asset version with integrity-checked Candidate assertions and PATH, SYMBOL, CONFIG, or DEPENDENCY anchors.

#### Scenario: Publication is replayed

- **WHEN** the same asset version and projection payload are submitted again
- **THEN** projection is idempotent and anchor rows are not duplicated

#### Scenario: Same version has different provenance

- **WHEN** the same asset version is submitted with a different Candidate or fingerprint
- **THEN** projection fails closed

### Requirement: Change lookup is bounded

The system SHALL map a normalized project change set to affected active asset versions through indexed anchors and a caller-provided hard limit.

#### Scenario: Unrelated file changes

- **WHEN** no anchor matches the changed path, symbol, config, or dependency
- **THEN** no knowledge is selected for revalidation

### Requirement: Freshness is independent from lifecycle

The system SHALL report FRESH, REVALIDATE, CONFLICT, or UNKNOWN without overwriting the historical KnowledgeStatus.

#### Scenario: Verified code assertion is refuted after a related change

- **WHEN** revalidation no longer supports an affected assertion
- **THEN** freshness is CONFLICT and the plan proposes lifecycle STALE while preserving the body

#### Scenario: Affected assertions are supported again

- **WHEN** every affected assertion has fresh supporting Evidence
- **THEN** freshness is FRESH and a new fingerprint projection is requested

### Requirement: Freshness projection is part of publication recovery

The Worker SHALL checkpoint freshness projection after Registry projection and before incremental indexing.

#### Scenario: Freshness projection temporarily fails

- **WHEN** Markdown and Registry succeeded but freshness storage is unavailable
- **THEN** the Worker is retryable and does not repeat prior successful side effects
