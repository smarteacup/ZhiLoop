# Change: Configure and safely roll out knowledge evolution

## Why

The compilation, evolution, CodeGraph, freshness and prewarm modules are implemented, but their production defaults are split between static Sidecar JSON and hard-coded values. Operators need one strict, migratable configuration model whose online values actually drive the runtimes, while automatic publication remains impossible without explicit, evidence-bound grey-rollout authorization.

## What Changes

- Upgrade the core configuration to version 2 and deterministically migrate strict version 1 inputs.
- Add bounded compilation, evolution, code-intelligence, freshness, prewarm and alert sections to the online Console configuration.
- Apply compilation configuration to the live scheduler and expose all new fields through the existing revisioned configuration workflow.
- Add a bounded, non-reentrant freshness ChangeSet scheduler port for production adapters.
- Add a pure automatic-publication rollout gate that requires explicit enablement, project/kind allowlists, fresh code evidence and a bound golden-evaluation identity.

## Impact

- Extends `@zhiloop/config`, Control API, Configuration Service, Sidecar runtime and Console configuration UI.
- Defaults preserve preview-only compilation, no automatic publication, no CodeGraph auto-initialization and fail-open Codex behavior.
