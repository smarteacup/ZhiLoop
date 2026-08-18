## ADDED Requirements

### Requirement: Production verification is shared and complete
The system SHALL route Candidate policy and Freshness assertion verification through one production verification service, and every domain Assertion Kind SHALL have a registered verifier.

#### Scenario: Candidate contains mixed assertion kinds
- **WHEN** Candidate policy requests user, symbol, file, dependency, configuration, command, test, call-path, impact, and cross-project assertions
- **THEN** the service returns exactly one typed result for every requested assertion through registered verifiers

#### Scenario: Production composition starts
- **WHEN** the Sidecar composes the Knowledge Worker and Freshness runtime
- **THEN** neither runtime uses a synthetic all-non-user-UNKNOWN verifier or a private symbol-only verifier

### Requirement: Verification batches are revision-bound
The service SHALL bind a batch to one canonical project, observed time, code revision, and optional graph revision and SHALL reject mixed or changed revision output before returning results.

#### Scenario: Graph revision changes during verification
- **WHEN** CodeGraph reports a different index revision after graph probes complete
- **THEN** the batch fails retryably and no run summary is committed as successful

#### Scenario: Probe result belongs to another project
- **WHEN** a probe result references a project other than the request project
- **THEN** the whole batch is rejected before policy or Freshness state changes

### Requirement: Local evidence is read-only and repository-contained
File, configuration, and dependency probes SHALL read only bounded regular files whose canonical paths remain beneath the canonical repository root and SHALL never mutate the repository.

#### Scenario: Symlink escapes the repository
- **WHEN** an assertion path resolves through a symbolic link outside the repository root
- **THEN** verification returns a non-retryable error result and the external file is not read

#### Scenario: Parser capability is unavailable
- **WHEN** REGEX, STRUCTURAL, manifest, or configuration semantics cannot be safely evaluated
- **THEN** the assertion is UNKNOWN and is not evaluated with weaker text matching

### Requirement: Session evidence comes only from the immutable Snapshot
User statement, command, and test probes SHALL derive observations only from the bounded loaded Ledger Snapshot used to compile the Candidate and SHALL NOT execute commands or tests.

#### Scenario: Matching successful test is in the Snapshot
- **WHEN** the exact test and command identity with successful status is present in the loaded Snapshot range
- **THEN** TEST_PASSED is SUPPORTED with a source reference to the bounded observation identity

#### Scenario: Test is absent during Freshness revalidation
- **WHEN** Freshness revalidates TEST_PASSED without a new matching Snapshot observation
- **THEN** the result is UNKNOWN and no test process is started

### Requirement: Cross-project verification counts independent current proof
`CROSS_PROJECT_VERIFIED` SHALL count distinct canonical projects with current integrity-valid supporting verification and SHALL NOT count worktrees or branches of one repository as separate projects.

#### Scenario: Required independent projects are current
- **WHEN** at least `minimumProjects` distinct projects currently support the subject and all code-related proof is FRESH
- **THEN** CROSS_PROJECT_VERIFIED is SUPPORTED

#### Scenario: Store or identity is unavailable
- **WHEN** project independence or current proof cannot be established
- **THEN** CROSS_PROJECT_VERIFIED is UNKNOWN rather than REFUTED or SUPPORTED

### Requirement: Verification recipes and runs are durable and content-free
The system SHALL persist version-bound integrity-checked recipes and immutable idempotent run summaries without conversation text, command output, file content, or Knowledge body.

#### Scenario: Same recipe version is replayed
- **WHEN** the same asset version, recipe version, and assertion payload are projected again
- **THEN** the write is idempotent and creates no duplicate row

#### Scenario: Same run request has different output
- **WHEN** an existing request ID is reused with a different result summary or revision
- **THEN** the store fails closed and preserves the original run

### Requirement: Verification failure cannot block Codex or authorize publication
Unavailable, timed-out, or unsupported evidence sources SHALL produce bounded UNKNOWN/ERROR diagnostics, SHALL NOT authorize status promotion, and SHALL NOT prevent the Codex Hook from returning.

#### Scenario: CodeGraph is unavailable but local facts are readable
- **WHEN** a mixed batch contains graph and local assertions while CodeGraph is unavailable
- **THEN** graph assertions are UNKNOWN, local assertions are independently evaluated, and no unavailable assertion authorizes publication

