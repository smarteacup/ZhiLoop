## 1. Sidecar executable

- [x] 1.1 Create the sidecar application package, configuration schema, release/protocol metadata, and platform-neutral transport/service interfaces
- [x] 1.2 Implement Unix-socket `serve` and bounded fail-open `hook` request handling with SHADOW response suppression
- [x] 1.3 Implement machine-readable `health --json` and `worker [--once]` commands
- [x] 1.4 Add sidecar unit and integration tests for readiness, malformed/oversized input, timeout, incompatibility, and privacy-safe diagnostics

## 2. Deployment transaction core

- [x] 2.1 Implement explicit deployment paths, release metadata/digest verification, secure target validation, and immutable versioned release staging
- [x] 2.2 Implement plan/apply journal primitives with pre-state hashes, atomic writes, reverse rollback, and idempotent replay
- [x] 2.3 Implement stable launchers, atomic `current` selection, manifest/receipt ownership, and restrictive permission initialization
- [x] 2.4 Add transaction fault-injection tests at every mutation boundary, including symlink, concurrent-drift, and repeated-install cases

## 3. Codex and CCM coexistence

- [x] 3.1 Compose the existing HookConfigurationInstaller into deployment without writing any path under `~/.ccm`
- [x] 3.2 Add fixture coverage matching the current Codex/CCM hook shape and verify install preserves all CCM entries and unrelated keys
- [x] 3.3 Add drift, conflicting-ZhiLoop, exact-restore, and managed-unmerge uninstall tests

## 4. macOS lifecycle and diagnostics

- [x] 4.1 Implement the LaunchAgent renderer and injectable `launchctl` service-controller adapter using absolute arguments
- [x] 4.2 Implement install/upgrade readiness waiting and automatic restoration of the previous release/service on failure
- [x] 4.3 Implement `zhiloop install|upgrade|doctor|uninstall` commands with JSON and human-readable plan/report modes
- [x] 4.4 Implement privacy-safe bounded log writing/rotation and doctor checks for integrity, paths, permissions, service, socket, compatibility, and SHADOW mode
- [x] 4.5 Add fake-controller and plist tests for bootstrap, kickstart, bootout, minimal environment, failed readiness, and log bounds

## 5. Release packaging and isolated acceptance

- [x] 5.1 Build a deterministic same-machine release artifact containing compiled runtime packages, launchers, plugin assets, metadata, and digests
- [x] 5.2 Add a temporary-home acceptance suite covering clean install, repeated install, upgrade, compatible/conflicting drift, rollback, normal uninstall, and purge separation
- [x] 5.3 Add negative acceptance for ACTIVE bootstrap, raw-payload log leakage, unsupported Node versions, and unsafe target types
- [x] 5.4 Document build, plan, install, doctor, rollback, uninstall, retained-data, and troubleshooting procedures

## 6. Current-user SHADOW rollout

- [x] 6.1 Build and verify the repository release, then run the complete unit, integration, coverage, and temporary-home acceptance suites
- [x] 6.2 Snapshot only the non-secret Codex/CCM hook structure and run a current-home deployment plan review
- [x] 6.3 Apply the current-user LaunchAgent deployment and verify compatible READY/SHADOW health
- [x] 6.4 Run a synthetic hook smoke test, confirm empty model-visible output and privacy-safe diagnostics, and verify CCM-owned hooks are unchanged
- [x] 6.5 Review implementation for correctness, security, bottlenecks, rollback gaps, and platform coupling; resolve all blocking findings
- [x] 6.6 Commit and push the completed deployment change with acceptance evidence
