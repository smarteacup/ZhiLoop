## ADDED Requirements

### Requirement: Knowledge work has an explicit bounded execution mode
The system SHALL execute knowledge work in `PREVIEW_ONLY`, `POLICY_EVALUATION`, or `SAFE_AUTO_PUBLICATION` mode and SHALL default an omitted mode to `PREVIEW_ONLY`.

#### Scenario: Caller omits execution mode
- **WHEN** a caller runs new or resumable knowledge work without an execution mode
- **THEN** the Worker SHALL persist candidates and policy preview but SHALL NOT write Markdown, Registry, or Index state

#### Scenario: Policy evaluation is requested
- **WHEN** a caller uses `POLICY_EVALUATION`
- **THEN** the Worker SHALL evaluate all currently implemented non-publication stages and SHALL stop before publication

### Requirement: Publication requires a stable authorization
The system SHALL enter publication stages only in `SAFE_AUTO_PUBLICATION` mode with a valid explicit-commit or safe-policy authorization.

#### Scenario: Publication mode has no authorization
- **WHEN** `SAFE_AUTO_PUBLICATION` is requested without a valid authorization
- **THEN** the Worker SHALL reject the run before any publication side effect

#### Scenario: Explicit P2 commit resumes a preview
- **WHEN** a durable P2 Commit Job provides its stable idempotency identity as explicit authorization
- **THEN** the Worker SHALL resume the same checkpoint, skip successful Preview stages, and execute each publication stage at most once logically

#### Scenario: Authorization changes during partial publication
- **WHEN** a publication stage has started and a retry supplies a different authorization
- **THEN** the Worker SHALL reject the retry and SHALL preserve the existing checkpoint and published outbox progress

### Requirement: Lower privilege calls do not inherit publication ability
The system SHALL use the execution mode of the current invocation as its capability ceiling.

#### Scenario: Preview is called after a publication-capable retryable run
- **WHEN** a work checkpoint contains a publication authorization but the next invocation uses `PREVIEW_ONLY`
- **THEN** the Worker SHALL NOT resume Markdown, Registry, or Index stages

### Requirement: Execution progress remains backward compatible and observable
The system SHALL read existing schemaVersion 1 checkpoints without mode fields and SHALL record the most recent execution mode and accepted publication authorization on subsequent mutable runs.

#### Scenario: Legacy awaiting-commit checkpoint is resumed
- **WHEN** an old checkpoint has completed candidate policy but lacks execution-mode metadata
- **THEN** a Preview invocation SHALL remain awaiting commit and a properly authorized publication invocation SHALL be allowed to resume

#### Scenario: Completed legacy checkpoint is replayed
- **WHEN** a completed old checkpoint is loaded
- **THEN** the Worker SHALL return it without repeating any side effect

### Requirement: Automatic compilation remains preview only
The automatic session compilation adapter MUST NOT possess or synthesize publication authorization.

#### Scenario: Automatic candidate is publishable
- **WHEN** automatic compilation produces a candidate whose policy would permit publication
- **THEN** the Preview Job SHALL remain awaiting explicit commit and no formal knowledge version SHALL be written
