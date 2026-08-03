## ADDED Requirements

### Requirement: Executable sidecar contract

The system SHALL provide an installable `zhiloop-sidecar` command with `serve`, `hook`, `health --json`, and `worker` entry points, versioned protocol metadata, bounded input/output, and platform-neutral runtime interfaces.

#### Scenario: Health reports a compatible running service

- **WHEN** the installed sidecar is running in SHADOW mode and `zhiloop-sidecar health --json` is invoked
- **THEN** it returns success with release version, protocol version, rollout mode, readiness, socket status, and dependency status

#### Scenario: Hook cannot reach the service

- **WHEN** `zhiloop-sidecar hook` receives a valid event but the local service is absent, incompatible, timed out, or returns malformed data
- **THEN** the command exits successfully with no model-visible injected content and records only a bounded privacy-safe diagnostic

#### Scenario: Hook input exceeds its bound

- **WHEN** hook stdin exceeds the configured maximum size or is malformed
- **THEN** the command does not forward the payload, exits through fail-open behavior, and emits no raw payload in logs

### Requirement: Versioned current-user release layout

The installer SHALL install immutable versioned releases under the current user's data prefix, expose stable launchers under the current user's bin prefix, and atomically select one release through a `current` pointer.

#### Scenario: Clean install selects the verified release

- **WHEN** a release passes runtime, digest, and compatibility validation and installation is applied
- **THEN** the complete release is placed at `~/.local/share/zhiloop/releases/<version>`, `current` is atomically switched to it, and launchers resolve only through managed absolute paths

#### Scenario: Repeating the same install

- **WHEN** the same verified release and configuration are installed again
- **THEN** the operation succeeds without duplicate hooks, duplicate service registrations, or mutation of the immutable release

### Requirement: Journaled deployment transaction

The deployment system SHALL plan all host mutations, validate target types and hashes, journal completed steps, and roll back completed mutations in reverse order after any failure.

#### Scenario: Target changes between plan and apply

- **WHEN** a managed target's hash or file type changes after planning but before its atomic replacement
- **THEN** deployment aborts before overwriting that target and rolls back earlier completed steps

#### Scenario: A mutation step fails

- **WHEN** an injected failure occurs after any individual install or upgrade mutation
- **THEN** all previously completed transaction steps are restored to their pre-transaction state and the failure is reported with the failed step identifier

#### Scenario: Sensitive target is a symlink

- **WHEN** hooks, configuration, receipt, manifest, launcher, or service targets resolve through an unapproved symlink
- **THEN** deployment stops before mutation and reports the unsafe target

### Requirement: Non-destructive Codex and CCM coexistence

The installer SHALL add ZhiLoop through `~/.codex/hooks.json`, preserve existing Codex and CCM hook entries, and SHALL NOT modify files under `~/.ccm`.

#### Scenario: CCM hooks already exist

- **WHEN** Codex hooks contain CCM commands and ZhiLoop is installed
- **THEN** all CCM commands, matchers, timeouts, event ordering, and unrelated keys remain present while exactly one managed ZhiLoop entry is added per configured event

#### Scenario: Hook document has safe external edits before uninstall

- **WHEN** unrelated hooks are added after installation and ZhiLoop is uninstalled
- **THEN** only receipt-owned ZhiLoop entries are removed and the unrelated edits remain

#### Scenario: Conflicting ZhiLoop hook exists

- **WHEN** the target contains a ZhiLoop-like hook with a different command or ambiguous ownership
- **THEN** installation stops before service activation and does not rewrite the hook document

### Requirement: macOS LaunchAgent lifecycle

The macOS adapter SHALL manage a user LaunchAgent named `dev.zhiloop.sidecar` through an injectable service-controller interface and absolute program arguments.

#### Scenario: Service starts after install

- **WHEN** a transaction commits a new installation
- **THEN** the adapter bootstraps and kickstarts the LaunchAgent in the current GUI user domain and waits for compatible READY health

#### Scenario: Started service never becomes ready

