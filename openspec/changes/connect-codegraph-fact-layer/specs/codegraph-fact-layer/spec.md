## ADDED Requirements

### Requirement: Code intelligence is vendor neutral

The system SHALL expose normalized code facts without CodeGraph node IDs, database fields, or raw response payloads.

#### Scenario: Symbol query succeeds

- **WHEN** CodeGraph returns one or more matching nodes
- **THEN** the adapter returns only bounded symbol, kind, path, line, language, and export facts

### Requirement: Capability negotiation is safe

The adapter SHALL distinguish READY, NOT_CONFIGURED, INCOMPATIBLE, and UNAVAILABLE and SHALL NOT initialize or mutate a repository.

#### Scenario: Repository is not initialized

- **WHEN** CodeGraph status reports `initialized: false`
- **THEN** capability is NOT_CONFIGURED and no query or init command runs

#### Scenario: Binary version is unsupported

- **WHEN** the installed version is outside supported 0.9.x
- **THEN** capability is INCOMPATIBLE and facts are not queried

### Requirement: Structural facts are bounded and fresh by fingerprint

Every operation SHALL have a timeout and result limit. Cached facts SHALL be keyed by project fingerprint and SHALL not survive a fingerprint change.

#### Scenario: Project fingerprint changes

- **WHEN** the same symbol is queried with a new project fingerprint
- **THEN** CodeGraph is queried again

### Requirement: Symbol Evidence uses real structural facts

The system SHALL map exact CodeGraph symbol facts to SYMBOL_EXISTS verification observations.

#### Scenario: Exact symbol and path exist

- **WHEN** a READY CodeGraph index returns the requested symbol at the optional requested path
- **THEN** the observation is SUPPORTED and sourceRef contains only normalized source coordinates

#### Scenario: CodeGraph is unavailable

- **WHEN** capability is not READY
- **THEN** the observation is UNKNOWN and knowledge cannot be auto-promoted from that assertion
