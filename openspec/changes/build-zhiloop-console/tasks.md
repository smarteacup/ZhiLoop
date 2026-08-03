## 1. P0a Contract and Test Foundation — Serialized Owner

- [ ] 1.1 [Contract Owner] Add `packages/control-api` workspace with versioned request, response, error, pagination, ID, Capability, Stage, Job, Injection, configuration and SSE schemas
- [ ] 1.2 [Contract Owner] Define stable reason-code registries and legal state transitions, including `DISABLED`, `NOT_CONFIGURED`, `NOT_VERIFIED`, `SHADOWED` and `INJECTED`
- [ ] 1.3 [Contract Owner] Define session → turn → source sequence → snapshot → run → trace → knowledge version relationships and redacted contract fixtures
- [ ] 1.4 [Contract Owner] Add unknown-version, unknown-field, byte-limit, invalid-state, cursor-tamper, expected-revision and idempotency contract tests
- [ ] 1.5 [Integration Owner] Add new Console workspaces to dependency/import policy, TypeScript references and explicit coverage include; make an empty-test Console workspace fail checks
- [ ] 1.6 [Integration Owner] Add `console-p0-contract-gate` to `npm run check` and complete Contract Review before opening parallel implementation lanes

## 2. P0b Read-Only Data Foundations — Parallel Wave 1

- [ ] 2.1 [Session Lane] Create `packages/session-catalog` with bounded primary-session metadata, source capability and stable list/query ports
- [ ] 2.2 [Session Lane] Implement versioned transcript catalog fallback with path, symlink, size, depth, format and source-unavailable protections
- [ ] 2.3 [Session Lane] Add App Server catalog adapter behind the same port when a compatible source is available, with deterministic fallback rather than merged duplicate sessions
- [ ] 2.4 [Session Lane] Implement time grouping, `lastActivityAt DESC, sessionId ASC` ordering, title fallback and `DISCOVERED_NOT_CAPTURED/CAPTURED_PARTIAL/CAPTURED_CURRENT/SOURCE_UNAVAILABLE`
- [ ] 2.5 [Session Lane] Test multi-version fixtures, malformed and unsupported sources, duplicate IDs, incremental rescan, unchanged rescan and no Codex file mutation
- [ ] 2.6 [Operational Lane] Create `packages/operational-read-model` with capability, session, stage, job and diagnostic projections and bounded query ports
- [ ] 2.7 [Operational Lane] Add forward-only migration and rebuild logic for capability snapshots, session catalog/projection, stage runs and operator-safe diagnostics
- [ ] 2.8 [Operational Lane] Implement stable cursor pagination, redacted event metadata, Ledger/consumer lag, spool, worker and storage health queries
- [ ] 2.9 [Operational Lane] Test migration rollback, projection rebuild equivalence, 100,000-event pagination and zero raw prompt/secret leakage
- [ ] 2.10 [Integration Owner] Merge Session then Operational lanes, update shared workspace files once, and complete Module Review for P0 read-only foundations

## 3. P0b Gateway and Web Shell — Parallel Wave 2

