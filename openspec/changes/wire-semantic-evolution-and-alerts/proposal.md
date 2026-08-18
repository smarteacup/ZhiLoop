# Change: Wire bounded semantic evolution and durable operational alerts

## Why

ZhiLoop can deterministically classify most candidate evolution, but unresolved relations currently remain `PENDING` even when a configured Codex runtime could safely distinguish the allowed actions. Production evolution and freshness failures are also visible only as transient job/diagnostic state; there is no durable, privacy-safe alert record with deduplication and an honest local-only delivery status.

## What Changes

- Add a reusable read-only structured Codex execution boundary and a dedicated semantic evolution adapter.
- Send only bounded candidate/target summaries, assertions, scopes, and source identifiers; never send a full conversation.
- Keep deterministic evolution authoritative and revalidate every model action and target before accepting a decision.
- Make semantic arbitration opt-in, expose `READY`, `DEGRADED`, and `DISABLED` capability state, and preserve `PENDING` on every adapter failure.
- Add a durable SQLite operational alert store with cooldown aggregation, optional external delivery, and explicit `LOCAL_ONLY` state.
- Wire real producers for permanent evolution-job failure, CodeGraph unavailability, and stale-knowledge conflicts.
- Expose bounded operational-alert reads in the control API and console without retaining raw prompts, knowledge bodies, process output, or environment values.

## Non-goals

- Semantic arbitration does not publish knowledge, grant authority, widen scope, create replacement facts, or repair a conflicted asset.
- This change does not require or claim an external notification provider.
- Existing threshold alerts remain separate from durable evolution alerts.

## Impact

- New workspaces: `@zhiloop/semantic-evolution-codex` and `@zhiloop/operational-alerts`.
- Extended model, evolution runtime, Sidecar composition, control API, gateway/client, and console surfaces.
- New local database `operational-alerts.sqlite` and a safe default of `semanticJudgeEnabled=false` for fresh configuration.
