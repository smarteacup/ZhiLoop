# Change: Track and refresh knowledge freshness from code changes

## Why

Published knowledge has code fingerprints but no operational reverse index from changed paths or symbols back to affected knowledge. As a result, code changes cannot quickly target revalidation, and freshness is easily confused with the historical lifecycle state.

## What Changes

- Add a durable freshness projection containing the source Candidate assertions and normalized anchors for each published asset version.
- Add an indexed change-to-knowledge lookup and bounded freshness planner.
- Keep `FRESH/REVALIDATE/CONFLICT/UNKNOWN` separate from KnowledgeStatus.
- Reuse invalidation-engine for lifecycle consequences while preserving knowledge body and history.
- Project freshness atomically in the Worker before incremental indexing.

## Impact

- Adds `knowledge-freshness` and one Worker stage.
- Adds a local SQLite projection, not fields to Markdown KnowledgeAsset.
- Change detection producers may submit normalized change sets later without knowing storage internals.
