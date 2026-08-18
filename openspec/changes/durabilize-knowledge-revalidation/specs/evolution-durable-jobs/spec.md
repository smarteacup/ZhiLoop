## ADDED Requirements

### Requirement: Typed durable evolution jobs
The system SHALL persist every supported evolution orchestration request before execution with a strict job type, canonical immutable input, stable idempotency key, bounded attempt count, and restart-safe status.

#### Scenario: Duplicate enqueue reuses the job
- **WHEN** the same canonical compilation or revalidation request is enqueued more than once
- **THEN** the system returns the same durable job and does not create another active job or side effect

#### Scenario: Conflicting idempotency input is rejected
- **WHEN** an idempotency key is reused with a different canonical input
- **THEN** the system rejects the request as a non-retryable idempotency conflict

#### Scenario: Future handler is not configured
- **WHEN** a caller attempts to enqueue repair, CodeGraph initialization, or migration before its handler is registered
- **THEN** the system reports `NOT_CONFIGURED` and does not persist an unexecutable job

### Requirement: Lease and fencing safety
The system MUST claim jobs with an attempt identity, worker identity, expiring lease, and monotonically increasing fencing token, and MUST validate the active lease immediately before every external side effect or checkpoint.

#### Scenario: Expired lease is recovered
- **WHEN** a Sidecar terminates while a job lease is active and another worker starts after expiry
- **THEN** the new worker resumes from the last durable checkpoint with a higher fencing token

#### Scenario: Stale worker cannot write
- **WHEN** an old attempt tries to checkpoint or apply an effect after its lease was replaced
- **THEN** the write is rejected and the current attempt remains authoritative

### Requirement: Idempotent effect replay
Every compilation dispatch, Verification run, Freshness transition, and Git baseline acknowledgement SHALL use a deterministic effect identity that returns the existing result after a crash instead of duplicating the effect.

#### Scenario: Crash after effect before success
- **WHEN** a handler applies an effect and terminates before the job is marked successful
- **THEN** replay observes the existing effect, completes the job, and creates no duplicate Candidate, Verification run, Freshness event, or acknowledgement

### Requirement: Bounded retries and lifecycle
Evolution jobs SHALL record attempt count, maximum attempts, failure code, retryability, next-attempt time, progress, and terminal status, and the Sidecar SHALL stop workers and close stores deterministically.

#### Scenario: Retryable failure waits and recovers
- **WHEN** a handler returns a retryable failure before its attempt budget is exhausted
- **THEN** the job enters retry-wait with a bounded next-attempt time and is claimable after that time

#### Scenario: Attempt budget is exhausted
- **WHEN** retryable failures consume the configured maximum attempts
- **THEN** the job becomes permanently failed with the original failure classification retained

#### Scenario: Store is unavailable
- **WHEN** the evolution job store cannot be opened or read safely
- **THEN** the capability is `DEGRADED`, background work stops, current code facts fail closed, and Codex interaction remains available

### Requirement: Durable compilation dispatch
Automatic knowledge compilation SHALL enqueue a `KNOWLEDGE_COMPILE` outer job while retaining the existing immutable Snapshot and P2 stage checkpoint as the detailed execution record.

#### Scenario: Compilation replay is already dispatched
- **WHEN** the outer job replays after the same P2 preview job was durably created
- **THEN** it reuses that preview job and does not create duplicate Candidates or publication work

### Requirement: Privacy-safe job read model
The durable job read model SHALL expose bounded operational metadata and SHALL NOT persist or expose prompt text, knowledge bodies, command output, environment variables, or raw Git/CodeGraph output.

#### Scenario: Job diagnostics are projected
- **WHEN** an operator reads queued, running, retrying, succeeded, or failed jobs
- **THEN** each item includes job type/status, revision, progress, attempt counts, next attempt, stable failure classification, project/entity reference, and checkpoint phase without content payloads
