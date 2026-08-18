## ADDED Requirements

### Requirement: Conflict creates one durable repair draft
The system SHALL create exactly one durable repair draft for an exact knowledge version and exact completed Freshness verification run that transitioned to `CONFLICT`.

#### Scenario: Conflict is replayed
- **WHEN** the revalidation page or repair job is replayed after interruption
- **THEN** the same draft and durable job are reused without duplicate state, Candidate, or publication side effects

#### Scenario: Non-conflict is processed
- **WHEN** revalidation produces `FRESH`, `REVALIDATE`, or `UNKNOWN`
- **THEN** no repair draft job is enqueued for that result

### Requirement: Draft evidence is exact and traceable
Every repair draft MUST preserve the exact project, asset/version/content hash, source Candidate, conflict verification run, code/graph revision, affected unsupported assertions, reason codes, and creation time.

#### Scenario: Verification identity differs
- **WHEN** the run belongs to another project, Candidate, knowledge version, code revision, or is not a completed Freshness run
- **THEN** draft creation fails terminally and persists no draft

#### Scenario: Source changed after enqueue
- **WHEN** the current Freshness projection no longer has the enqueued asset version and content hash in conflict
- **THEN** the stale repair request is rejected without changing the old asset

### Requirement: Repair does not mutate or inherit authority
Automatic repair SHALL NOT modify the source knowledge body, lifecycle state, Registry projection, Markdown projection, or publication authority.

#### Scenario: Pending draft is created
- **WHEN** conflict evidence proves the old assertion false but contains no grounded replacement fact
- **THEN** the system creates a `PENDING` draft without inventing a Candidate

#### Scenario: Candidate is attached
- **WHEN** a later generator attaches a replacement Candidate
- **THEN** the Candidate is accepted only with domain status `PROPOSED`, the draft becomes `READY`, and inherited authorization remains false

### Requirement: Draft lifecycle is revisioned and idempotent
Draft updates SHALL use expected-revision compare-and-set and deterministic effect identities across `PENDING`, `READY`, `DISMISSED`, `PROMOTED`, and `FAILED`.

#### Scenario: Concurrent update loses the CAS
- **WHEN** two actors update the same draft revision differently
- **THEN** exactly one transition succeeds and the stale transition is rejected

#### Scenario: Promotion is replayed
- **WHEN** the same downstream Candidate intake receipt is recorded more than once
- **THEN** the draft remains `PROMOTED` once and the receipt is not duplicated

### Requirement: Promotion re-enters normal Candidate flow
`PROMOTED` SHALL mean only that the new `PROPOSED` Candidate has a durable downstream intake receipt; it SHALL NOT imply policy approval or publication.

#### Scenario: Ready draft has no intake receipt
- **WHEN** promotion is requested without a durable normal-flow receipt
- **THEN** promotion is rejected and no Registry or Markdown write occurs

### Requirement: Repair storage and reads are bounded
The system SHALL validate and bound identifiers, text, assertion count, payload size, list size, and SQLite durability, and SHALL detect stored-payload corruption.

#### Scenario: Corrupt stored payload is read
- **WHEN** the canonical payload hash does not match the stored hash or identity columns
- **THEN** the read fails closed with a stable corruption error
