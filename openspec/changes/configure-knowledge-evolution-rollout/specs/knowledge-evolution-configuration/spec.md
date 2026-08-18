# Knowledge evolution configuration

## ADDED Requirements

### Requirement: Version 1 configuration migrates deterministically

The system SHALL parse version 1 with its original strict schema and return the equivalent immutable version 2 configuration.

#### Scenario: Partial version 1 input

- **WHEN** a valid partial version 1 configuration is loaded twice
- **THEN** both results are identical version 2 values and the caller input is unchanged

### Requirement: Unknown future configuration fails closed

The system SHALL reject configuration versions newer than version 2 and unknown fields at every strict schema boundary.

#### Scenario: Future version

- **WHEN** version 3 is loaded
- **THEN** the result is `UNSUPPORTED_CONFIG_VERSION` and no configuration becomes active

### Requirement: Safe defaults preserve Codex availability

The system SHALL default to Candidate Preview, disabled automatic publication, explicit CodeGraph initialization and fail-open knowledge-path behavior.

#### Scenario: Default configuration

- **WHEN** no operator override is supplied
- **THEN** compilation may create previews but cannot publish or block Codex

### Requirement: Online settings drive composed runtimes

The system SHALL apply a validated online configuration revision to the compilation and freshness schedulers and SHALL return an executable rollback closure.

#### Scenario: Activation rollback

- **WHEN** a new interval is activated and then rolled back
- **THEN** subsequent scheduling uses the previous interval without overlapping executions

### Requirement: Automatic publication is evidence-bound

The system SHALL evaluate automatic publication for one Candidate and deny it unless every configured project, kind, freshness and golden-evidence gate passes.

#### Scenario: Missing golden evidence

- **WHEN** automatic publication is configured but the request has no matching golden evidence identity
- **THEN** the Candidate remains a preview with an explicit denial reason
