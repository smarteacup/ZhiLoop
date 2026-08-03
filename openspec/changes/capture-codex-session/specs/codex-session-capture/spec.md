## ADDED Requirements

### Requirement: Exact local session discovery
The system SHALL locate a requested Codex transcript by comparing the exact requested session ID with `session_meta.payload.id` in the bounded first record of regular rollout JSONL files beneath the configured Codex sessions root, falling back to `session_id` only when `id` is absent. The system MUST NOT select a file solely because its path, conversation content, or child rollout `session_id` contains the requested ID.

#### Scenario: One matching transcript exists
- **WHEN** exactly one regular transcript below the configured root declares the requested session ID
- **THEN** the system selects that transcript and reports its canonical path

#### Scenario: No matching transcript exists
- **WHEN** no inspected transcript declares the requested session ID
- **THEN** the system fails with `SESSION_NOT_FOUND` without mutating ledger or cursor state

#### Scenario: Multiple matching transcripts exist
- **WHEN** more than one transcript declares the requested session ID
- **THEN** the system fails with `SESSION_AMBIGUOUS` without choosing one implicitly

#### Scenario: Child rollout references the parent session
- **WHEN** a child or subagent rollout has its own `payload.id` and carries the requested parent ID in `payload.session_id`
- **THEN** the system does not treat the child rollout as a duplicate primary transcript

#### Scenario: Invalid session selector
- **WHEN** a requested session selector is empty, oversized, contains a path separator, or contains a NUL byte
- **THEN** the system rejects it before filesystem discovery

### Requirement: Bounded and safe transcript access
The system SHALL inspect only bounded regular JSONL files beneath the configured real sessions root and MUST reject symlinks, path escapes, oversized metadata lines, excessive tree depth, or excessive candidate counts with stable diagnostics.

#### Scenario: Candidate is a symbolic link
- **WHEN** a candidate path below the sessions root is a symbolic link
- **THEN** the system does not follow or import the candidate

#### Scenario: Discovery limit is exceeded
- **WHEN** bounded discovery exceeds its configured depth or candidate-file limit
- **THEN** the system stops and reports `DISCOVERY_LIMIT_EXCEEDED` without partial selection

### Requirement: Dry-run projection
The CLI SHALL support `zhiloop capture --session <id> --dry-run` and SHALL return the transcript path, projected event counts by type, ignored-record count, batches, and final projected cursor without writing events or ingestion cursors.

#### Scenario: Preview a historical session
- **WHEN** the user requests dry-run capture for a valid supported transcript
- **THEN** the system returns a successful projection and the ledger event count and persisted ingestion cursor remain unchanged

### Requirement: Durable incremental capture
The system SHALL import supported transcript records through the running Sidecar, append canonical events in bounded batches, and persist an anchored source cursor only after the corresponding batch is durably appended.

#### Scenario: First capture
- **WHEN** a supported transcript has no persisted cursor
- **THEN** the system imports from byte zero, appends its canonical events, and commits the final safe cursor

#### Scenario: Capture an active session again
- **WHEN** a transcript has complete records after its persisted cursor
- **THEN** the system imports only the newly readable suffix and advances the cursor

#### Scenario: Crash boundary is replayed
- **WHEN** events were appended but their cursor was not committed before interruption
- **THEN** retrying capture reports those deterministic events as duplicates and safely commits the cursor

#### Scenario: Transcript becomes incompatible with cursor
- **WHEN** the transcript is replaced, truncated, or changes before the anchored cursor
- **THEN** the system reports the adapter diagnostic and does not silently reset or advance the cursor

### Requirement: Idempotent repeated capture
Repeated capture of an unchanged transcript SHALL NOT create duplicate ledger rows and SHALL return explicit appended and duplicate counts.

#### Scenario: Immediate second capture
- **WHEN** a successfully captured closed transcript is captured again without file changes
- **THEN** the command succeeds with zero appended events and leaves the ledger count unchanged

### Requirement: Single-writer Sidecar integration
The deployment CLI SHALL request capture through the owner-only Sidecar transport and MUST NOT open the production ledger for writes. The Sidecar SHALL serialize capture mutations while preserving the fail-open Hook capture path.

#### Scenario: Sidecar is unavailable
- **WHEN** the user invokes non-dry-run capture while the Sidecar cannot be reached within the capture timeout
- **THEN** the CLI exits non-zero with a stable sidecar-unavailable diagnostic and does not attempt direct SQLite writes

#### Scenario: Hook arrives during a long capture
- **WHEN** Hook input arrives while a session import is processing
- **THEN** the Hook remains bounded by its existing deadline and is spooled independently of the capture request

### Requirement: Privacy-safe and unambiguous reporting
Capture reports and diagnostics SHALL omit raw prompts, assistant messages, tool payloads, and absolute content excerpts. The result SHALL state whether downstream knowledge compilation occurred.

#### Scenario: Capture succeeds in the current SHADOW deployment
- **WHEN** canonical events are appended but no production knowledge compiler is composed
- **THEN** the report returns `knowledgeCompiled: false` and does not claim that knowledge is ready for injection

#### Scenario: Transcript record is malformed
- **WHEN** transcript parsing fails after encountering conversation content
- **THEN** logs and CLI diagnostics contain only a stable code and positional metadata, not the malformed raw line