- **WHEN** the LaunchAgent starts but compatible READY health is not observed within the deployment deadline
- **THEN** the adapter stops the new service and the deployment transaction restores the previous service and release state

#### Scenario: LaunchAgent runs without shell environment

- **WHEN** launchd starts the sidecar with a minimal environment
- **THEN** it resolves its executable, configuration, socket, state, and log paths without relying on interactive-shell `PATH` or shell evaluation

### Requirement: SHADOW-first rollout gate

Fresh deployment SHALL use SHADOW mode, SHALL prevent model-visible injection, and SHALL not expose an install-time switch that enables ACTIVE mode.

#### Scenario: Retrieval succeeds in SHADOW

- **WHEN** a hook event retrieves and selects applicable knowledge in SHADOW mode
- **THEN** the decision may be measured internally but the hook response contains no injected knowledge content

#### Scenario: Install requests ACTIVE

- **WHEN** an operator attempts to select ACTIVE through deployment arguments or configuration bootstrap
- **THEN** deployment rejects the request and leaves the previous installation state unchanged

### Requirement: Secure state and privacy-safe observability

The deployment SHALL initialize `~/.ckl` with restrictive permissions and SHALL expose diagnostics without logging raw prompts, tool payloads, knowledge bodies, credentials, or environment dumps.

#### Scenario: State is initialized

- **WHEN** installation creates ZhiLoop state for the first time
- **THEN** state directories are mode `0700`, sensitive files are mode `0600`, and the local socket is accessible only to the current user

#### Scenario: Doctor inspects deployment

- **WHEN** `zhiloop doctor --json` is run
- **THEN** it reports release integrity, managed paths, permissions, service state, socket reachability, compatibility, rollout mode, and bounded error codes without returning sensitive content

#### Scenario: Diagnostic logs grow

- **WHEN** service and hook logs reach their configured bounds
- **THEN** logs rotate according to configured size and retention limits without blocking hook fail-open behavior

### Requirement: Atomic upgrade and recoverable uninstall

Upgrade SHALL preserve the previous release until the new release is healthy, and uninstall SHALL remove only manifest-owned deployment artifacts while retaining knowledge data unless an explicit purge is separately requested.

#### Scenario: Healthy upgrade

- **WHEN** a newer compatible release is installed and reaches READY health
- **THEN** `current` remains on the new release, the manifest records it as active, and the previous release remains available for bounded rollback retention

#### Scenario: Upgrade health check fails

- **WHEN** the new release fails compatibility or readiness checks
- **THEN** `current`, service state, hooks, and manifest return to the previous healthy installation

#### Scenario: Normal uninstall

- **WHEN** uninstall is applied without `--purge-data`
- **THEN** the LaunchAgent, launchers, managed hook fragments, and installation-owned release files are removed while knowledge and durable user data remain

#### Scenario: Purge is not explicitly authorized

- **WHEN** uninstall is invoked without a separate explicit purge confirmation
- **THEN** no knowledge database, ledger, artifact, or durable user data is deleted

### Requirement: Isolated and real-home acceptance

Deployment SHALL pass isolated-home fault tests before it may mutate the current user's real home, and real-home acceptance SHALL automatically roll back after any failed check.

#### Scenario: Temporary-home suite passes

- **WHEN** clean install, repeat install, upgrade, drift, injected failure, rollback, uninstall, and purge-separation tests run with a temporary home and fake service controller
- **THEN** every asserted filesystem, hook, manifest, and lifecycle postcondition passes before real-home apply is permitted

#### Scenario: Real SHADOW acceptance passes

- **WHEN** the real current-user install reaches READY/SHADOW, a synthetic hook event is sent, and pre/post CCM hook snapshots are compared
- **THEN** the hook returns no model-visible content, diagnostics contain no raw synthetic payload, and CCM-owned hook entries are unchanged

#### Scenario: Real SHADOW acceptance fails

- **WHEN** any release, service, hook, privacy, permission, or coexistence check fails
- **THEN** the installer automatically rolls back the real-home transaction and reports the unmet check
