## ADDED Requirements

### Requirement: Evolution matching is bounded and deterministic

The system SHALL classify each Candidate from its resolved scope, exact current identity, at most five search candidates, and trusted correction drafts. Exact identity SHALL take precedence over ranked retrieval, and retrieval rank alone SHALL NOT determine a relationship.

#### Scenario: New topic is stored

- **WHEN** no exact or deterministic related target exists
- **THEN** the decision is `STORE` with no target version

#### Scenario: Duplicate is skipped

- **WHEN** an exact or deterministically related target has the same normalized knowledge content
- **THEN** the decision is `SKIP` and names that target version

#### Scenario: Search response exceeds its bound

- **WHEN** the lookup supplies more than five possible targets
- **THEN** evolution matching fails closed instead of truncating silently

### Requirement: Evolution uncertainty is explicit

The system SHALL represent unresolved evolution as `PENDING`, not as STORE or SKIP. Semantic arbitration, when configured, SHALL be invoked at most once and SHALL only reference supplied target versions.

#### Scenario: Similar target cannot be classified deterministically

- **WHEN** deterministic signals show a plausible relationship but not its action and no semantic arbiter is configured
- **THEN** the result is `PENDING`, requires confirmation, and cannot publish

#### Scenario: Semantic adapter fails

- **WHEN** the optional semantic arbiter throws or returns an invalid target
- **THEN** the result remains `PENDING` with a bounded reason code

### Requirement: Evolution restricts publication

The Worker SHALL evaluate evolution before Evidence Policy and SHALL create outbox items only for decided STORE, SUPPLEMENT, SUPERSEDE, or SCOPE_SPLIT actions that Evidence Policy also permits.

#### Scenario: Contradiction blocks publication

- **WHEN** a Candidate contradicts a current target
- **THEN** target IDs are passed to Evidence Policy, the policy asks for confirmation, and no outbox item is created

#### Scenario: Supplement preserves lineage

- **WHEN** a Candidate supplements an exact current target and Evidence Policy permits publication
- **THEN** the Worker creates exactly the immediate next version with preserved lineage metadata and a relation to the previous version

#### Scenario: Scope split creates a narrow lineage

- **WHEN** related content exists only under a different scope and the Candidate's resolved scope is narrower
- **THEN** a new identity is created under the resolved scope and links to the related target

### Requirement: Evolution is replayable and traceable

The system SHALL checkpoint one decision per Candidate with stable target ordering, reason codes, confidence, and confirmation requirement.

#### Scenario: Work is replayed

- **WHEN** a completed evolution stage is replayed with the same immutable work identity
- **THEN** no Registry lookup or semantic call is repeated and the persisted decisions are returned unchanged

#### Scenario: Legacy work has a downstream outbox

- **WHEN** a legacy in-flight checkpoint lacks the evolution stage but already completed policy evaluation
- **THEN** the new decision stage may be populated but the existing downstream outbox is not rewritten