- [ ] 3.1 [Gateway Lane] Create `apps/console-gateway` with loopback-only bind, bounded HTTP server, static asset serving and Unix-socket Control API client
- [ ] 3.2 [Gateway Lane] Implement one-time bootstrap exchange, short-lived HttpOnly SameSite session, Host/Origin/CSRF checks, no CORS, CSP and safe response headers
- [ ] 3.3 [Gateway Lane] Expose read-only `/api/v1/overview`, `/capabilities`, `/sessions`, `/sessions/{id}`, `/events`, `/jobs` and `/diagnostics` routes from typed query ports
- [ ] 3.4 [Gateway Lane] Add authentication, forgery, remote-bind, traversal, oversized-response, timeout, rate-limit and redaction tests
- [ ] 3.5 [Web Platform Lane] Create `apps/console-web` with the approved minimal React/TypeScript/Vite toolchain, local static assets, router registration points and typed Control API client
- [ ] 3.6 [Web Platform Lane] Implement application shell, navigation, project filter, capability badges and shared loading/empty/disabled/error/conflict components
- [ ] 3.7 [Web Feature Lane] Implement Overview, Capability Matrix, Jobs/Diagnostics and Deployment read-only pages against frozen fixtures
- [ ] 3.8 [Web Feature Lane] Implement Codex-like read-only session groups, filters, detail tabs, event metadata, cursor and production-chain disabled states
- [ ] 3.9 [Web Feature Lane] Add keyboard, accessible name, focus, color contrast, responsive desktop and no-browser-persistence tests
- [ ] 3.10 [Integration Owner] Install dependencies and update root lockfile once, merge Gateway and Web lanes, then complete Gateway security and UI Module Reviews

## 4. P0c Sidecar Integration and First Usable Console — Serialized

- [ ] 4.1 [Sidecar Owner] Extend the Sidecar Unix-socket protocol with versioned bounded query requests without changing existing hook/health/worker/capture behavior
- [ ] 4.2 [Sidecar Owner] Compose Session Catalog and operational query ports while preserving Sidecar as the only Ledger writer
- [ ] 4.3 [Sidecar Owner] Add injection capability placeholders that report real `DISABLED/NOT_VERIFIED` reason codes instead of synthesized UI status
- [ ] 4.4 [Sidecar Owner] Expose capture dry-run as a Console command and bind commit to session identity, preview revision and idempotency key
- [ ] 4.5 [Web Feature Lane] Add capture preview, stale-preview, commit, duplicate and unavailable-sidecar interaction states to the session page
- [ ] 4.6 [Integration Owner] Add `zhiloop ui` launcher and local release packaging for Gateway and Web assets without making Gateway part of the Hook path
- [ ] 4.7 [Quality Owner] Add browser E2E for bootstrap → overview → session list → detail → capture preview/commit and verify no Codex session mutation
- [ ] 4.8 [Quality Owner] Run P0 performance and security Gate: ≥99% catalog fixture coverage, Overview P95 <300ms, 100k-event list P95 <500ms, Hook P95 delta <5ms, unauthorized requests 100% rejected
- [ ] 4.9 [Integration Owner] Complete Integration and Release Reviews, document actual P0 capability matrix, and deploy only after all P0 Gates pass

## 5. P1 Durable Jobs and Automatic Ingestion — Parallel Wave 3

- [ ] 5.1 [Job Owner] Define durable job, attempt, lease, checkpoint, retryable failure, cancellation and idempotency state machines in the frozen Control API
- [ ] 5.2 [Job Owner] Implement job persistence, lease fencing, heartbeat, bounded retry, exponential backoff, jitter and restart recovery in a dedicated runtime package
- [ ] 5.3 [Job Owner] Test duplicate claim, expired lease, crash after side effect, checkpoint resume, non-retryable errors and cancellation boundaries
- [ ] 5.4 [Ingestion Lane] Implement bounded session scan scheduler, incremental discovery, follow debounce and session completeness checks without a zero-delay loop
- [ ] 5.5 [Ingestion Lane] Compose existing backfill with durable checkpoints, source rotation/truncation diagnostics and idempotent recovery
- [ ] 5.6 [Ingestion Lane] Add parent/child session relation metadata where observable without blocking primary-session delivery on complete sub-Agent aggregation
- [ ] 5.7 [Ingestion Lane] Validate a newly created real Codex task through Hook → spool → Ledger → catalog/cursor and record `NOT_VERIFIED` until this acceptance succeeds
- [ ] 5.8 [Web Feature Lane] Add job progress, attempt, retry, safe cancellation, backlog, last-success and ingestion completeness views
- [ ] 5.9 [Integration Owner] Serially compose Job and Ingestion lanes into Sidecar and verify Hook deadlines during scan, follow, backfill and retry load

