---
name: zhiloop-knowledge
description: Use ZhiLoop's scoped, traceable project and global knowledge when it is relevant to a coding task, and check task closure against recorded gates. Trigger when Codex needs prior project conclusions, implementation decisions, known boundaries, related knowledge, or closure verification.
---

# ZhiLoop Knowledge

Use the smallest sufficient ZhiLoop context for the current task.

1. Treat injected boundaries and mandatory gates as constraints, not suggestions.
2. Treat each `L1_POINTER` as a relevant introduction, not complete implementation detail. Never infer omitted boundaries, code behavior, or evidence from its summary.
3. Before applying or changing code governed by a pointer, expand only the selected asset with `ckl.get(..., targetDetailLevel="L2_COMPACT")` for boundaries or `L3_EVIDENCED` for body and evidence.
4. Use `ckl.search` only when the initial dynamic directory is insufficient. Use `ckl.related` only for a narrow dependency expansion. Both return more L1 pointers; select before expanding.
5. Pass known item IDs and versions where supported to avoid duplicate context. Use `ckl.check` before closure when version, status, scope, or required evidence is uncertain.
6. Keep PROJECT knowledge inside its project identity. Never promote it to GLOBAL based only on similarity.
7. Distinguish references, accepted decisions, and mandatory rules in the answer and implementation.
8. If ZhiLoop is unavailable, continue the user's task without blocking and state only material missing evidence.
