# Durable knowledge repair drafts

## 1. Safety model

A Freshness `CONFLICT` is evidence that one or more assertions no longer agree with the current code revision. It is not evidence for the replacement wording. The automatic path therefore creates a review artifact in `PENDING`, carrying exact inputs but no fabricated proposal.

The old Registry asset and Freshness record remain immutable. A later generator may attach a new domain `KnowledgeCandidate`, but the store accepts only `status: PROPOSED`, records the candidate hash, and never copies publication authorization. `PROMOTED` means only that a downstream Candidate intake receipt exists; it never means published.

## 2. Identity and data model

`draftId` is a deterministic SHA-256 identity over schema version, project, source asset/version/content hash, and conflict verification run. The SQLite store enforces a unique `(asset_id, asset_version, conflict_run_id)` tuple and validates canonical payload hashes on every read.

Each draft persists:

- exact source reference, content hash, Candidate snapshot and lifecycle status;
- exact verification run, code/graph revision, and changed assertion summaries;
- stable reason codes and timestamps;
- revisioned status `PENDING | READY | DISMISSED | PROMOTED | FAILED`;
- optional new `PROPOSED` Candidate and optional promotion receipt;
- an explicit `inheritedAuthorization: false` invariant.

The Candidate snapshot is repair input, not an injectable or published asset. Operational job projections continue to expose metadata only.

## 3. Conflict identity propagation

`KnowledgeVerificationBatch.runId` is already durable. `ProductionFreshnessVerifier` returns a bounded `runIds` map keyed by asset ID. `KnowledgeFreshnessWorker` validates exact cardinality and projects the matching run ID on each result item. The revalidation handler schedules a repair job after the idempotent Freshness transition and before committing its page checkpoint.

If the process dies between those operations, replay receives the same verification run, replays the Freshness effect, and re-enqueues the same idempotent repair job. If the process dies after enqueue, the page replay also reuses the same job.

## 4. Durable handler

The handler loads the exact Freshness record/state and exact verification run. It fails non-retryably when identity, version, candidate, project, code/graph revision, or conflict state differ. It derives changed assertions only from affected assertions whose verification result is `UNSUPPORTED`; `UNKNOWN` and verifier errors cannot create repair claims.

The handler persists the draft through an idempotent create operation, saves a `DRAFT_PERSISTED` checkpoint, and completes. SQLite/store availability failures remain retryable; corrupt or mismatched evidence is terminal.

## 5. State transitions

- `PENDING -> READY`: attach a validated new `PROPOSED` Candidate using revision CAS.
- `PENDING | READY -> DISMISSED`: record a bounded reason using revision CAS.
- `READY -> PROMOTED`: require an idempotent downstream receipt and revision CAS.
- `PENDING -> FAILED`: record a stable generator failure classification.

Terminal drafts cannot be edited. Attaching the same candidate or replaying the same receipt is idempotent; different data under the same effect key is rejected.

## 6. Boundaries and limits

The repair package depends only on domain and verification contracts plus Node SQLite/crypto/path. It does not depend on Sidecar, model execution, Registry writers, Markdown writers, or control transport. Inputs, JSON payload sizes, assertions, list limits, and free-text fields are bounded. Database files use owner-only permissions, WAL, foreign keys, synchronous full, and busy timeout.

## 7. Failure and recovery

- Missing or stale conflict evidence: terminal job failure, no draft.
- Database lock/I/O interruption: bounded retry.
- Restart after draft insert: canonical replay returns the existing draft.
- Old knowledge changes: the exact content-hash check rejects the stale job.
- Semantic generator unavailable: draft remains `PENDING`; no unsafe Candidate is produced.

## 8. Acceptance proof

Tests must demonstrate one conflict creates one draft across duplicate enqueue and kill/restart, source content hashes remain unchanged, non-conflicts create no drafts, mismatched verification is rejected, READY candidates remain `PROPOSED`, and promotion cannot write Registry/Markdown or inherit authorization.
