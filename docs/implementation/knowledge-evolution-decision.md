# M4 知识演进决策实施说明

## 目标

在 Candidate 进入 Evidence Policy 前，先判断它与当前知识的关系。该步骤只做决策和限权，不直接写 Markdown、Registry 或向量索引。

## 模块边界

- `knowledge-evolution`：纯领域规则、输入校验、可选语义裁决端口。
- `knowledge-worker-runtime`：解析 Scope、读精确当前版本、最多召回 5 条候选、持久化决策并限制发布。
- `sidecar`：把现有 Registry FTS 投影为有界查询端口。
- Evidence Policy：仍唯一决定生命周期状态和最终 Scope；Evolution 只能阻断，不能提权。

## 端到端链路

```text
Candidate + User Commitment
  -> Scope Resolver
  -> exact Markdown identity lookup
  -> Registry FTS search (limit = 5)
  -> Evolution Decision checkpoint
  -> Evidence verification and policy
  -> allowed action + shouldPublish
  -> lineage-aware outbox
```

## 安全不变量

1. Registry 查询失败不得降级为 STORE。
2. FTS 排名只生成候选，不能单独证明知识关系。
3. PENDING、CONTRADICT 和 SKIP 都不产生发布 outbox。
4. SUPPLEMENT/SUPERSEDE 只能追加当前 lineage 的下一版，并保留旧版可追溯性。
5. 任何语义裁决只能在给定的最多 5 个目标内选择，不能创造知识 ID。
6. 同状态的正文修订只在本轮用户接受或必需 Evidence 完整时发布；不继承旧版本的授权。
7. 已 VERIFIED 目标的补充，以及已 IMPLEMENTED/VERIFIED 目标的替代，必须进入确认门禁。

## 验收

- 六类 action 与 PENDING 均有领域单测。
- Worker 覆盖查询边界、回放、冲突不发布、新版本关系和旧 checkpoint。
- 完整 dependency/lint/build/typecheck/test/coverage Gate 和 OpenSpec strict validation 通过。
