## ADDED Requirements

### Requirement: Revision-bound injection eligibility
The pre-injection gate SHALL admit a code-related knowledge version as a current fact only when its exact project, asset version, content hash, code revision, and required graph revision are proven current.

#### Scenario: Exact Freshness projection is current
- **WHEN** an exact candidate has a matching `FRESH` projection for the current observed revision
- **THEN** the gate admits it without new verification or job creation

#### Scenario: Projection is missing or mismatched
- **WHEN** a required projection is absent or its project/version/content/revision does not match
- **THEN** the gate excludes it from current facts and creates or reuses asynchronous compensation

#### Scenario: Knowledge does not require code freshness
- **WHEN** an eligible knowledge version contains no code-related kind, symbol, path, configuration, dependency, call-path, or impact anchor
- **THEN** CodeGraph or Git unavailability alone does not exclude it from historical/non-code context

### Requirement: Bounded targeted synchronous verification
The gate MAY synchronously verify only final retrieved candidates whose immutable Recipes and observed project revision are already available, and MUST enforce a monotonic deadline, item cap, cancellation, and exactly-one-result validation.

#### Scenario: Small stale set is verified within budget
- **WHEN** a bounded set of `REVALIDATE` candidates has complete Recipes and sufficient remaining budget
- **THEN** the shared Verification Service evaluates only those assertions and the gate admits only exact versions projected `FRESH`

#### Scenario: Remaining budget is insufficient
- **WHEN** the minimum verification budget is unavailable
- **THEN** the gate performs no synchronous probes, excludes affected current facts, and returns durable revalidation job IDs

#### Scenario: Synchronous verifier exceeds deadline
- **WHEN** verification exceeds the smaller of the caller deadline and configured gate timeout
- **THEN** it is cancelled, all unproven current facts remain excluded, and asynchronous jobs are returned without failing the Hook

### Requirement: Fail-open conversation and fail-closed facts
Job, Git, CodeGraph, Recipe, Verification, or Freshness failures MUST NOT block the Codex Hook and MUST NOT allow an unproven code fact into the current-fact partition.

#### Scenario: Job store is degraded
- **WHEN** asynchronous compensation cannot be persisted
- **THEN** the gate returns a structured degraded exclusion, injects no affected current fact, and allows the prompt to continue

#### Scenario: CodeGraph is not configured
- **WHEN** a required graph assertion cannot be evaluated because CodeGraph is unavailable or stale
- **THEN** the result remains `UNKNOWN`, the asset is excluded, and no automatic CodeGraph initialization is attempted

### Requirement: Idempotent asynchronous compensation
Every excluded version needing revalidation SHALL return a deterministic existing or newly-created `KNOWLEDGE_REVALIDATE` job identity without generating duplicate active work for the same project, source revision, and version set.

#### Scenario: Repeated prompts hit the same stale version
- **WHEN** multiple prompts encounter the same stale knowledge and observed revision
- **THEN** all gate results reference the same compensation job and the queue contains one logical revalidation request

### Requirement: Injection gate latency and diagnostics
The production gate MUST return within 200ms at P95 under the defined acceptance fixture and SHALL expose bounded exclusion reason codes, capability, completion-within-budget, and compensation job IDs.

#### Scenario: Background verifier hangs
- **WHEN** a verifier or store call does not finish before the gate deadline
- **THEN** the gate aborts or detaches it safely, returns within the budget, and records a timeout exclusion without an unhandled rejection

#### Scenario: Active injection reports exclusions
- **WHEN** current candidates are excluded by Freshness
- **THEN** retrieval diagnostics identify each bounded asset and stable reason code while omitting knowledge bodies and raw evidence output
