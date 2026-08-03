## Context

ZhiLoop already contains the knowledge, injection, policy, daemon orchestration, and plugin-runtime modules, but it has no installable sidecar composition root and no host deployment transaction. The current machine is macOS, Codex stores hooks in `~/.codex/hooks.json`, and CCM already owns entries in that file. `~/.ccm/config.json` also contains credentials and user settings, so deployment must not rewrite or copy it.

The first rollout is deliberately SHADOW-only: hooks may capture and evaluate work, but they must not make model-visible changes. This lets us validate lifecycle, compatibility, latency, permissions, and rollback before ACTIVE mode or existing-knowledge migration is authorized.

## Goals / Non-Goals

**Goals**

- Ship a real `zhiloop-sidecar` executable contract with `serve`, `hook`, `health`, and `worker` entry points.
- Install it for the current user without root access and keep releases versioned and rollbackable.
- Merge ZhiLoop hooks into Codex without modifying or taking ownership of CCM hook entries.
- Run the sidecar under `launchd`, default to SHADOW, fail open at the hook boundary, and expose deterministic health diagnostics.
- Make install, upgrade, doctor, rollback, and uninstall testable in an isolated temporary home before touching the real home.
- Preserve a platform-neutral core so Linux and Windows service adapters can be added without changing runtime semantics.

**Non-Goals**

- Enabling ACTIVE injection in the first deployment.
- Importing or publishing existing real knowledge.
- Editing `~/.ccm/config.json`, CCM scripts, CCM credentials, or CCM-managed hook entries.
- A system-wide/root installation, hosted control plane, or cross-machine synchronization.
- Shipping Linux systemd or Windows Service adapters in this change.

## Decisions

### 1. Separate sidecar composition from domain packages

Add an executable application package that composes the existing daemon and domain ports. Domain packages remain unaware of macOS, `launchd`, installation paths, and shell behavior. The executable accepts explicit paths from configuration and implements:

- `serve`: long-running local service;
- `hook`: bounded stdin request, local transport call, bounded stdout response;
- `health --json`: machine-readable version, protocol, mode, readiness, and dependency status;
- `worker [--once]`: durable background work processing for tests and repair.

The local transport is a Unix domain socket at `~/.ckl/run/sidecar.sock`. It avoids a network-listening port, inherits filesystem access controls, and gives the hook a low-latency request path. The socket path is configurable for isolated tests. The platform-neutral transport interface allows a Windows named-pipe adapter later.

### 2. Install immutable releases and switch one `current` pointer

The user installation layout is:

```text
~/.local/bin/zhiloop-sidecar
~/.local/bin/zhiloop
~/.local/share/zhiloop/releases/<version>/
~/.local/share/zhiloop/current -> releases/<version>
~/.ckl/config.json
~/.ckl/run/
~/.ckl/logs/
~/.ckl/install/manifest.json
~/.ckl/install/receipts/
~/Library/LaunchAgents/dev.zhiloop.sidecar.plist
```

An upgrade writes and verifies a new immutable release, atomically switches `current`, restarts the service, and waits for compatible READY health. Failure switches back to the previous release and restores service state. It never mutates an installed release in place.

The installed bin launchers contain only fixed absolute paths and argument forwarding; they do not use `eval`. The release records its source commit, package version, protocol version, artifact digest, and install time.

### 3. Treat host mutation as a journaled transaction

Deployment has explicit `plan`, `apply`, and `rollback` phases. Before mutation it resolves every target, rejects unsafe symlinks and non-regular config files, records pre-state hashes, and prepares same-filesystem temporary files. It then applies atomic renames and records receipts.

On failure, rollback walks only completed journal steps in reverse. A second install with the same version and configuration is idempotent. Uninstall removes only paths and hook fragments proven to be managed by the active manifest. Knowledge data remains by default; `--purge-data` is an explicit, separate destructive option.

### 4. Integrate through Codex hooks and leave CCM opaque

The installer merges ZhiLoop entries into `~/.codex/hooks.json` through the existing `HookConfigurationInstaller`. Unknown keys, event entries, matchers, timeouts, and CCM commands are retained byte-for-byte where the JSON model permits. The receipt captures ownership and the original document for exact restoration when no external drift occurred; with safe external drift it removes only ZhiLoop-managed entries.

