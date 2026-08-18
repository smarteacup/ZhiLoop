# Change: Migrate legacy code knowledge into the live-fact pipeline

## Why

Knowledge published before the current evidence recipe and Freshness projection pipeline cannot participate in exact CodeGraph revalidation. Leaving it untouched makes valid historical knowledge permanently ineligible for current-code injection, while rebuilding it from model guesses would weaken provenance and authority.

## What changes

- Add a durable, two-phase `DRY_RUN -> COMMIT` migration service with immutable previews, registry-revision validation, bounded pages and resumable jobs.
- Classify current Registry knowledge using existing recipes, Freshness provenance and explicit asset symbol anchors only; never infer assertions from prose.
- Add migration-owned Recipe and Freshness writes with transactionally recorded ownership and conflict-aware rollback.
- Run an initial verification for every migrated projection and persist truthful `FRESH`, `CONFLICT`, or `UNKNOWN` state.
- Register `LEGACY_KNOWLEDGE_MIGRATION` in the Sidecar durable job runtime and expose bounded migration status/diagnostics without changing Markdown or Registry knowledge.
- Emit durable `MIGRATION_FAILED` alerts for terminal migration failures.

## Impact

- New workspace: `@zhiloop/knowledge-legacy-migration`.
- Extended stores: `@zhiloop/knowledge-verification`, `@zhiloop/knowledge-freshness`.
- Extended durable job input and Sidecar composition/control contracts.
- No automatic migration, model call, knowledge publication, lifecycle change or Markdown rewrite.
