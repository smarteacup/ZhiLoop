# Change: Run bounded freshness revalidation

## Why

Publication anchors and the injection gate exist, but code changes do not yet drive a durable freshness state transition. A FRESH publication projection can therefore remain FRESH until another component updates it.

## What Changes

- Add version-bound mutable freshness state plus immutable transition events beside immutable publication projections.
- Add a bounded ChangeSet worker that resolves affected versions, performs one batch revalidation at one code/graph revision, plans state, and commits with CAS.
- Preserve idempotency across repeated ChangeSets and partial retries.

## Impact

- Extends `@zhiloop/knowledge-freshness`; no knowledge body is modified.
- Produces structured results for later scheduling, console display, alerts, and repair actions.
