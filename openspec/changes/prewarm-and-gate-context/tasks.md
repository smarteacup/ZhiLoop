## 1. Stable Catalog

- [x] 1.1 Define strict cache key, L1 catalog, result, and refresh contracts.
- [x] 1.2 Implement deterministic bounded catalog construction.
- [x] 1.3 Implement integrity-checked SQLite TTL storage and session invalidation.

## 2. Freshness Gate and Integration

- [x] 2.1 Implement final candidate freshness decisions.
- [x] 2.2 Integrate best-effort prewarm and fail-closed code filtering into P4 Sidecar.
- [x] 2.3 Expose explicit session refresh and close owned stores.

## 3. Verification

- [x] 3.1 Test identity invalidation, privacy bounds, corruption, refresh, and freshness states.
- [x] 3.2 Test active Hook fail-open and stale-code exclusion paths.
- [x] 3.3 Run full gates, strict OpenSpec validation, and code review.
