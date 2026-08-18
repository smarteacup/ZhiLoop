# Design: CodeGraph live fact adapter

## Boundary

`code-intelligence` owns normalized DTOs and a port. Facts contain symbol name, kind, repository-relative path, and line range only. Vendor node IDs, SQLite fields, scores, and raw output are forbidden.

`codegraph-adapter` owns process execution and CodeGraph JSON parsing. It invokes an executable directly with an argv array and `shell: false`. The executable is checked lazily, CodeGraph 0.9.x is accepted, and each operation is timeout-bounded.

## Capability states

- `READY`: compatible binary and healthy initialized index.
- `NOT_CONFIGURED`: repository has no CodeGraph index.
- `INCOMPATIBLE`: installed version is outside the supported range.
- `UNAVAILABLE`: process, timeout, or response failure.

No state triggers `codegraph init` or `sync`.

## Cache

Query results are keyed by repository root, caller-provided project fingerprint, operation, symbol, path, and limit. A new fingerprint cannot reuse prior facts. Capabilities use a short bounded cache, while fact results use a bounded LRU.

## Evidence mapping

The SYMBOL_EXISTS probe returns SUPPORTED only for an exact normalized symbol match and optional exact relative path. A healthy empty result is REFUTED. All non-READY capability states remain UNKNOWN with a stable reason code. Evidence source references contain the project fingerprint, path, and line, never a CodeGraph node ID.
