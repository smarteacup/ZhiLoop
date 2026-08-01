# ZhiLoop Code Review

## 统计概览

| 指标 | 当前 | 累计 |
|---|---:|---:|
| CR 标识/次数 | CKL-305 | 22 次 |
| 耗时 | 420s | 9440s |
| 高风险 | 5 | 61 |
| 中风险 | 7 | 102 |
| 低风险 | 0 | 0 |
| 修复程度 | 12/12（100%） | 100% |

## 改动说明

新增纯策略 `@zhiloop/invalidation-engine`，把 Candidate Assertion 固化为目标级 Fingerprint，并根据结构化 ChangeSet 只重验相关知识。外部 API 新增 Fingerprint/ChangeSet/InvalidationDecision 类型，不改变 Domain 或正文；Adapter 与持久化仍分离。

## 风险矩阵

| 风险 | 问题 | 修复结果 |
|---|---|---|
| 高 | 任意文件变化使全部知识 STALE | 精确匹配 path/symbol/config/dependency；不相关变化 UNCHANGED。 |
| 高 | 伪造 fingerprint entries 诱发错误失效 | 用 Candidate/Project/entries 重新计算 identity。 |
| 高 | 裸 SUPPORTED 字符串绕过复验 | 要求唯一 Result 与 SUPPORTS Evidence 的 assertion/project/correlation 全绑定。 |
| 高 | path traversal 引导 Adapter 越界 | 统一 canonical relative path 门禁。 |
| 高 | PROPOSED/ACCEPTED 非法迁移 STALE | 仅 IMPLEMENTED/VERIFIED 调用 Domain 状态机进入 STALE。 |
| 中 | Symbol 无 path 漏判 | 支持 changedSymbols 精确索引。 |
| 中 | Config/Dependency 只按文件或只按 key 命中不完整 | 同时支持 path 与 key/name。 |
| 中 | Observation 缺失/重复/错 target | Fingerprint 构造拒绝并保留旧状态。 |
| 中 | UNKNOWN/ERROR 被当成已刷新 | 只有完整 SUPPORTS 才 REFRESH，其余发布态 STALE。 |
| 中 | STALE 删除正文 | 决策强制 preserveBody=true。 |
| 中 | 输出/顺序不稳定 | target 排序、identity 确定、输出递归冻结。 |
| 中 | 新 workspace Gate 假绿 | 第17个 workspace 纳入 root build、依赖与 coverage。 |

## 配置与兼容性检查

没有删除字段、数据库迁移、环境变量、Hook 或 Daemon 配置。Fingerprint 是新旁路记录，现阶段不存在生产数据迁移。

## Gate 证据

| 检查项 | 结果 |
|---|---|
| 专项 | 12/12；Lines 98.41%、Branches 94.62% |
| 全仓 | 342/342 模块；35/35 架构/Gate |
| 整体覆盖率 | Lines 96.97%、Branches 90.36% |
| 性能 | 10,000 次中位16.916ms、P95 19.199ms |
| 供应链 | 0 vulnerabilities |

## Review 结论

CKL-305 未发现未修复风险，三项验收条件满足。可以进入 P3 Gate。
