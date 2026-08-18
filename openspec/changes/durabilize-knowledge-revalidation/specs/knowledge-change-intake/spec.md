## ADDED Requirements

### Requirement: Wakeups do not define code truth
The system SHALL accept Codex file-change, worktree watcher, Git lifecycle, fallback scan, and pre-injection wakeups, but MUST derive authoritative changes from the registered repository and Git state.

#### Scenario: Watcher path is incomplete
- **WHEN** a watcher reports only one path while Git reports additional committed or dirty paths
- **THEN** the persisted observation contains the complete bounded Git-derived path set

#### Scenario: Watcher event is lost
- **WHEN** no watcher signal is delivered for a repository change
- **THEN** the persisted fallback schedule eventually observes and enqueues the same authoritative change

#### Scenario: Unknown project is submitted
- **WHEN** a wakeup names an unobserved project or conflicts with its registered repository root
- **THEN** intake rejects it without scanning an arbitrary path or creating a job

### Requirement: Immutable replayable Git observation
The Git source SHALL persist each normalized observation with project identity, repository root, base baseline revision, target HEAD/status fingerprint, path pages, sourceRef, observation hash, and acknowledgement state.

#### Scenario: Restart before enqueue
- **WHEN** the Sidecar restarts after persisting an observation but before its revalidation job is enqueued
- **THEN** recovery finds the unacknowledged observation and enqueues or reuses its deterministic job

#### Scenario: Same repository state is rescanned
- **WHEN** an unacknowledged HEAD/status state is scanned repeatedly
- **THEN** the same sourceRef and observation are returned without duplicate path storage

### Requirement: Complete Git change semantics
The Git adapter MUST represent committed changes, dirty tracked/untracked paths, both sides of renames, and a conservative tracked-file fallback when the previous commit is unavailable.

#### Scenario: Rename is observed
- **WHEN** Git reports a renamed file
- **THEN** both the old and new canonical repository-relative paths participate in affected-knowledge lookup

#### Scenario: Force-push removes the baseline object
- **WHEN** the previous baseline commit cannot be diffed from current HEAD
- **THEN** the adapter creates a bounded full tracked-file observation and does not acknowledge the new baseline before all pages complete

#### Scenario: Dirty state changes during processing
- **WHEN** the worktree changes after one observation was persisted
- **THEN** the running job remains bound to its immutable sourceRef and a later scan creates a distinct observation for the newer state

### Requirement: Path and output bounds without truncation
The system SHALL validate canonical relative paths, reject traversal or malformed Git output, bound process output bytes, and paginate observations larger than 10,000 paths without silently dropping paths.

#### Scenario: More than ten thousand paths change
- **WHEN** an authoritative observation contains more than 10,000 valid paths within the global safety limit
- **THEN** all paths are stored in deterministic pages and processing progress is resumable by page

#### Scenario: Git output exceeds the safety limit
- **WHEN** Git output exceeds the configured byte or total-path ceiling
- **THEN** the observation fails closed with a stable diagnostic and the baseline remains unchanged

### Requirement: Affected knowledge paging is stable
Revalidation SHALL freeze a sorted set of exact knowledge versions for an observation, persist its hash and cursor, and process every page exactly once in logical effect terms.

#### Scenario: Restart between pages
- **WHEN** a process terminates after one affected page succeeds
- **THEN** replay resumes after the saved `(assetId, assetVersion)` cursor and does not reapply completed page effects

#### Scenario: Concurrent knowledge version appears
- **WHEN** a newer knowledge version is published after the affected set was frozen
- **THEN** the current job processes only the frozen versions and a subsequent observation or consistency scan handles the newer version

### Requirement: Baseline advances only after complete success
The acknowledged Git baseline MUST advance through an idempotent compare-and-set effect only after every path and affected-knowledge page for that observation succeeds.

#### Scenario: Middle page fails
- **WHEN** any revalidation page fails or is awaiting retry
- **THEN** the baseline remains at its prior revision and the observation remains recoverable

#### Scenario: Acknowledgement replays after crash
- **WHEN** baseline acknowledgement succeeds and the worker crashes before job success
- **THEN** replay recognizes the acknowledgement effect and completes without a conflicting second advance

#### Scenario: Newer baseline wins a race
- **WHEN** acknowledgement finds a different baseline revision than its persisted base revision
- **THEN** it reports a conflict, does not overwrite the newer baseline, and schedules a new authoritative scan
