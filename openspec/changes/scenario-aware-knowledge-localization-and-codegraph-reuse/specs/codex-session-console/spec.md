## ADDED Requirements

### Requirement: Located extraction preview
The session extraction Console SHALL display each Candidate's claim mode, project, repository, branch/commit, branch policy, scenario, entry points, symbols, applicability, exclusions and locator diagnostics.

#### Scenario: User reviews an extracted Candidate
- **WHEN** a session snapshot produces project-bound Candidates
- **THEN** the preview shows where and when each conclusion applies before the user commits policy decisions

### Requirement: CodeGraph extraction provenance
The session and knowledge detail Console SHALL display linked CodeGraph artifact summaries and their Git/graph revisions without exposing unbounded raw tool output by default.

#### Scenario: Candidate uses a call-path artifact
- **WHEN** the user opens its evidence details
- **THEN** the Console shows the query, normalized path, revision compatibility, source turn and revalidation status