The installer does not write `~/.ccm`. CCM compatibility is achieved by coexistence in Codex's hook fan-out, not by patching CCM. A different pre-existing ZhiLoop command or an ambiguous hook document stops installation before service activation.

### 5. Use launchd as a thin lifecycle adapter

The generated user LaunchAgent has label `dev.zhiloop.sidecar`, invokes `zhiloop-sidecar serve` with absolute arguments, uses `RunAtLoad`, and restarts only on abnormal exit. It writes stdout/stderr to restrictive files under `~/.ckl/logs` and does not contain secrets or inline shell.

The lifecycle adapter uses `launchctl bootstrap`, `kickstart`, and `bootout` against the current GUI user domain. Tests can substitute a fake service controller; install logic must not call `launchctl` directly outside that adapter.

### 6. Default to SHADOW with fail-open hooks and explicit promotion

Fresh configuration sets rollout mode to SHADOW. In SHADOW, the full retrieval/decision path may execute and emit privacy-safe diagnostics, but the hook returns no model-visible injected content. A missing socket, timeout, malformed response, version mismatch, or unavailable sidecar produces a successful empty hook result and a bounded diagnostic record.

ACTIVE cannot be selected by install flags in this change. Promotion requires a later gated command/change that validates latency, error rate, compatibility, and sampled decisions.

### 7. Keep diagnostics useful without storing prompt bodies in logs

`doctor --json` and `health --json` report paths, permissions, release metadata, service state, socket reachability, compatibility, rollout mode, and last bounded error code. Logs contain identifiers, timings, counts, hashes, and error codes, but no raw prompts, tool payloads, retrieved knowledge bodies, credentials, or environment dumps.

Directories containing state use mode `0700`; configuration, manifests, receipts, and logs use `0600`. The Unix socket is accessible only to the current user. Rotation caps both file size and retained count.

### 8. Test in an isolated home, then perform one real SHADOW acceptance

The deployment API accepts an explicit home/prefix and injected service controller. Automated tests cover clean install, repeated install, upgrade, compatible drift, conflicting drift, forced failure at each mutation boundary, rollback, uninstall, and purge separation using temporary directories.

Only after those tests pass may the real-home acceptance run. It installs the release, starts the LaunchAgent, verifies READY/SHADOW health, sends a synthetic hook event, confirms empty model-visible output and privacy-safe diagnostics, and verifies CCM hook entries are unchanged. Any failed check automatically rolls back the real-home transaction.

## Risks / Trade-offs

- **Node runtime availability:** a script-based release is smaller than bundling Node but depends on a compatible runtime. The installer therefore resolves and records an absolute Node executable and rejects unsupported versions before mutation. A future packaged-binary release can keep the same CLI contract.
- **Hook latency:** a local socket adds IPC overhead. The hook uses strict per-event deadlines, bounded payloads, and fail-open behavior; acceptance records p50/p95 latency before ACTIVE can be considered.
- **Concurrent config writers:** CCM or Codex may edit hooks during deployment. Pre-state hashes are rechecked immediately before rename; a mismatch aborts and retries from a new plan rather than overwriting.
- **LaunchAgent environment differences:** launchd has a minimal environment. Every executable and state path is absolute, and no success criterion depends on interactive-shell `PATH`.
- **Uninstall after external drift:** exact byte restoration may be unsafe after edits. The managed-unmerge fallback removes only receipt-owned entries and reports unresolved conflicts instead of guessing.

## Migration Plan

1. Build and test the executable release artifact in the repository.
2. Run the full deployment suite against temporary homes and a fake service controller.
3. Run `install --plan` against the current home and persist a human-readable diff/plan.
4. Apply the current-user installation in SHADOW, bootstrap the LaunchAgent, and wait for compatible READY health.
5. Run synthetic Codex hook and CCM-coexistence acceptance checks.
6. If any step fails, roll back hooks, service registration, `current`, and newly created managed files from the journal.
7. Leave real knowledge and ACTIVE promotion untouched. A normal uninstall retains `~/.ckl` knowledge/state; explicit purge is separately confirmed.

## Open Questions

None for the SHADOW deployment. Linux/Windows adapters, packaged Node distribution, real knowledge migration, and ACTIVE promotion are intentionally deferred behind separate changes.
