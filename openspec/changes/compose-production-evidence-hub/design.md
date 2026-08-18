## Context

The repository already separates domain assertions, verifier policy, CodeGraph facts, Knowledge Worker checkpoints, and Freshness state. The missing boundary is production composition:

- `apps/sidecar/src/p2-production.ts` creates synthetic results that support/refute user statements and returns `UNKNOWN` for every other assertion.
- `apps/sidecar/src/p2-freshness-runtime.ts` creates a verifier registry with only a CodeGraph symbol probe.
- `EvidenceVerificationPort` receives no loaded Snapshot, so command/test/user observations cannot be proven against the exact immutable Ledger range consumed by the compiler.
- `CodeIntelligencePort` exposes symbols, callers, and impact, but no normalized graph revision or bounded path trace.
- `CROSS_PROJECT_VERIFIED` exists in the domain and policy but intentionally has no MVP verifier.

The design must preserve local-first operation, the immutable Ledger/Knowledge boundary, fail-open Codex hooks, fail-closed publication, non-shell CodeGraph invocation, and the current Preview-only production default.

## Goals / Non-Goals

**Goals:**

- Make one service the production verification entry point for Candidate policy and Freshness.
- Register all domain assertion kinds and add call-path/impact assertions required by the upper design.
- Bind every batch to one project, observation time, code revision, and optional graph revision.
- Derive user/command/test observations only from the exact loaded Snapshot; never execute a command or test.
- Provide repository-contained, bounded, read-only file/config/manifest probes.
- Persist integrity-checked recipes and immutable bounded run summaries.
- Keep CodeGraph vendor details and raw output outside Evidence, Knowledge, APIs, and logs.

**Non-Goals:**

- Running tests or commands in the background.
- Initializing or synchronizing CodeGraph.
- Repair drafts, Durable Freshness jobs, alerting, UI, or automatic publication.
- Treating unsupported REGEX/STRUCTURAL languages as text matches.
- Rewriting existing Knowledge or Ledger data.

## Decisions

### 1. Add an application service, not more Sidecar-local verifier functions

Add `packages/knowledge-verification` with:

- `KnowledgeVerificationService` and request/batch contracts.
- `SqliteKnowledgeVerificationStore` for recipes and run summaries.
- probe composition contracts and strict batch validation.

Add `packages/evidence-probes` for read-only adapters that implement `evidence-engine` probe ports. `evidence-engine` remains the assertion-to-Evidence domain mapper; it does not learn about filesystems, Ledger SQLite, CodeGraph CLI, or the verification database.

Alternative: compose probes directly in both Sidecar runtimes. Rejected because validation, revision identity, reason codes, storage, and safety limits would diverge again.

### 2. Extend the Worker evidence port with immutable Snapshot context

Replace the positional production call with a request object:

```ts
interface EvidenceVerificationRequest {
  candidate: KnowledgeCandidate;
  project: ProjectContext;
  requestedAt: string;
  purpose: "CANDIDATE" | "FRESHNESS" | "PRE_INJECTION";
  snapshot?: LoadedLedgerSnapshot;
  assertionIds?: readonly string[];
  expectedCodeRevision?: string;
}
```

The Knowledge Worker passes `checkpoint.payload.ledger` during Candidate policy. Freshness passes no Snapshot and therefore command/test/user statements that cannot be independently proven at the new revision resolve to `UNKNOWN`; historical Evidence remains preserved but is not treated as a current observation.

Alternative: let the Sidecar service re-read Ledger by candidate source Episode. Rejected because it can read beyond the immutable compiler range and makes verification depend on mutable external lookup timing.

### 3. Use a single batch identity and reject structurally invalid output

`KnowledgeVerificationBatch` contains `runId`, purpose, project, code revision, optional graph revision, observed time, and exactly one result for every requested assertion. The service validates the complete batch before appending a run summary or returning results.

- Project code revision is `git:<head>:<dirtyDigest>` when a Git repository is available.
- Non-Git repositories use a deterministic bounded project fingerprint and capability is `DEGRADED`.
- Graph revision comes from normalized CodeGraph status/index metadata. Provider version is not a graph revision.
- A graph revision change during a batch causes a retryable batch failure; mixed facts are never returned.

Alternative: let each probe report its own revision. Rejected because policy could combine mutually inconsistent observations.

### 4. Extend normalized Code Intelligence narrowly

Add:

```ts
interface CodeIntelligenceCapability { indexRevision?: string }
interface CodeCallPathFact { from: string; to: string; symbols: string[]; paths: string[] }
trace(project, from, to, maxDepth, limit): Promise<CodeFactResult<CodeCallPathFact>>
```

CodeGraph CLI 0.9.4 does not expose the MCP server's native `trace` operation. The first Adapter implementation therefore performs a strictly bounded breadth-first traversal over CLI `callees` through `ProcessPort` with `shell:false`: assertion depth is capped at 32, visited symbols and process calls are capped at 100, every expansion has a result limit, and the whole traversal shares the adapter deadline. It validates normalized facts and caches by project fingerprint plus operation parameters. A future provider-native trace can replace this implementation behind the same port. `impact` remains the source for `IMPACT_CONTAINS`.

`indexRevision` is a SHA-256 fingerprint of the normalized status snapshot (`file/node/edge counts`, DB size/backend, languages, node-kind counts, and pending-change counters), never the provider version. A status with pending changes is not usable as current graph Evidence and produces `CODEGRAPH_INDEX_STALE`.

Alternative: expose MCP ToolHandler internals directly to the Sidecar. Rejected because the current deployable boundary is the CLI executable and ToolHandler is not a stable import API. Unbounded recursive callers/callees search is also rejected; only the explicitly capped traversal above is allowed.