## 6. P1 Configuration, Alerts and Live Updates — Parallel Wave 4

- [ ] 6.1 [Configuration Owner] Extend configuration schemas for active consumers: scan interval, worker poll, capture retry/backoff, batch limits and in-console alert thresholds
- [ ] 6.2 [Configuration Owner] Add bounded draft fields for future injection, compiler and Codex query consumers, and reject their activation while capabilities are disabled
- [ ] 6.3 [Configuration Owner] Create `packages/configuration-service` with effective source resolution, GLOBAL/PROJECT override, draft, validate, diff and expected revision
- [ ] 6.4 [Configuration Owner] Implement prepare/apply activation, immutable history, last-known-good rollback and secret-safe operator audit as one serialized transaction boundary
- [ ] 6.5 [Configuration Owner] Test stale revision, unknown field, consumer disabled, component partial failure, restart-required field, rollback and secret redaction
- [ ] 6.6 [Observability Lane] Create `packages/observability` alert evaluation for spool lag, cursor lag, failed jobs, Hook silence and quiet hours without hiding health state
- [ ] 6.7 [Gateway Lane] Implement bounded SSE invalidation, monotonic revision, Last-Event-ID resume, resync and polling fallback
- [ ] 6.8 [Web Feature Lane] Implement effective/draft/history configuration, field source, validation diagnostics, impact diff, activation and rollback interactions
- [ ] 6.9 [Web Feature Lane] Implement in-console alerts, live job/session invalidation and safe degraded-state notifications
- [ ] 6.10 [Integration Owner] Serially compose configuration activation into Sidecar, then run P1 restart recovery, no-call-storm, SSE bound and last-known-good Gates
- [ ] 6.11 [Integration Owner] Complete P1 Contract, Module, Integration and Release Reviews before enabling automatic ingestion by default

## 7. P2 Session Snapshot and Production Knowledge Worker — Parallel Wave 5

- [ ] 7.1 [Contract Owner] Freeze snapshot identity, completeness, source sequence, compiler version, policy hash, candidate preview and bidirectional provenance schemas
- [ ] 7.2 [Knowledge Worker Lane] Create a composition package for Ledger → normalize → episode → compile → scope → evidence → candidate policy processing
- [ ] 7.3 [Knowledge Worker Lane] Add durable stage checkpoints, retry classification and batch limits without importing Sidecar or UI modules
- [ ] 7.4 [Knowledge Worker Lane] Compose Markdown publish, Registry projection and incremental index through a recoverable outbox/stage record
- [ ] 7.5 [Knowledge Worker Lane] Test each failure boundary, replay, current-version consistency, index rebuild and no duplicate candidate/version behavior
- [ ] 7.6 [Extraction Lane] Implement session snapshot creation after incremental capture, including immutable `PARTIAL_SNAPSHOT` for active sessions
- [ ] 7.7 [Extraction Lane] Implement candidate preview and policy commit as separate idempotent jobs keyed by snapshot/compiler/policy versions
- [ ] 7.8 [Extraction Lane] Persist session/turn/event ↔ snapshot ↔ episode ↔ knowledge version references and query ports in both directions
- [ ] 7.9 [Integration Owner] Serially compose extraction and knowledge worker stages into Sidecar with capability-aware activation

## 8. P2 Knowledge Browsing and Ordinary Governance — Parallel Wave 6

