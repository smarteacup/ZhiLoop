# codex-session-console Specification

## Purpose
TBD - created by archiving change build-zhiloop-console. Update Purpose after archive.
## Requirements
### Requirement: Read-only Codex session catalog
The system SHALL discover and list locally observable primary Codex sessions independently of whether they have been captured into the ZhiLoop Ledger, and MUST NOT modify Codex session state or transcript files.

#### Scenario: An uncaptured session exists
- **WHEN** a valid primary Codex session is present under an enabled source but has no Ledger cursor
- **THEN** the Console lists it as `DISCOVERED_NOT_CAPTURED`

#### Scenario: User views a session
- **WHEN** the user opens a catalog entry
- **THEN** the Console provides read-only metadata and never sends a message, renames, archives, deletes, or continues the Codex task

### Requirement: Stable session ordering and source diagnostics
The system SHALL group sessions by recent time, sort them by last activity with a deterministic tie breaker, and expose source availability, format version, capture completeness, and safe diagnostics.

#### Scenario: Two sessions have the same last activity time
- **WHEN** two catalog entries share `lastActivityAt`
- **THEN** their order is deterministically resolved by session ID

#### Scenario: A source format is unsupported
- **WHEN** the adapter encounters an unknown transcript or App Server format
- **THEN** the catalog marks the source unavailable or unsupported without altering the file or invalidating previously captured Ledger data

### Requirement: Session-level injection trace
The system SHALL persist and display the relationship `sessionId → turnId → injectionAttempt → runId → retrievalTraceId → knowledgeId@version` with actual delivery status.

#### Scenario: Active injection succeeds
- **WHEN** the UserPrompt Hook returns a Context Envelope to Codex successfully
- **THEN** the corresponding turn displays `INJECTED` and the exact delivered knowledge versions and token budget

#### Scenario: Retrieval succeeds but Hook times out
- **WHEN** retrieval completes but the Hook deadline expires before delivery
- **THEN** the turn displays `TIMEOUT` and does not claim the context was injected

### Requirement: Controlled manual capture
The system SHALL expose the existing session capture as dry-run followed by an idempotent commit bound to the preview revision and transcript identity.

#### Scenario: User previews capture
- **WHEN** the user requests a dry-run for a valid session
- **THEN** the Console shows projected, ignored, cursor, and error counts without mutating the Ledger or cursor

#### Scenario: Source changes after preview
- **WHEN** the transcript identity or preview revision changes before commit
- **THEN** the Sidecar rejects the stale commit and requires a new preview

### Requirement: Session extraction snapshots
The system SHALL allow a user to extract an immutable session snapshot, preview candidates, and submit them through the normal Scope and Evidence policy without publishing directly from the button click.

#### Scenario: Active session is extracted
- **WHEN** the transcript may receive later records
- **THEN** the extraction fixes source sequence, cursor, compiler version, and policy hash and marks the result `PARTIAL_SNAPSHOT`

#### Scenario: The same snapshot is retried
- **WHEN** an identical snapshot, compiler version, and policy hash are processed again
- **THEN** the operation is idempotent and does not create duplicate candidates or knowledge versions

### Requirement: Bidirectional session knowledge traceability
The system SHALL preserve source references sufficient to navigate from session/turn/event through snapshot and episode to knowledge version and back.

#### Scenario: User inspects extracted knowledge
- **WHEN** a knowledge version originated from a session snapshot
- **THEN** the API returns the originating session, turns, events, snapshot, and episode references even if UI deep-linking is delivered later

