# Design

## Cache identity

The key is the canonical digest of session, project, worktree, branch, Registry revision, Retrieval/Injection policy hashes, and scope hash. Code revision is deliberately excluded because code facts are checked by the final freshness gate.

## Payload boundary

The cache contains at most the configured number/token estimate of L1 items: asset identity/version, kind/status/scope, title, summary, authority, and `ckl.get` expansion action. It excludes body, symbols, Evidence, source Episodes, and CodeGraph output.

## Runtime order

```text
authoritative scope -> best-effort prewarm -> prompt retrieval -> eligibility
-> final freshness gate -> context orchestration -> audit/delivery
```

Prewarm failures are fail-open. A code-related candidate is fail-closed as a current fact when its projection is missing, version/content/project mismatched, or not FRESH. Non-code historical knowledge is unaffected.
