## ADDED Requirements

### Requirement: Observed-project CodeGraph capability
The system SHALL expose each observed project's canonical repository identity, CodeGraph availability, version, capability revision, latest job, and stable diagnostic reason without initializing or mutating the repository during a read.

#### Scenario: Project has not been initialized
- **WHEN** an observed repository has no usable `.codegraph` index
- **THEN** the Console reports the capability as unavailable with an initialization action and the read creates no directory or job

#### Scenario: Project identity does not match
- **WHEN** a caller requests CodeGraph state using another project's identifier
- **THEN** the Sidecar rejects the request without disclosing the canonical path

### Requirement: Safe initialization preview
The system SHALL produce an immutable, expiring CodeGraph initialization preview from a server-observed project root and SHALL reject filesystem root, user home, non-directory, unobserved, project-mismatched, or symlink-escaping targets.

#### Scenario: Valid project preview
- **WHEN** an authorized local operator previews an observed project
- **THEN** the response contains the normalized root, target `.codegraph` directory, tool version, current capability, risks, preview revision, repository identity, and expiry without writing the repository

#### Scenario: Forged path is submitted
- **WHEN** a client attempts to supply or resolve a target outside the observed repository
- **THEN** the Sidecar returns a non-retryable stable reason code and creates neither a preview nor a job

### Requirement: Durable explicit CodeGraph initialization
The system SHALL create a `CODEGRAPH_INITIALIZE` Durable Job only from a valid preview commit carrying CSRF proof, expected revision, repository identity, and idempotency key, and SHALL execute only fixed non-shell CodeGraph arguments.

#### Scenario: Initialization succeeds
- **WHEN** the worker initializes the repository and status, version, and bounded query smoke tests all succeed
- **THEN** the job succeeds and a new READY capability revision references all three evidence records

#### Scenario: Commit is repeated
- **WHEN** the same initialization commit is submitted again with the same idempotency key
- **THEN** the Sidecar returns the original job identity without starting another process

#### Scenario: Preview became stale
- **WHEN** repository identity or capability revision changes after preview
- **THEN** the commit is rejected as stale and is not automatically replayed

### Requirement: Explainable initialization progress and failure
The system SHALL expose bounded initialization attempts with status, attempt/maxAttempts, timing, retryability, nextAttemptAt, reason code, safe message, suggested action, and redacted smoke-test evidence.

#### Scenario: CodeGraph process times out
- **WHEN** initialization exceeds its configured deadline
- **THEN** the process group is terminated, output is bounded, the attempt records a retryable timeout reason, and Codex handling remains unaffected

