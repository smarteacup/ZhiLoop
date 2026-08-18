# Change: Connect CodeGraph as the live code fact layer

## Why

ZhiLoop currently has Evidence verifier contracts but production composition still uses fixture-like observations. CodeGraph already provides precise structural facts and should be reused rather than copied into a second code knowledge base.

## What Changes

- Add normalized, vendor-neutral code-intelligence contracts.
- Add a bounded CodeGraph CLI adapter with version/capability negotiation, lazy health checks, timeout, and fingerprint-scoped caching.
- Strip CodeGraph node IDs and backend schema from all returned facts.
- Add a real SYMBOL_EXISTS Evidence probe and expose callers/impact facts for later assertions and freshness.
- Treat uninitialized, incompatible, timeout, and corrupt responses as explicit UNKNOWN/ERROR states; never initialize a repository implicitly.

## Impact

- Adds two isolated workspaces: `code-intelligence` and `codegraph-adapter`.
- Does not change the KnowledgeAsset schema or make CodeGraph a knowledge authority.
- Production activation remains configuration-gated; package integration tests exercise the real adapter contract without writing `.codegraph/`.
