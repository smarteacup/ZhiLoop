# knowledge-governance-console Specification

## Purpose
TBD - created by archiving change build-zhiloop-console. Update Purpose after archive.
## Requirements
### Requirement: Scoped knowledge browsing
The system SHALL list and filter knowledge by Scope, project, type, status, subject, symbol, keyword, Evidence verdict, version, and default retrieval eligibility.

#### Scenario: User filters project knowledge
- **WHEN** the user selects a project and eligible statuses
- **THEN** the Console returns only matching current knowledge versions and explains any excluded state

### Requirement: Knowledge provenance and version inspection
The system SHALL display Markdown content, version diff, Scope reasoning, assertions, Evidence, relations, lifecycle, source episodes, and usage records for each knowledge version.

#### Scenario: User inspects a current asset
- **WHEN** a knowledge asset has multiple versions
- **THEN** the Console identifies the current version and allows comparison with immutable historical versions

### Requirement: Versioned knowledge modification
The system SHALL apply ordinary knowledge edits by creating a new revision from an expected current version, previewing impact, and rerunning Schema, Scope, and Evidence checks before atomically changing current.

#### Scenario: Evidence no longer supports an edited claim
- **WHEN** an edit changes the claim beyond its supporting Evidence
- **THEN** the new revision becomes `PROPOSED` or `STALE` and does not retain the previous eligible status

#### Scenario: Current version changed during editing
- **WHEN** the submitted expected version is no longer current
- **THEN** the system rejects the write and returns a safe conflict requiring a refreshed diff

### Requirement: Reversible removal from retrieval
The system SHALL make “stop retrieval” the default removal action by creating a suppression or tombstone revision that exits default retrieval while preserving history, provenance, and audit, and SHALL support policy-valid restoration.

#### Scenario: User suppresses ordinary project knowledge
- **WHEN** the suppression revision commits successfully
- **THEN** the asset exits default retrieval within one second while remaining inspectable and restorable

#### Scenario: User restores suppressed knowledge
- **WHEN** the current content and Evidence still satisfy restoration policy
- **THEN** a new revision restores eligibility without deleting suppression history

### Requirement: High-risk governance remains gated
The system MUST NOT expose ordinary direct activation for GLOBAL promotion, Binding Rule suppression, RULE semantic change, or privacy purge before the high-risk policy and ACTIVE stage are enabled.

#### Scenario: User attempts high-risk governance early
- **WHEN** the required capability or policy gate is disabled
- **THEN** the Console shows a disabled action with a reason and the Sidecar rejects any forged command

### Requirement: Published knowledge and index consistency
The system SHALL record recoverable stages for Markdown publication, Registry current selection, and search index projection so failures are visible and replayable.

#### Scenario: Indexing fails after Markdown publication
- **WHEN** the new Markdown version is durable but index projection fails
- **THEN** the knowledge stage becomes `DEGRADED` with a retryable outbox record and never silently reports full success

