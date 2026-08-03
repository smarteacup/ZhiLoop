# local-console-runtime Specification

## Purpose
TBD - created by archiving change build-zhiloop-console. Update Purpose after archive.
## Requirements
### Requirement: Local authenticated console boundary
The system SHALL serve the Console only on the current machine loopback interface, authenticate browser sessions through a one-time bootstrap exchange, and route all business writes through the Sidecar Control API.

#### Scenario: Authorized local browser opens the Console
- **WHEN** `zhiloop ui` opens a valid one-time bootstrap fragment from the current user
- **THEN** the Gateway exchanges it for a short-lived same-origin session without placing the secret in query parameters or logs

#### Scenario: Remote or forged request is rejected
- **WHEN** a request uses a non-loopback bind, invalid session, Host, Origin, or CSRF proof
- **THEN** the Gateway rejects it without forwarding a command to the Sidecar

### Requirement: Evidence-backed runtime states
The system SHALL expose versioned Capability, Stage, Job, and Injection states with a stable reason code, observation time, transition time, retryability, evidence references, and optional next action.

#### Scenario: Production knowledge worker is not composed
- **WHEN** Ledger capture is available but the production knowledge worker is absent
- **THEN** the Console displays the compile stage as `DISABLED` with reason `KNOWLEDGE_WORKER_NOT_COMPOSED` rather than as empty, successful, or failed

#### Scenario: Shadow retrieval completes
- **WHEN** retrieval builds a Context Envelope in SHADOW mode but no context is returned to Codex
- **THEN** the attempt is displayed as `SHADOWED` and never as `INJECTED`

### Requirement: Bounded operational views
The system SHALL provide paginated overview, capability, job, diagnostic, and deployment views whose responses are bounded, redacted, and safe to render without direct SQLite or filesystem access from the Gateway.

#### Scenario: Large local dataset is listed
- **WHEN** the Ledger contains at least 100,000 events
- **THEN** every list endpoint applies a server-side limit, stable order, and tamper-resistant cursor

#### Scenario: Console is unavailable
- **WHEN** the Gateway is stopped, overloaded, or fails a query
- **THEN** Codex Hook handling continues with its existing deadline and fail-open behavior

### Requirement: Real-time invalidation without duplicated business payloads
The system SHALL support bounded SSE invalidation events with monotonic revision, resume, and resync semantics, while keeping full business records in query APIs.

#### Scenario: Browser reconnects within the retained event window
- **WHEN** the browser reconnects with a valid Last-Event-ID
- **THEN** the Gateway resumes missed invalidations without duplicating state transitions

#### Scenario: Browser reconnects after the retained window
- **WHEN** the requested event revision is no longer retained
- **THEN** the Gateway emits a resync reason and the browser reloads bounded query views

### Requirement: Console quality gates
The system MUST include Console workspaces in test coverage and SHALL run contract, browser, security, accessibility, performance, and Hook isolation gates before release.

#### Scenario: A new Console workspace has no tests
- **WHEN** a Console package or app is added without direct tests
- **THEN** the repository check fails rather than passing because test discovery is empty or coverage excludes it

