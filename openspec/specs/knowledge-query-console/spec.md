# knowledge-query-console Specification

## Purpose
TBD - created by archiving change build-zhiloop-console. Update Purpose after archive.
## Requirements
### Requirement: Deterministic natural-language knowledge search
The system SHALL accept a natural-language query and execute Scope-aware Exact, FTS, Vector, Relation, fusion, status filtering, and rerank stages without requiring a model-generated answer.

#### Scenario: User searches an exact error or symbol
- **WHEN** exact or FTS channels produce eligible project results
- **THEN** the Console displays current matching knowledge versions and their channel contributions

### Requirement: Explainable retrieval trace
The system SHALL record and display retrieval rank, final rank, channel scores, Scope and status filters, Evidence, budget decisions, injection selection, and reason codes for every returned or omitted candidate.

#### Scenario: A retrieved item is omitted from Context Envelope
- **WHEN** the item is removed because of budget, duplication, authority, Scope, state, or timeout
- **THEN** the Trace displays the exact omission reason rather than reporting “not injected” without explanation

### Requirement: Shadow context simulation
The system SHALL allow read-only simulation and replay of QueryContext and Context Envelope using current or draft policy without writing production feedback or claiming delivery to Codex.

#### Scenario: User compares a draft token budget
- **WHEN** the user runs the same query against current and draft policy
- **THEN** the Console compares selected items, complexity, estimated tokens, truncation, and reasons while leaving active configuration and feedback unchanged

### Requirement: Codex-assisted knowledge answer
The system SHALL offer an optional “Ask ZhiLoop” mode that retrieves first and then invokes a bounded local Codex read-only, ephemeral adapter to return structured answer, knowledge version citations, unknowns, conflicts, model run ID, latency, and token usage.

#### Scenario: Codex produces a supported answer
- **WHEN** the model returns a factual answer span supported by retrieved knowledge
- **THEN** the response links that span to the exact knowledge ID and version

#### Scenario: Codex cannot support a factual statement
- **WHEN** no retrieved knowledge version supports the statement
- **THEN** the statement is omitted from factual answer content or reported in `unknowns`

### Requirement: Safe query degradation and isolation
The system MUST constrain Codex-assisted queries with safe cwd, minimized environment, bounded input/output, timeout, cancellation, concurrency, and user/MCP configuration policy; failure SHALL fall back to deterministic search.

#### Scenario: Local Codex is unavailable or rate limited
- **WHEN** the process fails, times out, is unauthenticated, or is rate limited
- **THEN** the Console returns search results and a safe model diagnostic without blocking other Console or Hook work

#### Scenario: Retrieved knowledge contains malicious instructions
- **WHEN** untrusted knowledge text attempts to change tools or process permissions
- **THEN** the adapter treats it as data and preserves the configured read-only execution boundary

### Requirement: Query answers do not automatically become knowledge
The system SHALL keep query answers and retrieval traces separate from published knowledge unless the user starts a dedicated candidate creation flow.

#### Scenario: User receives an answer
- **WHEN** a Codex-assisted answer completes
- **THEN** no knowledge asset, Codex conversation, or project file is created or modified automatically

