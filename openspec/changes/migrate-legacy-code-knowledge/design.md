# Design: Durable legacy code knowledge migration

## 1. Boundary

The migration is an operator-started derived-data repair. Registry and Markdown remain read-only inputs. The service may add only a current `evidence-recipe-v1`, a Freshness projection/state, verification run summaries and migration audit records.

The first migration version is `legacy-code-knowledge-v1`. It considers a non-tombstoned current asset code-related when at least one rule holds:

1. `kind === IMPLEMENTATION`;
2. its current recipe or Freshness candidate contains a code assertion;
3. it has an explicit symbol anchor in `asset.symbols`.

Project and narrower scopes must match the requested project. Global knowledge is eligible only when every code assertion that carries a project ID names that project. USER/TEAM/TASK knowledge is skipped.

## 2. Evidence resolution

Resolution is deterministic and ordered:

1. An existing current Freshness record supplies its exact Candidate; if the Recipe is missing, its code assertions can create the Recipe.
2. An existing current Recipe can be combined with immutable Registry fields to reconstruct a migration Candidate. The Candidate ID must be identical across all assertions; title, summary, body, correlation, scope and source episodes come from the exact current asset.
3. When neither exists, explicit `asset.symbols` can be translated one-to-one into deterministic `SYMBOL_EXISTS` assertions bound to the asset's project scope.
4. Otherwise the item is skipped as `RECIPE_MISSING` and its Freshness state is not fabricated.

Prose, aliases, keywords and model calls are never used to invent assertions. Ambiguous project identity, malformed assertions, mixed Candidate IDs, unsupported scope, corrupted records and concurrent versions are explicit skip/failure reasons.

## 3. Two-phase state machine

`SqliteLegacyKnowledgeMigrationStore` owns immutable preview headers and items:

```text
DRAFT_PREVIEW -> READY -> COMMITTING -> COMPLETED
                         -> FAILED
READY/FAILED/COMPLETED -> ROLLING_BACK -> ROLLED_BACK | ROLLBACK_CONFLICT
```

A dry run scans bounded Registry pages and stores for every considered asset: exact asset/version/content hash/index version, classification, projected assertion hash, source kind and reason codes. It records the Registry `activeIndexVersion`, counters and a canonical `summaryHash`. It writes no Recipe, Freshness or Verification data.

Commit requires `migrationId`, `expectedRevision`, an idempotency key and the exact current Registry revision. The command CAS-transitions the preview to `COMMITTING`, then enqueues one `LEGACY_KNOWLEDGE_MIGRATION` durable job. The job input contains the migration identity and preview revision; the durable checkpoint owns the page cursor. After the first successful registry-revision gate, resumptions validate each target's exact version/content hash rather than rejecting unrelated later Registry changes.

## 4. Per-item execution

For each migratable item the handler:

1. reloads and validates the exact Registry current asset;
2. reconstructs the deterministic Candidate/assertions and verifies their preview hash;
3. calls the production Verification service with a stable request identity and bounded deadline;
4. transactionally saves a migration-owned Recipe when absent;
5. transactionally projects migration-owned Freshness with the verification code/graph revision and final state:
   - all selected assertions `SUPPORTED` -> `FRESH`;
   - any `REFUTED` -> `CONFLICT`;
   - any `UNKNOWN/ERROR` -> `UNKNOWN`;
6. stores a bounded item receipt, then advances the durable job checkpoint.

Target-store methods record `migrationId` in the same SQLite transaction as the derived row. This closes the crash window between an external write and an audit receipt.

## 5. Rollback

Rollback never touches Registry, Markdown, Candidate data or verification run history. It visits successful item receipts in reverse order and asks each target store to delete only rows still owned by the same migration.

- Recipe deletion requires exact migration ownership and unchanged assertion hash.
- Freshness deletion requires the same active asset/version and no later Freshness state transition/event. Otherwise the item enters the conflict list.
- Index rebuilding is requested after successful derived-data deletion; formal knowledge versions are not rolled back.

Rollback is idempotent and revision-checked. Any conflicting item produces `ROLLBACK_CONFLICT` and remains intact for operator review.

## 6. Failure, privacy and limits

- Registry corruption, source revision mismatch, target drift and malformed preview payload fail closed with stable codes.
- Individual unverifiable knowledge is an explicit skipped/`UNKNOWN` result, not a guessed success.
- Preview and diagnostics contain identifiers, hashes, counts, enum reasons and bounded summaries; they do not duplicate knowledge bodies, prompts, command environments or raw CodeGraph output.
- Page size is 1..1000; total scan and item limits are bounded; cancellation and job fencing are checked before each external effect.
- A terminal durable job failure emits `MIGRATION_FAILED` through the existing local alert sink.

## 7. Composition

The new package depends on ports for Registry reads, Recipe/Freshness migration writes, Verification and job context. It has no dependency on Sidecar, Markdown, Codex, CodeGraph CLI or the browser. Sidecar owns its SQLite audit store, registers the job handler, supplies production adapters and closes resources after workers stop.
