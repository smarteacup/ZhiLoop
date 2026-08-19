## ADDED Requirements

### Requirement: Side-effect-free migration preview
The system SHALL expose a version-bound dry-run for historical code knowledge with aggregate counts, stable cursor, bounded item pages, classification, target derivations, skip/failure reasons, and source/target hashes without modifying knowledge, Recipe, Freshness, migration, or job stores.

#### Scenario: Operator generates a preview
- **WHEN** a project contains eligible and ineligible legacy knowledge
- **THEN** the Console displays separate migratable, skipped, conflicted, and failed counts and allows each bounded item to be inspected

### Requirement: Controlled migration commit and progress
The system SHALL commit a migration only from an unexpired matching preview with CSRF proof, expected registry revision, and idempotency key, and SHALL display durable checkpoint progress from the migration store.

#### Scenario: Migration resumes after interruption
- **WHEN** a worker stops after a durable item checkpoint
- **THEN** a later attempt resumes after that item and the Console never reports already completed items as newly applied

#### Scenario: Registry changed after preview
- **WHEN** current knowledge revisions differ before the first migration effect
- **THEN** the commit fails with a revision conflict and no migration derivation is written

### Requirement: Safe migration rollback
The system SHALL preview and execute rollback by migration identity in reverse application order while preserving original knowledge and refusing to delete derivations superseded by later activity.

#### Scenario: Later Freshness activity exists
- **WHEN** a migrated asset has later non-migration Freshness events
- **THEN** rollback retains that asset's derivations, records a conflict item, and explains the required manual action

### Requirement: Bounded migration failure diagnostics
The system SHALL render every failed or skipped migration item with a Chinese explanation, original stable reason code, retryability, attempt information where applicable, and a suggested action without exposing knowledge body in list responses.

#### Scenario: Item response reaches its bound
- **WHEN** more items exist than the maximum page size
- **THEN** the response returns a tamper-resistant continuation cursor and the Console clearly marks the page as bounded

