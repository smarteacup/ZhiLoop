## ADDED Requirements

### Requirement: Stable context has a dependency-complete cache identity

The system SHALL key session prewarm data by session, project, worktree, branch, Registry revision, Retrieval policy, Injection policy, and Scope identity.

#### Scenario: Knowledge or policy changes

- **WHEN** any dependency identity changes
- **THEN** the old entry is not returned as a cache hit

### Requirement: Prewarm payload is minimal and bounded

The system SHALL persist only bounded L1 pointers, summaries, authority, and expansion actions.

#### Scenario: An asset contains implementation details

- **WHEN** its stable catalog item is built
- **THEN** body, symbols, Evidence, source Episodes, and live code facts are absent

### Requirement: Session context can be refreshed explicitly

The system SHALL provide an idempotent session refresh operation that invalidates all stable catalog entries for that session.

#### Scenario: The user refreshes current session knowledge

- **WHEN** refresh is requested twice for the same session
- **THEN** the first call removes its entries and the second is a no-op

### Requirement: Code-related injection is freshness gated

The system SHALL inspect only final eligible candidates and exclude code-related items whose current projection is missing, mismatched, CONFLICT, REVALIDATE, or UNKNOWN.

#### Scenario: Freshness cannot be established

- **WHEN** a final code-related candidate has no matching FRESH projection
- **THEN** it is omitted with a reason and normal Codex execution continues

#### Scenario: Historical non-code knowledge is selected

- **WHEN** a decision or rule does not depend on code anchors
- **THEN** it remains eligible without a freshness projection