- [ ] 8.1 [Governance Owner] Implement bounded knowledge list/detail/version/Evidence/relation/provenance/usage query service over current Registry projections
- [ ] 8.2 [Governance Owner] Implement expected-version edit drafts, impact preview, Schema/Scope/Evidence revalidation and atomic current revision change
- [ ] 8.3 [Governance Owner] Implement ordinary project knowledge suppress, restore and supersede revisions with immediate default-retrieval exclusion
- [ ] 8.4 [Governance Owner] Add manual-Markdown conflict detection and refuse stale Console overwrite while preserving external content
- [ ] 8.5 [Governance Owner] Test Evidence downgrade, stale edit, publish/index partial failure, suppress latency, restore revalidation and immutable history
- [ ] 8.6 [Web Feature Lane] Implement session extraction snapshot, progress, Candidate preview, policy result and provenance interactions
- [ ] 8.7 [Web Feature Lane] Implement knowledge list, filters, detail, Markdown/version diff, Scope/Evidence/relations, edit impact and suppress/restore interactions
- [ ] 8.8 [Quality Owner] Add P2 single-session E2E from snapshot extraction through knowledge view, reverse trace, edit, suppress, restore and index recovery
- [ ] 8.9 [Quality Owner] Run P2 Gate: snapshot idempotency, 100% reverse provenance, suppress P95 <1s, outbox recovery and no current-version corruption
- [ ] 8.10 [Integration Owner] Complete P2 Reviews before enabling automatic compile triggers; retain explicit completeness labels for unsupported event types

## 9. P3 Deterministic Retrieval and Trace — Parallel Wave 7

- [ ] 9.1 [Contract Owner] Freeze natural-language search, QueryContext, retrieval result, Trace, Context Envelope simulation and answer citation schemas
- [ ] 9.2 [Retrieval Lane] Compose Exact, FTS, Vector, Relation, Scope/Status filtering, RRF and rerank behind a bounded Console query port
- [ ] 9.3 [Retrieval Lane] Persist channel contribution, retrieval/final rank, filter, Evidence, budget, omission and SHADOW injection reasons in Retrieval Trace
- [ ] 9.4 [Retrieval Lane] Implement current-policy search, draft-policy simulation and fixed-input replay without writing active feedback
- [ ] 9.5 [Retrieval Lane] Test exact symbols/errors/config, Scope isolation, stale version exclusion, timeout fallback, token budget and trace completeness
- [ ] 9.6 [Web Feature Lane] Implement dedicated Search Knowledge page, result explanations, channel/rank table, Trace detail and policy comparison lab
- [ ] 9.7 [Web Feature Lane] Add session Turn injection placeholders from persisted attempts and strictly distinguish `SHADOWED/INJECTED/NO_CONTEXT/TIMEOUT/ERROR`

## 10. P3 Codex-Assisted Ask ZhiLoop — Parallel Wave 8

- [ ] 10.1 [Codex Query Owner] Add a dedicated `CodexKnowledgeQueryModel` port and structured answer/citations/unknowns/conflicts schema without reusing extraction prompts
- [ ] 10.2 [Codex Query Owner] Implement safe cwd, minimal environment, user/MCP configuration policy, read-only ephemeral execution, output limits, timeout, cancellation and concurrency controls
- [ ] 10.3 [Codex Query Owner] Validate that every factual answer span references an eligible retrieved knowledge ID/version and move unsupported content to unknowns or reject the answer
- [ ] 10.4 [Codex Query Owner] Implement deterministic search fallback for unavailable, unauthenticated, rate-limited, timed-out or invalid Codex output
- [ ] 10.5 [Codex Query Owner] Persist model run diagnostics, latency and token usage without automatically creating knowledge, Codex conversations or project files
- [ ] 10.6 [Web Feature Lane] Implement “搜索知识 / 问 ZhiLoop” modes, citations, unknowns, conflicts, progress, cancellation and fallback states
- [ ] 10.7 [Configuration Owner] Activate retrieval and Codex query budgets only after their consumers report READY
- [ ] 10.8 [Quality Owner] Run P3 Golden and security Gates: traceability 100%, Scope leak/forbidden hit 0, automatic L4 0, factual citation coverage 100%, malicious knowledge cannot widen process permission
- [ ] 10.9 [Integration Owner] Complete P3 Reviews and keep all results SHADOW/read-only before starting P4

