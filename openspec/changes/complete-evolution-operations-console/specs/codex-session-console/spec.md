## ADDED Requirements

### Requirement: Session evolution timeline
The system SHALL present the session's immutable extraction Snapshots, Candidates, Evidence, user commitments, Evolution decisions, published knowledge references, Repair Drafts, and injection attempts as a bounded traceable timeline.

#### Scenario: Candidate has not been published
- **WHEN** extraction produced a preview or policy-pending Candidate
- **THEN** the session view shows its true pending state and does not imply that Ledger capture or Candidate creation equals knowledge publication

### Requirement: Safe session knowledge refresh
The system SHALL allow the operator to refresh a session extraction preview and enqueue permitted compilation using transcript identity, snapshot revision, expected resource revision, and idempotency key while keeping the Codex session read-only.

#### Scenario: Transcript advances after preview
- **WHEN** new records appear before commit
- **THEN** the commit rejects the stale snapshot and requires a new preview without modifying the Codex transcript

### Requirement: Session source-chain navigation
The system SHALL return stable references for navigation between session, turn, Ledger event, Snapshot, Episode, Candidate, Evidence, knowledge version, and injection attempt even when a target has been superseded.

#### Scenario: Historical knowledge version is opened
- **WHEN** a source link points to a superseded version
- **THEN** the Console opens that immutable version and identifies the current version separately
