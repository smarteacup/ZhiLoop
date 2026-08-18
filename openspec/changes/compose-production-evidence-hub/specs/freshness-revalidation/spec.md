## MODIFIED Requirements

### Requirement: Revalidation is bounded and batch-consistent
The system SHALL resolve at most the configured affected asset limit and SHALL verify every selected affected assertion through the shared production verification service in one batch bound to one project, code revision, observation time, and optional graph revision.

#### Scenario: The affected set exceeds the limit
- **WHEN** anchor lookup reports more active versions than the hard limit
- **THEN** the run is marked bounded and only the returned versions are processed

#### Scenario: Affected assertions use different probe types
- **WHEN** one affected version contains symbol, file, dependency, configuration, call-path, impact, command, or test assertions
- **THEN** Freshness uses the same registered verifier and probe semantics used by Candidate policy for each assertion

### Requirement: Invalid verifier output fails before transitions
The system SHALL reject missing, duplicate, unrequested, cross-project, observation-time-mismatched, or revision-mismatched verification results before changing Freshness state.

#### Scenario: A verifier returns an assertion that was not requested
- **WHEN** batch output contains that result
- **THEN** no Freshness transition is committed

#### Scenario: A verifier omits a requested assertion
- **WHEN** batch output does not contain exactly one result for every requested assertion
- **THEN** no Freshness transition is committed and the run is retryable

## ADDED Requirements

### Requirement: Historical execution evidence is not treated as current execution
Freshness SHALL preserve historical command/test Evidence but SHALL require a matching new Snapshot observation before treating execution assertions as supported at a changed code revision.

#### Scenario: Code changes after the last successful test
- **WHEN** a code-related version requires TEST_PASSED and no matching test observation exists for the changed revision
- **THEN** the test assertion is UNKNOWN and the version is not marked FRESH from the historical result

