## ADDED Requirements

### Requirement: Stable versioned scenario registry
The system SHALL maintain project-bound scenarios with stable IDs, immutable versions, human-readable cards, positive and negative applicability, entry points, task intents, aliases and relations.

#### Scenario: Knowledge binds to an existing scenario
- **WHEN** a published knowledge version uses the same project and deterministic scenario key
- **THEN** the Registry adds a versioned binding without creating a duplicate scenario identity

### Requirement: Bounded scenario evolution
The system SHALL compare a new scenario hint only with a bounded pool from the same project and compatible revision and SHALL decide CREATE, UPDATE_VERSION, MERGE_VERSION, KEEP_SEPARATE, SUPERSEDE, CONTRADICT, SKIP, or PENDING.

#### Scenario: Same entry point receives additional knowledge
- **WHEN** the stable key and normalized entry point set match an existing scenario without boundary conflict
- **THEN** the scenario is updated as a new version and keeps links to all source knowledge versions

#### Scenario: Semantically similar scenarios have different branches or exclusions
- **WHEN** similarity is high but branch compatibility or non-applicability differs
- **THEN** they remain separate and receive an overlap relation instead of being auto-merged

#### Scenario: Evolution is ambiguous
- **WHEN** deterministic signals cannot choose a safe action
- **THEN** the result is PENDING and no existing scenario is overwritten or deleted

### Requirement: Human-readable rebuildable scenario projection
The system SHALL render scenario cards and detailed Markdown from committed knowledge and SHALL rebuild the scenario index without treating edited Markdown as authoritative data.

#### Scenario: Scenario projection is rebuilt
- **WHEN** the projection database or Markdown cache is recreated from committed knowledge versions
- **THEN** scenario IDs, versions, bindings and provenance remain deterministic

### Requirement: Scenario-aware progressive retrieval
The system MUST apply project, branch/commit, status and freshness filters before scenario ranking, SHALL initially disclose a bounded scenario directory, and SHALL expand only selected knowledge on demand.

#### Scenario: Similar text exists on another branch
- **WHEN** a prompt is semantically similar to knowledge whose branch policy is incompatible
- **THEN** that knowledge is filtered before ranking and the Trace records the branch reason

#### Scenario: A relevant scene is selected
- **WHEN** task intent, entry point, symbol or path matches an eligible scenario card
- **THEN** the initial envelope includes the card and knowledge pointers without bulk bodies or raw evidence

### Requirement: Scenario utility feedback
The system SHALL track selection, expansion, use, suppression and stale outcomes separately from correctness and SHALL NOT use heat alone as evidence truth.

#### Scenario: Frequently selected knowledge becomes stale
- **WHEN** a high-usage scenario contains knowledge invalidated by code changes
- **THEN** freshness exclusion wins over heat and the stale content is not injected
