## ADDED Requirements

### Requirement: Scenario-aware retrieval explanation
The query Console SHALL display the authoritative project/revision, eligible scenario cards, selected scenario, expanded knowledge and each project/branch/scenario/freshness filter reason.

#### Scenario: Knowledge is omitted by branch gate
- **WHEN** a natural-language query textually matches an incompatible-branch asset
- **THEN** the result explains the branch mismatch and does not present the asset as eligible context

### Requirement: Scenario drill-down
The query Console SHALL allow read-only navigation from a scene card to its bound current knowledge and from a knowledge result back to its scenario and provenance.

#### Scenario: User selects a scene card
- **WHEN** the directory contains a relevant scenario
- **THEN** the Console displays only that scenario's eligible knowledge pointers and permits explicit L2/L3 expansion
