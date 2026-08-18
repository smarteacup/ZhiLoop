# Bounded semantic evolution and durable operational alerts

## 1. Decision boundary

`classifyKnowledgeEvolution` remains the primary decision engine. A semantic call is permitted only when deterministic evaluation returns `PENDING`, the supplied target set is non-empty, and the adapter is configured. At most five exact target versions are supplied to one call.

The adapter serializes a reduced view containing candidate identity, kind, title, summary, subject, proposed scope, typed assertions and source IDs, plus target identity, kind, title, summary, subject, scope, lifecycle status, authority, aliases, symbols and evidence IDs. It does not serialize bodies, conversation events, process environment, or raw CodeGraph output.

The response schema allows only `SUPPLEMENT`, `SUPERSEDE`, `CONTRADICT`, `SCOPE_SPLIT`, or `SKIP`, exact target versions from the request, a bounded single-line reason, and confidence. Domain code independently validates action, target membership, target uniqueness and action-specific target cardinality. Because the model cannot return a scope, scope widening is structurally impossible. Invalid output, timeout, cancellation, unavailable runtime, or any thrown error produces a `PENDING` decision with a stable reason code.

## 2. Codex execution

The existing read-only Codex adapter gains a generic structured-generation method with a fixed operation identifier, trusted instructions, explicitly untrusted JSON input, an output schema, a stable run key, an abort signal, and bounded diagnostics. It keeps the same read-only sandbox, ephemeral task, ignored repository rules, result-size limits, sanitized process events, temporary-file cleanup, and no prompt/result retention.

The semantic package owns prompt policy, redaction-by-projection, response parsing, and health state. A success reports `READY`; execution or output failure reports `DEGRADED` with a stable reason. Disabled composition creates no adapter and reports `DISABLED`.

## 3. Durable alert model

`SqliteOperationalAlertStore` stores one current row per deduplication key and immutable emission receipts. An emission validates bounded identifiers and reason codes, canonicalizes them, then transactionally creates or updates the row. Emissions inside the configured cooldown increment `occurrenceCount` without requesting another external delivery. Emissions after cooldown may attempt delivery again.

When no provider exists, every record is `LOCAL_ONLY`; the system never labels it delivered. Provider success records `DELIVERED`, while provider failure records `DELIVERY_FAILED` but preserves the local alert. Payloads contain only type, severity, project/entity references, reason codes, timestamps, count, and delivery metadata.

## 4. Producers

- `EvolutionJobRuntime.runOnce`: terminal `FAILED` emits `PERMANENT_JOB_FAILURE` using the job ID and sanitized failure code.
- Revalidation verification: CodeGraph-unavailable classifications emit `CODEGRAPH_UNAVAILABLE` for the project/source boundary.
- Durable Freshness conflict transition: emits `STALE_KNOWLEDGE` for the exact knowledge version and stable reason codes.

Each producer is controlled by `evolutionAlerts.enabled` and its existing per-type switch. Producer failures are best-effort and must not change the primary job result; the local store itself is deterministic and independently tested.

## 5. Control and UI

The control query API exposes a bounded, cursor-free first page of active durable alerts because the initial console requirement is operational visibility, not historical analytics. The Sidecar returns already-sanitized records. The console renders type, severity, local/delivery state, count, reason, entity, first/last observation, and capability state.

## 6. Failure and recovery

- Semantic disabled/unavailable: deterministic result is unchanged and ambiguity remains `PENDING`.
- Invalid/out-of-set model target: `PENDING`; no publication side effect.
- Alert store restart: current counts and delivery status survive.
- Duplicate producer replay: same dedup key aggregates rather than multiplying alerts.
- External provider outage: local persistence succeeds and status is `DELIVERY_FAILED`; primary evolution flow continues.
- Alert database failure: producer callback is contained and a privacy-safe operator diagnostic is recorded where available.

## 7. Acceptance proof

Tests must cover one-call gating, summary-only prompt shape, timeout/error/invalid JSON/out-of-set targets, disabled and degraded capability projection, SQLite permissions/integrity/restart/cooldown/idempotency, all three producer switches, local-only semantics, control schema and console rendering, and absence of sensitive bodies/raw output.
