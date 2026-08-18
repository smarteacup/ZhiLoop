# Design

Immutable publication projections remain keyed by `(assetId, assetVersion)`. A separate current state row tracks FRESH/REVALIDATE/CONFLICT/UNKNOWN with a CAS revision. Every actual transition appends an immutable event containing reason codes and the shared code/graph revision.

The worker first resolves all affected active versions under a hard limit, derives affected assertion IDs, and calls one batch verifier. Results that are duplicated, refer to unrequested assertions, or use mismatched project/revision identities fail closed before state writes.

Repeated identical observations are idempotent. A REFUTED result records CONFLICT and a `MARK_STALE` repair action, but does not rewrite the knowledge body or silently publish a lifecycle version.
