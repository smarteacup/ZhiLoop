## ADDED Requirements

### Requirement: Knowledge evolution evidence view
The system SHALL display each knowledge version's Recipe, Verification Runs, Anchors, Freshness state/history, Evolution decisions, Repair Drafts, source chain, and related durable jobs from authoritative bounded Read Models.

#### Scenario: Knowledge is excluded as stale
- **WHEN** a current knowledge version has a refuting Verification Run
- **THEN** the detail view identifies the exact assertion, Evidence revision, Freshness transition, exclusion reason, and linked Repair Draft or explains why no draft exists

### Requirement: Controlled knowledge revalidation
The system SHALL preview affected assertions and enqueue revalidation using the current knowledge/Freshness revision and idempotency key, without running a probe from a read request.

#### Scenario: Operator requests revalidation
- **WHEN** the current version has a valid Recipe and project capability
- **THEN** the command returns a durable job reference and progress is read from persisted attempts and checkpoints

#### Scenario: Capability cannot satisfy the Recipe
- **WHEN** CodeGraph or another required verifier is unavailable
- **THEN** the preview explains the missing capability and commit remains disabled

### Requirement: Repair Draft inspection and submission
The system SHALL show the immutable conflict basis, old knowledge reference, live-fact evidence, proposed candidate, inherited authorization ceiling, and submission state for a Repair Draft, and SHALL submit it only through the normal Candidate/Evolution/Policy path.

#### Scenario: Repair proposal exceeds authorization
- **WHEN** a draft proposes broader Scope or authority than the source knowledge permits
- **THEN** submission is blocked with a stable reason and no knowledge version is created

