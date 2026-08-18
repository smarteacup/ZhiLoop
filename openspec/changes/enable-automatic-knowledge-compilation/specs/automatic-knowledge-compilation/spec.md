## ADDED Requirements

### Requirement: Eligible captured sessions are compiled automatically
The system SHALL scan the bounded session catalog and SHALL consider only source-available sessions whose capture status is current and whose Ledger contains uncompiled events.

#### Scenario: New turns reach the threshold
- **WHEN** a captured-current session has at least the configured minimum number of new events and new effective turns since its last compiled sequence
- **THEN** the system SHALL dispatch one automatic Candidate Preview for the current immutable source version

#### Scenario: Idle session is below the turn threshold
- **WHEN** a captured-current session has enough new events, has been idle for the configured duration, and has not reached the turn threshold
- **THEN** the system SHALL dispatch one automatic Candidate Preview

#### Scenario: Closed session becomes immediately eligible
- **WHEN** the newest uncompiled Ledger event closes the session and the minimum event threshold is met
- **THEN** the system SHALL dispatch one automatic Candidate Preview without waiting for the idle duration

#### Scenario: Active session reaches maximum wait
- **WHEN** a session continues receiving events but the oldest pending uncompiled revision has waited for the configured maximum duration
- **THEN** the system SHALL dispatch one automatic Candidate Preview for the bounded current revision

#### Scenario: Capture is not current
- **WHEN** a session source is unavailable, unsupported, partially captured, or changes during dispatch validation
- **THEN** the system SHALL NOT create a stale Snapshot and SHALL defer or reject that session with a stable reason code

### Requirement: Automatic compilation is idempotent and concurrency safe
The system SHALL bind automatic compilation identity to the session, immutable source revision, Ledger sequence, compiler version, prompt version, policy hash, configuration hash, and PREVIEW_ONLY execution mode.

#### Scenario: Repeated scans observe the same revision
- **WHEN** multiple scans observe the same session and immutable pipeline identity
- **THEN** at most one Snapshot and one Candidate Preview job SHALL exist for that identity

#### Scenario: Manual extraction races automatic extraction
- **WHEN** a manual Preview and an automatic Preview target the same immutable session range concurrently
- **THEN** both callers SHALL converge on the same existing Snapshot and Preview job without duplicate candidate publication

#### Scenario: Source changes after eligibility decision
- **WHEN** the source or Ledger revision changes before the automatic dispatcher creates the Snapshot
- **THEN** the dispatcher SHALL fail the stale attempt closed and a later scan SHALL recompute eligibility from current state

### Requirement: Compilation progress survives restart
The system SHALL persist one versioned Compare-And-Swap checkpoint per session and SHALL resume scanning without losing or overwriting newer progress after process restart.

#### Scenario: Sidecar restarts after a job was queued
- **WHEN** the Sidecar restarts with a checkpoint that references an already queued Preview job
- **THEN** the scheduler SHALL retain the queued progress and SHALL NOT enqueue a duplicate job

#### Scenario: Concurrent checkpoint writers conflict
- **WHEN** two scheduler operations attempt to update the same checkpoint version
- **THEN** only one write SHALL commit and the losing operation SHALL reload and recompute within the configured bounded retry limit

#### Scenario: One checkpoint is invalid
- **WHEN** a stored checkpoint cannot be validated
- **THEN** the affected session SHALL be reported as failed without blocking Codex or other sessions

### Requirement: Automatic compilation stops at Candidate Preview
The automatic compilation capability MUST NOT expose or invoke Policy Commit or knowledge publication operations.

#### Scenario: Candidate policy recommends publication
- **WHEN** an automatically compiled candidate receives a policy decision that would allow publication
- **THEN** the automatic run SHALL remain at Candidate Preview or awaiting explicit commit and SHALL NOT write a new formal knowledge version

#### Scenario: Automatic configuration is malformed
- **WHEN** an operator supplies a configuration value outside its accepted bound
- **THEN** the system SHALL reject the new configuration and SHALL keep the last valid runtime configuration

### Requirement: Scheduling is bounded and non-overlapping
The system SHALL process a configured maximum number of sessions per run, SHALL run at most one scan concurrently, and SHALL schedule the next scan only after the current scan completes.

#### Scenario: A scan takes longer than its interval
- **WHEN** a scan is still running when another trigger occurs
- **THEN** the trigger SHALL join or reuse the in-flight scan instead of starting an overlapping scan

#### Scenario: Catalog exceeds the per-run limit
- **WHEN** eligible catalog pages contain more sessions than the configured maximum
- **THEN** the run SHALL stop at the bound, report bounded coverage, and continue from durable session state on later runs

### Requirement: Runtime state is observable without content leakage
The system SHALL expose whether automatic compilation is ready, stopped, degraded, or disabled and SHALL report bounded aggregate outcomes and stable reason codes without including conversation bodies.

#### Scenario: A scan completes with mixed outcomes
- **WHEN** one scan queues, defers, retries, and rejects different sessions
- **THEN** the runtime report SHALL include aggregate counts, timestamps, bounded status, and reason codes but SHALL NOT contain Ledger or prompt content
