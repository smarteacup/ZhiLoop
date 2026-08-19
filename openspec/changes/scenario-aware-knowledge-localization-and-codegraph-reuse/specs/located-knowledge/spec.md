## ADDED Requirements

### Requirement: Authoritative knowledge locator
The system SHALL attach a structured locator to every newly compiled project-bound Candidate and SHALL source repository, project, branch, Git commit, and dirty state from the authoritative project resolver rather than model output.

#### Scenario: Project episode is compiled
- **WHEN** an Episode has a Git-backed project context and the model returns a valid scenario hint
- **THEN** the Candidate contains the authoritative project coordinates and observed revision plus a deterministic scenario ID

#### Scenario: Model attempts to provide authoritative coordinates
- **WHEN** model output contains repository, branch, commit, or CodeGraph revision values outside the allowed scenario hint
- **THEN** those values are rejected or ignored and cannot replace resolver-owned coordinates

### Requirement: Explicit applicability coordinates
The locator SHALL expose a branch applicability policy, scenario identity, module paths, symbols, entry points, task intents, applicability, and non-applicability sufficient to decide where the knowledge may be used.

#### Scenario: User inspects a code conclusion
- **WHEN** a Candidate or Knowledge Asset is displayed
- **THEN** the project, observed branch/commit, branch policy, scenario, entry points, symbols, applicability, and exclusions are available without interpreting the body

### Requirement: Claim-mode-aware evidence gate
The system MUST classify project Candidates as `CURRENT_STATE`, `USER_DECISION`, or `FUTURE_REQUIREMENT` and MUST apply evidence semantics appropriate to that mode.

#### Scenario: Current implementation fact is absent
- **WHEN** a CURRENT_STATE Candidate has a valid current-code assertion that is refuted
- **THEN** publication is blocked with `ASSERTION_REFUTED`

#### Scenario: Accepted future design is not implemented yet
- **WHEN** a USER_DECISION or FUTURE_REQUIREMENT describes a future code change and current code lacks that change
- **THEN** the Candidate remains accepted/proposed as `PENDING_IMPLEMENTATION` rather than being marked factually refuted

#### Scenario: Generated assertion cannot test the claim
- **WHEN** an assertion references an invented key, unresolved path, or unavailable evaluator
- **THEN** it is reported as invalid or unknown and cannot be used as contradicting evidence

### Requirement: Locator completeness publication gate
The system MUST NOT publish a new project-bound CURRENT_STATE knowledge version for automatic retrieval unless its project, scenario, branch/commit compatibility and required evidence are resolved.

#### Scenario: Branch is unknown
- **WHEN** a new current-code Candidate lacks an authoritative branch or commit
- **THEN** it remains PROPOSED with a locator diagnostic and is excluded from automatic injection

### Requirement: Legacy locator compatibility
The system SHALL continue reading legacy knowledge without a locator and SHALL expose a non-destructive localization draft instead of inventing historical revision coordinates.

#### Scenario: Legacy project knowledge is loaded
- **WHEN** a schema-v1 asset has project Scope but no locator
- **THEN** it remains inspectable and manually searchable while current-code automatic injection is suppressed until localization is verified
