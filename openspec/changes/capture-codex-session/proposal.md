## Why

ZhiLoop currently captures only Hook events emitted after installation, so an existing or already-running Codex conversation cannot be selected and backfilled into the local ledger. Users need a deterministic, idempotent way to actively capture one local Codex session by ID without waiting for Hook delivery or risking concurrent direct writes to SQLite.

## What Changes

- Add a `zhiloop capture --session <id>` command with `--dry-run`, JSON output, bounded transcript discovery, and explicit diagnostics.
- Locate the matching Codex rollout transcript by reading `session_meta` records under the configured Codex sessions root rather than matching arbitrary conversation content.
- Import supported transcript records incrementally through the running Sidecar, persist a source cursor, and make repeated capture safe and idempotent.
- Report discovered path, projected/appended/duplicate event counts, ignored records, cursor position, and whether additional transcript data remains.
- Keep capture metadata-only in logs and preserve the existing ledger redaction and validation boundary.
- Leave continuous follow mode and downstream knowledge compilation out of this change; capture ends when canonical conversation events are durably present in the ledger.

## Capabilities

### New Capabilities

- `codex-session-capture`: Discover and actively import one local Codex rollout transcript into the ZhiLoop conversation ledger by exact session ID.

### Modified Capabilities

None.

## Impact

- Adds a reusable session locator/import service around `@zhiloop/ingestion-codex` and `@zhiloop/conversation-ledger`.
- Extends the local Sidecar transport with a bounded session-capture request handled by the Sidecar's single ledger owner.
- Extends the deployment CLI and local release packaging without changing existing install, upgrade, doctor, Hook, or SHADOW injection behavior.
- Reads local files below `~/.codex/sessions`; writes only ZhiLoop-owned cursor state, ledger data, and privacy-safe diagnostics below `~/.ckl`.
