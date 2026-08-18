## ADDED Requirements

### Requirement: User commitments are compiled before knowledge policy
The Worker SHALL detect and apply user commitments after Candidate extraction and before Scope, Evidence, and publication policy.

#### Scenario: User uniquely accepts one candidate
- **WHEN** a completed Episode contains a traceable acceptance that resolves to one Candidate
- **THEN** the Candidate SHALL remain `PROPOSED` and SHALL gain one deterministic `USER_ACCEPTED` assertion before policy evaluation

#### Scenario: User uniquely rejects one candidate
- **WHEN** a traceable rejection resolves to one Candidate
- **THEN** the Candidate SHALL gain a `USER_REJECTED` assertion and SHALL remain retained for policy and audit

#### Scenario: Commitment target is ambiguous
- **WHEN** an acceptance or rejection has multiple plausible Candidate targets
- **THEN** no commitment assertion SHALL be applied and the ambiguity SHALL be persisted with statement and Candidate references

### Requirement: Corrections remain traceable without fabricated semantics
The Worker SHALL retain every valid correction signal and SHALL create deterministic relation drafts only for resolved targets.

#### Scenario: Correction targets a cited candidate
- **WHEN** a correction references evidence used by a Candidate
- **THEN** the checkpoint SHALL contain the original/corrected references and text plus a `CONTRADICTS` relation draft for that Candidate

#### Scenario: Correction target is unresolved
- **WHEN** no unique Candidate target can be proven
- **THEN** the correction signal SHALL be retained with `TARGET_UNRESOLVED` and no relation SHALL be auto-applied

### Requirement: Candidate compilation provenance is complete
The Worker SHALL persist candidate-level extraction key, input hash, Episode, builder, compiler, prompt, and policy identities.

#### Scenario: Candidate is compiled successfully
- **WHEN** a compiler returns a valid Candidate
- **THEN** its checkpoint provenance SHALL bind the exact extraction input and all compiler/prompt/policy versions

#### Scenario: Same candidate identity has conflicting provenance
- **WHEN** aggregate extraction results assign one candidateId to different immutable inputs or versions
- **THEN** the COMPILE stage SHALL fail closed without policy or publication

### Requirement: Commitment compilation is replay safe and backward compatible
The Worker SHALL checkpoint commitment output and SHALL not repeat it after success.

#### Scenario: Work resumes after commitment stage
- **WHEN** a later stage retries
- **THEN** commitment detection SHALL be skipped and the stored enriched Candidates SHALL be reused

#### Scenario: Legacy incomplete checkpoint lacks the stage
- **WHEN** an old checkpoint has compiled Candidates but no `USER_COMMITMENT` stage entry
- **THEN** the Worker SHALL treat that stage as pending and SHALL complete it before policy

#### Scenario: Legacy completed checkpoint lacks the stage
- **WHEN** an old completed checkpoint is replayed
- **THEN** the Worker SHALL not mutate it or repeat publication
