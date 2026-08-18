# Design: Knowledge freshness projection and planner

The projection stores one integrity-hashed payload per active asset version plus indexed `PATH/SYMBOL/CONFIG/DEPENDENCY` anchors derived from the source Candidate. It deliberately does not modify KnowledgeAsset schema.

Publication order is Markdown -> Registry -> Freshness -> search index. A crash is replay-safe because projection is version/content idempotent. A different payload for the same asset version fails closed.

Change lookup accepts only normalized repository-relative paths and bounded sets. It returns asset/version identities, not knowledge bodies. Planning reloads the integrity-checked record, reuses `evaluateInvalidation`, and maps its result to the independent freshness state:

- no related change or successful revalidation: FRESH;
- affected but not yet revalidated: REVALIDATE;
- refuted/insufficient evidence on authoritative implementation knowledge: CONFLICT with a MARK_STALE plan;
- invalid or unavailable observations: UNKNOWN.

The planner never edits Markdown. It returns an expected version and lifecycle target for the governance mutation boundary to apply with CAS.