## 11. P4 MCP, Actual Injection and Session Attribution — Parallel Wave 9

- [ ] 11.1 [Injection Owner] Enable versioned local MCP transport for `ckl.search/get/related/check` with Scope, current-version and detail-level enforcement
- [ ] 11.2 [Injection Owner] Compose Context Orchestrator and UserPrompt injection behind rollout controller while preserving the 500ms fail-open deadline
- [ ] 11.3 [Injection Owner] Persist injection attempts and exact delivery result before displaying actual context on the session turn
- [ ] 11.4 [Injection Owner] Persist MCP L1 → L2/L3 expansion, knowledge version, latency and actual-use feedback without copying full payload into diagnostics
- [ ] 11.5 [Web Feature Lane] Add actual/SHADOW Context Envelope, token, omitted reason and MCP expansion views to the session and retrieval pages
- [ ] 11.6 [Quality Owner] Test timeout after retrieval, rollout revision change, Scope mismatch, stale knowledge, MCP prompt injection, fail-open and `SHADOWED` never becoming `INJECTED`

## 12. P4 Closure, Feedback and High-Risk Governance — Parallel Wave 10

- [ ] 12.1 [Closure Owner] Compose deterministic/semantic Gate verification, bounded Stop continuation, interaction policy and confirmation writeback
- [ ] 12.2 [Closure Owner] Persist Task Contract, Gate results, decision, correction delta, continuation count and recursive-stop rejection for Console queries
- [ ] 12.3 [Feedback Owner] Compose retrieval use, pin, suppress and complexity feedback without allowing feedback to bypass eligibility policy
- [ ] 12.4 [Governance Owner] Add separately gated GLOBAL promotion, RULE/Binding changes and privacy purge with blast-radius preview and Sidecar enforcement
- [ ] 12.5 [Web Feature Lane] Implement Closure run list/detail, Gate evidence, delta, continuation, interaction and feedback views
- [ ] 12.6 [Quality Owner] Run P4 closure Gate: no-human ratio ≥90%, recursive continuation 0, average continuation ≤0.2, boundary-violation success <1%, suppress repeat retrieval <2%

## 13. P4 SHADOW Quality, ACTIVE Eligibility and Release — Serialized

- [ ] 13.1 [Rollout Owner] Build quality evaluation from real SHADOW traces with dataset/config/version fingerprints and explicit eligibility evidence
- [ ] 13.2 [Rollout Owner] Implement scoped ACTIVE canary, revision-bound activation, automatic SHADOW downgrade and last-known-good rollback; reject single-boolean activation
- [ ] 13.3 [Rollout Owner] Test gray-scope exclusion, mid-request rollback, timeout with no partial context, restart recovery and effective revision consistency
- [ ] 13.4 [Quality Owner] Add full Console browser E2E for session → extraction → knowledge → search/ask → injection/MCP → closure and rollback
- [ ] 13.5 [Quality Owner] Run final architecture, dependency, lint, build, typecheck, unit, integration, coverage, browser, accessibility, security, performance and local release acceptance Gates
- [ ] 13.6 [Integration Owner] Review all capability states against actual composition, update deployment/runbook/TDD, and prevent release if any page hard-codes READY
- [ ] 13.7 [Integration Owner] Deploy P4 through the journaled installer, verify CCM credentials/config hash unchanged, monitor SHADOW/canary evidence, and retain CLI rollback

## 14. Change Completion

- [ ] 14.1 [Integration Owner] Verify every OpenSpec scenario has direct automated evidence or an explicitly documented real-environment acceptance
- [ ] 14.2 [Integration Owner] Perform final code review for correctness, concurrency, performance, privacy, security and module boundaries with no unresolved high-risk finding
- [ ] 14.3 [Integration Owner] Commit and push completed tasks with a clean worktree, then archive `build-zhiloop-console` only after all required capabilities are implemented and deployed
