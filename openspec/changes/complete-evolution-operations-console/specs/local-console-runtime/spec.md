## ADDED Requirements

### Requirement: Unified evolution operations snapshot
The system SHALL expose a bounded operations snapshot for Compile, Revalidate, Repair, CodeGraph, Freshness, Migration, Alert, and Injection areas with truthful section revision, observation time, consistency state, and capability reason.

#### Scenario: Section revisions differ
- **WHEN** one backing store advances while the snapshot is being composed
- **THEN** the response marks mixed revision state and the browser does not invent a single atomic revision

### Requirement: Safe operation command envelope
The system SHALL require every state-changing Console operation to carry an authenticated local session, valid Origin and CSRF proof, resource project identity, expected resource revision, idempotency key, and correlation identifier.

#### Scenario: Read-only view is opened
- **WHEN** an operator navigates through overview, session, knowledge, injection, CodeGraph, migration, or alert read views
- **THEN** Ledger sequence, Candidate count, Knowledge revision, Job count, and persisted operation state remain unchanged

#### Scenario: Preview refresh encounters a conflict
- **WHEN** a side-effect-free preview is stale
- **THEN** the client may refresh the resource revision and regenerate the preview once without committing an effect

#### Scenario: Commit encounters a conflict
- **WHEN** a state-changing commit is stale
- **THEN** the client displays the conflict and never automatically resubmits the commit

### Requirement: Bounded live operation refresh
The system SHALL use SSE only as an invalidation signal and SHALL maintain at most one abortable detail request and one bounded fallback timer per mounted page.

#### Scenario: Page is unmounted during a running job
- **WHEN** the operator changes routes before the next refresh
- **THEN** the request is aborted, the timer is cleared, and no later state update or polling loop is created

#### Scenario: Live invalidation is unavailable
- **WHEN** SSE disconnects outside its retained resume window
- **THEN** the page performs a bounded resync and exponentially backed-off polling that stops after the configured failure limit

### Requirement: Complete localized diagnostics
The system SHALL display every known operational status and reason in Chinese while preserving the original enum or reason code in title and diagnostic fields, and SHALL render retryability, attempts, next retry time, and suggested action when present.

#### Scenario: Unknown future enum is received
- **WHEN** the server returns an enum not known by the current client
- **THEN** the client displays a safe Chinese fallback and preserves the exact raw enum for diagnosis