### 5. Implement local probes behind one repository boundary

`RepositoryReadPort` resolves a canonical relative path beneath `realpath(repositoryRoot)`, rejects absolute paths, `..`, NUL/newlines, symlink escape, non-regular files, and files above the configured byte limit.

- `FILE_CONTAINS/EXACT`: bounded byte/string equality or containment according to the verifier target contract.
- `FILE_CONTAINS/REGEX`: runs only through a registered bounded evaluator; no raw unbounded `RegExp` on the Sidecar thread.
- `FILE_CONTAINS/STRUCTURAL`: runs only through a registered language parser; unsupported languages return `UNKNOWN`.
- `DEPENDENCY_PRESENT`: deterministic parsers for package.json, pom.xml, Gradle dependency declarations, Cargo.toml, and go.mod. Version constraints are compared only when the parser can normalize them.
- `CONFIG_EQUALS`: JSON, YAML, TOML, and Java properties parsers with bounded key depth and scalar results.

Parser/evaluator absence is capability unavailability (`UNKNOWN`), not refutation. Exact mode and supported manifest/config formats are required in the first implementation; optional modes must never degrade to a weaker comparison.

### 6. Build session observations once from the loaded Snapshot

`SnapshotObservationIndex` scans only bounded Ledger records already held in the Worker checkpoint and stores hashes/status/sequence references, not raw command output. User statement probes require the referenced statement/event to exist in that range. Command and test probes require a matching command/test identity and expected exit/success state in that range.

Model-authored user assertions are still removed and reconstructed by the existing commitment compiler. The probe only proves the reconstructed reference; it cannot create authorization.

Alternative: trust Candidate evidence hints. Rejected because hints are model output and are not authorization or execution proof.

### 7. Implement cross-project verification from current verified runs

`CrossProjectVerificationProbe` queries the verification store for distinct canonical project identities supporting the same `subjectKey`. It counts only completed, integrity-valid, non-expired runs whose referenced Knowledge version remains current and whose Freshness is `FRESH` when code-related. Worktrees and branches of one repository do not count as different projects.

Insufficient valid projects is `REFUTED`; unavailable dependencies or ambiguous identities are `UNKNOWN`.

Alternative: count Candidate/Knowledge rows. Rejected because duplicated or stale claims are not independent verification.

### 8. Keep recipes version-bound and run summaries content-free

Use `knowledge-verification.sqlite` with strict tables:

```text
verification_recipes(asset_id, asset_version, recipe_version,
  assertions_json, assertions_hash, created_at)
code_verification_runs(run_id, request_id, purpose, project_id,
  asset_id?, asset_version?, code_revision, graph_revision?, status,
  result_summary_json, result_hash, started_at, completed_at)
```

Recipes are projected at publication from the exact Candidate assertions. Same key/same payload is idempotent; same key/different payload fails. Run summaries contain IDs, kinds, status, reason codes, revisions, timestamps, and hashes only—no conversation, command output, file content, or Knowledge body.

Alternative: add tables to the Freshness database. Rejected because Candidate verification also exists before publication and must not depend on Freshness lifecycle ownership.

### 9. Compose once and inject into both runtimes

`P2ProductionComposition` owns the verification store, project fact providers, and `KnowledgeVerificationService`. Candidate policy calls it with the loaded Snapshot. `P2FreshnessRuntime` receives a service port from composition and no longer constructs a registry or CodeGraph adapter internally.

The Sidecar closes the service/store after workers stop. Configuration replacement uses validate-then-swap and closes rejected candidates without replacing the running service.

## Risks / Trade-offs

- [Adding assertion kinds changes exhaustive switches] → Update domain schemas, compiler schema/prompt, policy maps, invalidation anchors, fixtures, and compile-time exhaustiveness tests in one change.
- [Snapshot records increase verifier input size] → Reuse the already bounded checkpoint payload and build one compact observation index per work, not per assertion.
- [File parser vulnerabilities or ReDoS] → Hard byte/depth/time limits; registered evaluator/parser only; unsupported modes return `UNKNOWN`.
- [Graph revision is unavailable in some CodeGraph versions] → Report a stable reason code and `UNKNOWN`; never substitute provider version.
- [Cross-project counts become stale] → Require current Knowledge identity and Freshness; store unavailability returns `UNKNOWN`.
- [Separate SQLite stores can diverge] → Immutable run IDs, request idempotency, correlation IDs, integrity hashes, and startup consistency checks; no cross-store distributed transaction is claimed.
- [More real Evidence can change policy outcomes] → Production remains Preview-only; compare old/new verdicts in tests and do not enable publication in this change.

## Migration Plan

1. Add assertion/schema contracts and update exhaustive pure-domain consumers while production still uses the old port.
2. Add Code Intelligence call-path/index-revision contracts and adapter tests, preserving existing symbol/callers/impact behavior.
3. Add `evidence-probes` and `knowledge-verification` stores/services with direct tests.
4. Change the Worker evidence request and migrate every test/adapter compile-time.
5. Compose the service into Candidate production and Freshness; remove `evidenceFor` and `CodeGraphFreshnessVerifier` only after integration tests pass.
6. Run Preview-only replay and compare Candidate policy/Freshness outcomes. No existing Ledger, Markdown, Registry, or Freshness migration is required.

Rollback is code-only: the new database is additive and can be left unused. Reverting composition restores UNKNOWN behavior without changing existing Knowledge. A release rollback must not delete the verification database.

## Open Questions

None. Safe defaults are fixed: unsupported parser/trace capability is `UNKNOWN`, Snapshot evidence is never re-executed, the database is separate, and publication remains disabled.
