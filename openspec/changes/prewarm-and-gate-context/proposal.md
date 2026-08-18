# Change: Prewarm stable context and gate live code knowledge

## Why

Active injection currently repeats stable registry discovery and has no final check that a code-related result still matches the current freshness projection. This increases first-prompt work and can present stale implementation knowledge as current fact.

## What Changes

- Add a session-scoped, integrity-checked L1 context catalog cache with explicit dependency identities, TTL, bounds, and refresh.
- Store only stable pointers, summaries, authority, and expansion actions; never cache bodies, code locations, or Episodes.
- Add a final projection freshness gate for code-related candidates.
- Integrate prewarm and freshness filtering into the active Sidecar path without making Hook failures block Codex.

## Impact

- New package: `@zhiloop/context-prewarm`.
- Extended package: `@zhiloop/knowledge-freshness`.
- Active Sidecar owns both runtime integrations and lifecycle.
