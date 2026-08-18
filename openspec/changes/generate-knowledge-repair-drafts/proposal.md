# Change: Generate durable knowledge repair drafts

## Why

Durable revalidation can now prove that an exact published knowledge version conflicts with current code, but the conflict currently stops at a Freshness state. Operators cannot inspect a stable repair unit, semantic repair has no safe input contract, and a later worker cannot resume without rediscovering the conflict. Reusing the old Candidate or editing the published asset in place would erase provenance and could accidentally inherit publication authority.

## What Changes

- Preserve the exact verification run identity for each revalidated knowledge version.
- Create exactly one immutable-source, revisioned repair draft for each `(assetId, assetVersion, conflictRunId)` conflict.
- Persist refuted assertions, reason codes, source content hash, verification revision, and the old Candidate snapshot needed by a later semantic repair worker.
- Add guarded draft transitions for attaching a new `PROPOSED` Candidate, dismissing a draft, and promoting it into the normal Candidate flow.
- Register a restart-safe `KNOWLEDGE_REPAIR_DRAFT` durable handler and enqueue it automatically after a durable conflict transition.
- Expose bounded read APIs without changing the old knowledge body or lifecycle state.

## Non-goals

- This change does not invent replacement facts when verification only proves that an old assertion is false.
- This change does not publish repaired knowledge, mutate a Registry asset, or grant `ACCEPTED`, `IMPLEMENTED`, or `VERIFIED` authority.
- Semantic/model-assisted candidate generation and operator UI are separate follow-up modules built on this durable contract.

## Impact

- New workspace: `@zhiloop/knowledge-repair-drafts`.
- Extended Freshness verification result identity and durable revalidation scheduling.
- Sidecar owns one additional SQLite database and reports the repair handler as ready.
- No wire compatibility break for existing Freshness records, Registry assets, or control clients.
