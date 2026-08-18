# Change: Expose knowledge evolution observability

## Why

Freshness projections, revalidation events, extraction stages and injection audits are durable, but operators cannot inspect the full chain from the Console. Hidden state makes it hard to explain why a knowledge version is eligible, excluded, stale, or waiting for repair.

## What Changes

- Extend the strict knowledge-detail contract with version-bound freshness, code anchors and immutable transition history.
- Derive retrieval eligibility from governance and freshness together, with explicit exclusion reasons.
- Render freshness, anchors, revisions and transition reasons in Chinese while retaining raw diagnostic codes.
- Keep all views read-only except existing versioned governance commands; no Console read mutates knowledge.

## Impact

- Extends P2 control contracts, Sidecar projection and Console rendering.
- Does not change publication, injection, or lifecycle semantics.
