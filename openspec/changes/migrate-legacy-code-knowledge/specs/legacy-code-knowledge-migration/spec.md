# Legacy Code Knowledge Migration

## ADDED Requirements

### Requirement: Dry run is immutable and side-effect free

The system SHALL create a durable, revisioned preview from bounded current Registry pages without writing Recipe, Freshness, Verification, Candidate, Registry or Markdown state.

#### Scenario: Preview classifies legacy knowledge

- **WHEN** an operator requests a dry run for an observed project
- **THEN** every considered current asset SHALL have an exact version/content hash and a migratable, skipped or already-current classification with stable reason codes
- **AND** the preview SHALL bind the Registry revision and canonical summary hash

#### Scenario: Missing evidence cannot be guessed

- **WHEN** an asset has no current Recipe/Freshness provenance and no explicit supported anchor
- **THEN** it SHALL be skipped with `RECIPE_MISSING`
- **AND** no model SHALL be called to infer assertions from prose

### Requirement: Commit is revision-checked and resumable

The system SHALL commit only an exact READY preview through a fenced durable job whose pages and effects are idempotent across interruption and restart.

#### Scenario: Registry changed before commit

- **WHEN** the Registry revision differs from the preview before the first commit effect
- **THEN** the command SHALL fail with a revision conflict and create no derived data

#### Scenario: Process exits after a target write

- **WHEN** the process exits after a migration-owned Recipe or Freshness transaction but before the page checkpoint
- **THEN** replay SHALL reuse the same owned row and verification request
- **AND** SHALL not create a duplicate Recipe, projection, run or audit item

### Requirement: Initial verification determines truthful freshness

The system SHALL run current production verification for the exact selected assertions and SHALL project `FRESH` only when all are supported.

#### Scenario: Assertions are not fully supported

- **WHEN** any selected assertion is refuted
- **THEN** the migrated state SHALL be `CONFLICT`
- **WHEN** any selected assertion is unknown or errors
- **THEN** the migrated state SHALL be `UNKNOWN`

### Requirement: Formal knowledge remains byte-for-byte unchanged

The system SHALL never mutate Markdown, Registry asset content, Scope, Authority, lifecycle or content hash during migration or rollback.

#### Scenario: Successful migration

- **WHEN** a migration completes
- **THEN** every target's pre/post Registry version and content hash SHALL be identical
- **AND** only Recipe, Freshness, Verification and migration audit data MAY be added

### Requirement: Rollback deletes only unchanged migration-owned data

The system SHALL remove only derived rows transactionally owned by the exact migration and SHALL preserve any item with later Freshness activity.

#### Scenario: Freshness changed after migration

- **WHEN** rollback encounters a migrated projection with a later state revision or event
- **THEN** the projection SHALL remain intact
- **AND** the migration SHALL report `ROLLBACK_CONFLICT` with the exact asset version

### Requirement: Production operation is bounded and observable

The system SHALL expose bounded preview, status, item and rollback diagnostics, register a truthful durable-job capability and emit a local durable alert for terminal migration failure.

#### Scenario: Migration permanently fails

- **WHEN** the durable migration job exhausts retries
- **THEN** one cooldown-aggregated `MIGRATION_FAILED` alert SHALL identify the migration/job by bounded references and reason codes
- **AND** it SHALL contain no knowledge body, prompt, environment or raw CodeGraph/Codex output
