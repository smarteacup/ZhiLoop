## Context

The deployed Sidecar owns `~/.ckl/knowledge/events.sqlite` and currently receives only live Codex Hook payloads. The repository already contains `readTranscriptIncrement()`, a bounded Codex rollout JSONL reader that validates format, produces deterministic canonical events, and supports an anchored cursor, but no production component locates transcripts, persists reader cursors, or invokes it from the CLI.

Codex Desktop stores local rollout files below `~/.codex/sessions/<year>/<month>/<day>/`. A selected historical session can therefore be backfilled locally without browser automation or a remote Codex API. The import must not expose raw conversation content in logs, and the CLI must not open the Sidecar-owned SQLite database for writes.

## Goals / Non-Goals

**Goals:**

- Capture one exact Codex session ID on demand with a stable CLI command.
- Reuse the existing transcript adapter and ledger validation/redaction behavior.
- Make first import, retry after failure, and later incremental refresh idempotent.
- Keep discovery, reads, transport messages, batches, and diagnostics bounded.
- Distinguish transcript capture from downstream normalization and knowledge compilation.

**Non-Goals:**

- Continuously watch all Codex sessions.
- Import hidden reasoning, arbitrary tool payloads, or unsupported transcript records.
- Compile or inject knowledge as part of the capture request.
- Read cloud-shared ChatGPT conversations or transcripts outside the configured local Codex sessions root.

## Decisions

### 1. Introduce a reusable `codex-session-capture` application service

The service will compose a transcript locator, `readTranscriptIncrement()`, an event sink, and a cursor store. It will return a content-free report containing path, counts, cursor position, and completion state. Discovery and importing stay outside the CLI and Sidecar transport so they can later be reused by scheduled scanning or a plugin adapter.

Alternative considered: implement the loop directly in the CLI. Rejected because the CLI would either become the SQLite writer or duplicate application logic needed by future background capture.

### 2. Perform capture inside the running Sidecar

`zhiloop capture --session <id>` will send a small `capture-session` request over the existing owner-only Unix socket. The Sidecar will read the configured Codex sessions root and append events through its existing ledger instance. Capture requests will be serialized in-process so concurrent CLI invocations cannot race cursor commits.

Alternative considered: stop the service and run a one-shot importer against SQLite. Rejected because it interrupts Hook capture and creates operational ambiguity.

### 3. Treat `session_meta` as the identity authority

The locator will accept a bounded opaque session token with no path separators, recursively inspect only regular `.jsonl` files under the configured root, read a bounded first line, and select files whose first `session_meta.payload.id` exactly equals the requested ID. Older metadata without `id` falls back to `session_id`. Child/subagent rollouts have their own `id` while carrying the parent in `session_id`, so they are not mistaken for duplicate primary transcripts. No match is `SESSION_NOT_FOUND`; multiple primary matches are `SESSION_AMBIGUOUS`. Symlinks and paths escaping the configured real root are rejected.

Filename matching may be used as a safe optimization, but never as proof of identity. Arbitrary occurrences of a session ID inside conversation content are ignored.

### 4. Persist anchored transcript cursors in the ledger database

The ledger schema will gain a small `ingestion_cursors` table keyed by source ID. The cursor is committed only after all events from the corresponding read batch have been appended. A crash after append but before cursor commit causes deterministic duplicate replay, which the existing event IDs safely absorb. A cursor is never advanced past an unreadable or malformed record.

Alternative considered: cursor JSON files under `~/.ckl`. Rejected because cross-file atomicity, permissions, and concurrent updates would require a second persistence protocol.

### 5. Keep dry-run strictly read-only and reports explicit

`--dry-run` performs the same discovery and transcript projection but does not append events or commit a cursor. Normal capture reports `appendedEvents`, `duplicateEvents`, `ignoredRecords`, `batches`, and the final byte/line cursor. The report also returns `knowledgeCompiled: false` while the production knowledge compiler remains uncomposed.

### 6. Preserve the existing transcript projection boundary

This change imports the event types already supported by `readTranscriptIncrement()`: `session.started`, `user.prompted`, and `turn.stopped` with the final assistant message. Other rollout records remain counted as ignored. Expanding the canonical event taxonomy is a separate change because it affects normalizers, schemas, retention, and knowledge extraction semantics.

## Risks / Trade-offs

- [Large transcript trees make discovery slow] → Bound files, depth, first-line bytes, and total request duration; filter candidate filenames where possible and report a stable limit diagnostic.
- [An active transcript grows during capture] → Commit the anchored cursor through the last complete line and allow the same command to resume later; report `hasMore` when a bounded read stops early.
- [Transcript replacement or truncation invalidates a cursor] → Surface the adapter's replacement/truncation diagnostic and do not silently reset; a future explicit rebuild command can define destructive re-import semantics.
- [Long capture blocks other capture requests] → Serialize capture requests but keep Hook ingestion on its existing fast path; append bounded batches and cap transcript bytes per request.
- [Conversation content leaks through logs/errors] → Log only session hash, diagnostic code, duration, and counts; return no prompts or assistant text in capture reports.
- [Users assume capture means knowledge is ready] → Return and document `knowledgeCompiled: false` until the compiler is wired into the deployed worker.

## Migration Plan

1. Add the capture package, ledger cursor schema, transport request, CLI command, and tests.
2. Extend generated Sidecar config with `codexSessionsRoot`; keep parsing backward-compatible for tests and rollback where possible.
3. Build a new immutable local release and upgrade through the existing journaled installer.
4. Run dry-run and real capture for a known historical session; verify counts, idempotent second run, empty spool, and service health.
5. Roll back through the existing installer journal if readiness fails. Existing ledger rows and cursor data remain forward-compatible and are ignored by version `0.1.2`.

## Open Questions

None blocking. Continuous `--follow`, explicit cursor reset/rebuild, richer assistant/tool event projection, and automatic knowledge compilation remain separate scoped changes.
