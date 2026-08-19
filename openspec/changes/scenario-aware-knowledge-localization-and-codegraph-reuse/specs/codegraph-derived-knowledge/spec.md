## ADDED Requirements

### Requirement: Versioned CodeGraph artifact
The system SHALL persist bounded normalized CodeGraph queries and facts with project fingerprint, Git commit, CodeGraph index revision, source events, observed time and content hash.

#### Scenario: Call path assertion is supported
- **WHEN** CodeGraph returns a bounded complete path for the authoritative project revision
- **THEN** the Verification result references an immutable CALL_PATH artifact containing the normalized symbols and paths

### Requirement: Derived conclusion provenance
Knowledge derived from CodeGraph MUST reference the artifact and original Episode/turn evidence while keeping raw graph output outside automatic prompt content.

#### Scenario: User opens a derived implementation fact
- **WHEN** the fact originated from a CodeGraph trace
- **THEN** the user can navigate from the knowledge version to the artifact query, normalized result, Git/graph revisions and source conversation

### Requirement: Safe artifact reuse
The system SHALL reuse a CodeGraph artifact only when project identity, Git compatibility, graph revision and dependency fingerprints satisfy its reuse policy.

#### Scenario: Unrelated files changed
- **WHEN** the current commit differs but no artifact path or symbol is affected and lineage compatibility is proven
- **THEN** the existing artifact may be reused and the reuse decision is traced

#### Scenario: Referenced symbol changed
- **WHEN** Git diff or CodeGraph impact intersects an artifact dependency
- **THEN** the artifact and derived knowledge become SUSPECT and the original query is scheduled for revalidation

### Requirement: Changed graph result evolves knowledge
The system SHALL preserve the prior knowledge version and create an evolution decision when re-running an artifact produces a different normalized result.

#### Scenario: Call path changed
- **WHEN** a revalidated CALL_PATH artifact has a different content hash
- **THEN** the replacement Candidate references the new artifact and SUPERSEDES or contradicts the prior version according to policy

### Requirement: CodeGraph failure fails closed
The system MUST NOT present a model-only implementation claim as current verified code knowledge when CodeGraph is unavailable, stale, bounded, or revision-mismatched.

#### Scenario: Graph revision is unavailable
- **WHEN** a current-code assertion requires CodeGraph but no matching index revision is available
- **THEN** Verification is UNKNOWN with a diagnostic and publication/injection remains blocked
