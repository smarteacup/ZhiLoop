---
name: zhiloop-knowledge
description: Use ZhiLoop's scoped, traceable project and global knowledge when it is relevant to a coding task, and check task closure against recorded gates. Trigger when Codex needs prior project conclusions, implementation decisions, known boundaries, related knowledge, or closure verification.
---

# ZhiLoop Knowledge

Use the smallest sufficient ZhiLoop context for the current task.

1. Treat injected boundaries and mandatory gates as constraints, not suggestions.
2. Treat capabilities and summaries as pointers. Do not request full knowledge bodies unless the task needs them.
3. Use `ckl.search` for discovery, `ckl.get` for a selected asset, `ckl.related` for a narrow relationship expansion, and `ckl.check` before claiming closure when required evidence is uncertain.
4. Keep PROJECT knowledge inside its project identity. Never promote it to GLOBAL based only on similarity.
5. Distinguish references, accepted decisions, and mandatory rules in the answer and implementation.
6. If ZhiLoop is unavailable, continue the user's task without blocking and state only material missing evidence.
