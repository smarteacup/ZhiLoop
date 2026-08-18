## MODIFIED Requirements

### Requirement: Structural facts are bounded and fresh by fingerprint
Every operation SHALL have a timeout and result limit. Cached facts SHALL be keyed by project fingerprint and SHALL not survive a fingerprint change. A READY capability used for revision-bound verification SHALL include a normalized index revision distinct from the provider version.

#### Scenario: Project fingerprint changes
- **WHEN** the same symbol is queried with a new project fingerprint
- **THEN** CodeGraph is queried again

#### Scenario: Index revision is unavailable
- **WHEN** CodeGraph cannot provide a stable index revision for a revision-bound batch
- **THEN** graph assertions are UNKNOWN and the provider version is not substituted as the index revision

## ADDED Requirements

### Requirement: Call-path and impact facts are normalized
The code intelligence port SHALL expose bounded call-path and impact facts without raw CodeGraph node IDs, scores, database fields, or response payloads.

#### Scenario: Bounded call path exists
- **WHEN** CodeGraph returns a path from the requested source symbol to target symbol within the requested depth and result limits
- **THEN** CALL_PATH_EXISTS is SUPPORTED from normalized symbol and repository-relative path facts

#### Scenario: Impact target is absent from a healthy result
- **WHEN** a READY CodeGraph index returns a bounded impact set that does not contain the exact requested impacted symbol
- **THEN** IMPACT_CONTAINS is REFUTED

#### Scenario: Callee traversal capability is unavailable
- **WHEN** the installed compatible provider cannot execute a bounded callee operation needed by the call-path traversal
- **THEN** CALL_PATH_EXISTS is UNKNOWN and the adapter does not emulate an unbounded recursive search

#### Scenario: Call-path traversal reaches a hard bound
- **WHEN** the configured depth, visited-symbol, process-call, result, or deadline bound is reached before the target is proven absent
- **THEN** CALL_PATH_EXISTS is UNKNOWN rather than REFUTED
