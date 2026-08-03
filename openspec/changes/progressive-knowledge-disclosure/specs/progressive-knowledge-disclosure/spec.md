## ADDED Requirements

### Requirement: Dynamic progressive disclosure
The system SHALL retrieve candidates for every eligible UserPrompt submission and SHALL initially disclose only a dynamically filtered knowledge directory rather than full reference content.

#### Scenario: Reference knowledge is initially a pointer
- **WHEN** an eligible non-binding knowledge asset matches the current QueryContext
- **THEN** the automatic initial Context Envelope contains its ID, version, authority, scope, title and summary at `L1_POINTER` without body or evidence summary

### Requirement: Binding rule reservation
The system MUST include an eligible matching `BINDING_RULE` at no less than `L2_COMPACT` before selecting lower-authority reference knowledge, subject only to the hard envelope budget.

#### Scenario: Binding requirement competes with implementations
- **WHEN** a requirement and multiple implementation references match the same symbol and exceed the available item budget
- **THEN** the requirement is included with applicability, failure paths, symbols and evidence pointers before reference-only items

### Requirement: Explicit expansion affordance
The injected context SHALL tell Codex how and when to use `ckl.search`, `ckl.get`, `ckl.related` and `ckl.check`, and SHALL prohibit inferring omitted implementation details from a pointer summary.

#### Scenario: Codex sees a knowledge pointer
- **WHEN** the initial envelope contains at least one `L1_POINTER`
- **THEN** the rendered additional context contains a machine-readable progressive-disclosure protocol with the available expansion tools

### Requirement: Selectable detail expansion
`ckl.get` SHALL accept a target detail level of `L2_COMPACT` or `L3_EVIDENCED` and SHALL return only the selected current in-scope asset at the requested depth.

#### Scenario: Expand pointer to compact boundaries
- **WHEN** Codex requests an L1 pointer with target `L2_COMPACT`
- **THEN** the result contains boundaries, symbols and evidence pointers but does not contain the asset body or evidence summary

#### Scenario: Expand pointer to evidenced content
- **WHEN** Codex requests an L1 or L2 item with target `L3_EVIDENCED`
- **THEN** the result contains the body and evidence summary and includes any missing compact fields needed for an L1-to-L3 expansion

### Requirement: Pointer discovery results
`ckl.search` and `ckl.related` SHALL return eligible current results as `L1_POINTER` items and SHALL omit full boundaries, body and evidence.

#### Scenario: Runtime discovery
- **WHEN** Codex searches for or follows relations to previously unseen knowledge
- **THEN** each returned item is a scoped L1 pointer that can be expanded with `ckl.get`

### Requirement: Pull eligibility parity
Every Pull operation MUST revalidate current version, eligible status and QueryContext Scope using the same boundaries as automatic Push.

#### Scenario: Stale or cross-project expansion
- **WHEN** Codex requests a stale, ineligible or cross-project knowledge asset
- **THEN** the service returns no knowledge content and reports a diagnostic reason

### Requirement: No automatic evidenced bulk injection
Risk, ambiguity or conflict signals MUST NOT automatically inject all candidate bodies at L3 during the initial UserPrompt Hook.

#### Scenario: High-risk implementation prompt
- **WHEN** a high-risk prompt matches binding and reference knowledge
- **THEN** the initial envelope contains binding compact summaries and reference pointers, and detailed evidence is obtained only through explicit Pull or bounded closure continuation

### Requirement: Final rendered context budget
The system MUST calculate and enforce the automatic injection token ceiling against the complete rendered `additionalContext`, including authority guidance, progressive-disclosure protocol, trace metadata and the selected knowledge directory.

#### Scenario: Protocol overhead competes with knowledge pointers
- **WHEN** the Context Envelope alone fits but the complete rendered `additionalContext` would exceed the configured ceiling
- **THEN** the orchestrator removes the lowest-priority optional entries until the complete rendered output fits, while preserving an eligible binding rule whenever it can fit

### Requirement: Discoverable directory truncation
The system SHALL expose how many eligible candidates were disclosed and omitted, and SHALL provide a machine-readable next action when eligible knowledge is omitted from the initial directory.

#### Scenario: Eligible candidates exceed the initial directory budget
- **WHEN** one or more eligible candidates are omitted by the token or item budget
- **THEN** the rendered progressive-disclosure metadata reports the disclosed and omitted counts and directs Codex to use a narrower `ckl.search` query to continue discovery
