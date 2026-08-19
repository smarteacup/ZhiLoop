## 1. Domain and schema contracts

- [x] 1.1 Add authoritative Git revision, claim mode, scenario hint, KnowledgeLocator, branch applicability and scenario relation domain types with validation and hash coverage
- [x] 1.2 Extend Candidate/Asset, extraction, Evidence and QueryContext schemas with backward-compatible v1 reads and strict v2 writes
- [x] 1.3 Add domain/schema fixtures covering valid locators, malformed model coordinates, legacy assets and claim-mode invariants

## 2. Authoritative localization

- [x] 2.1 Extend the Git project probe and ProjectContext resolver with commit and dirty state using bounded shell-free argv execution
- [x] 2.2 Enrich model Candidate drafts from authoritative ExtractionProjectContext and derive stable scenario IDs without trusting model repository/revision fields
- [x] 2.3 Add locator completeness and claim-mode gates to Scope/Evidence policy, including PENDING_IMPLEMENTATION and INVALID_ASSERTION behavior
- [x] 2.4 Verify localization and evidence behavior with compiler, project identity and policy unit tests

## 3. Scenario registry and evolution

- [x] 3.1 Add versioned scenario, binding and relation projection tables with deterministic rebuild and migration behavior
- [x] 3.2 Implement bounded deterministic scenario reconciliation and explicit PENDING decisions for unsafe merge/split cases
- [x] 3.3 Render human-readable scenario cards/Markdown from the projection and preserve knowledge/source provenance
- [x] 3.4 Add registry/evolution tests for update, duplicate, overlap, branch conflict, rebuild and rollback

## 4. CodeGraph artifact reuse

- [x] 4.1 Add bounded CodeGraphArtifact types and capture normalized symbol, call-path and impact results in Verification output
- [x] 4.2 Persist artifacts and knowledge bindings in checkpoint/outbox/Registry projection with content-hash collision checks
- [x] 4.3 Implement revision/dependency compatibility, reuse decisions and SUSPECT invalidation hooks for changed files/symbols
- [x] 4.4 Add adapter, Evidence, persistence and freshness tests for reuse, mismatch, bounded results and changed graph output

## 5. Scenario-aware retrieval and injection

- [x] 5.1 Carry authoritative branch/commit through QueryContext and retrieval traces
- [x] 5.2 Apply project, branch/commit, freshness and locator eligibility before retrieval ranking with stable filter reason codes
- [x] 5.3 Build a bounded scenario directory, group knowledge pointers by scenario and rank using task intents, entry points, symbols and paths
- [x] 5.4 Extend progressive-disclosure rendering and Pull eligibility so only selected scene knowledge expands to L2/L3
- [x] 5.5 Add retrieval, reranker, budget, Hook and MCP tests proving cross-project/branch isolation and bounded disclosure

## 6. Console and operations

- [x] 6.1 Extend Console API views with locator, claim mode, scenario cards, artifact summaries and filter diagnostics
- [x] 6.2 Update session extraction, knowledge detail and query pages with localized project/branch/scenario/evidence presentation
- [x] 6.3 Add safe scenario navigation and read-only drill-down between session, knowledge, scenario and CodeGraph provenance
- [x] 6.4 Add API/component tests for complete, legacy, stale, incompatible-branch and unavailable-artifact states

## 7. Migration, verification and review

- [x] 7.1 Add a non-destructive legacy localization projection/rebuild command and document rollout/rollback configuration
- [x] 7.2 Run focused package tests after each module and fix all discovered correctness, concurrency and performance issues
- [x] 7.3 Run dependency checks, lint, build, typecheck and the complete test suite
- [x] 7.4 Review the full diff for compatibility, stale-state, publication, data-loss and context-budget risks and apply fixes

## 8. Real-session acceptance and report

- [x] 8.1 Re-run extraction for session `019fd5da-9272-7261-9467-66e07ce46bbd` with an immutable new compiler/prompt snapshot
- [x] 8.2 Inspect every extracted Candidate for content, project, branch/commit, scenario, claim mode, applicability, exclusions and Evidence coverage
- [x] 8.3 Simulate matching and non-matching project/branch/scenario prompts, verify CodeGraph reuse, and tune extraction/retrieval when results deviate
- [x] 8.4 Produce a traceable implementation and acceptance report containing requirements, changes, tests, candidate results, retrieval results, limitations and follow-ups
