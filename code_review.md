# ZhiLoop Code Review

## 统计概览

| 指标 | 当前 | 累计 |
|---|---:|---:|
| CR 标识/次数 | CKL-402 | 25 次 |
| 耗时 | 600s | 11120s |
| 高风险 | 7 | 79 |
| 中风险 | 8 | 124 |
| 低风险 | 0 | 0 |
| 修复程度 | 15/15（100%） | 100% |

## 改动说明

新增 `@zhiloop/knowledge-registry`，把 COMMITTED Markdown 投影为 SQLite assets/versions/relations/evidence/FTS5 和单调 activeIndexVersion；提供增量 project、全量 rebuild、版本/边/证据读取和默认安全 FTS 查询。

## 风险矩阵

| 风险 | 问题 | 修复结果 |
|---|---|---|
| 高 | 重建先清库再异步读取，失败丢失可用投影 | 事务前形成完整 Markdown 快照；断裂历史不触碰旧数据库。 |
| 高 | MANUAL_EDIT 手工提升 Status/Scope/Evidence 进入索引 | 只投影 COMMITTED；手工 current 回退同版本 immutable。 |
| 高 | 资产、关系、Evidence、FTS 分步提交产生混合版本 | 全部更新和 activeIndexVersion 切换位于同一事务。 |
| 高 | 多实例在写锁外计算相同 indexVersion | 取得 BEGIN IMMEDIATE 后重新读取并递增 activeIndexVersion。 |
| 高 | tombstone 仍残留 FTS 或默认 get | 激活 tombstone 删除 FTS；默认 get 双重过滤。 |
| 高 | 幂等路径掩盖 payload/边/FTS 磁盘损坏 | 重复投影完整复核 payload hash、Schema、contentHash、列、边和 FTS。 |
| 高 | 伪造 COMMITTED 结构与错误 documentPath 投影 | 校验 historyState、路径 asset/version 绑定、tombstone 成对字段和 canonical hash。 |
| 中 | FTS 查询语法导致异常或注入 | Unicode token 提取、引号封装和参数绑定。 |
| 中 | STALE/SUPERSEDED 默认召回 | 默认 SQL 只允许 ACCEPTED/IMPLEMENTED/VERIFIED。 |
| 中 | 新投影 Migration 覆盖 Ledger/Candidate 版本 | 独立 component meta，拒绝高版本，不使用 PRAGMA user_version。 |
| 中 | 版本跳号或同版本冲突 | 增量要求 v1 起步且严格 +1；immutable hash 冲突失败。 |
| 中 | rebuild 删除共库非投影表 | 只清理五张投影表；sentinel 共存测试通过。 |
| 中 | 数据库权限泄漏 | 非内存文件 chmod 0600。 |
| 中 | 查询/结果无界 | query 2,000 chars、30 tokens、limit 1～100。 |
| 中 | 全量重建随资产增长阻塞常态路径 | 100 资产 157.151ms；常态由 CKL-403 contentHash 增量更新。 |

## 配置、兼容性与性能检查

新增独立 Migration v1，无环境变量、Hook、Daemon 或用户配置。数据库可与其他组件同文件共存。100 资产/100 版本全量重建 157.151ms；瓶颈在 Markdown YAML/Schema/hash 读取校验，SQLite 单事务未形成显著瓶颈。

## Gate 证据

| 检查项 | 结果 |
|---|---|
| 专项 | 13/13；Lines 94.00%、Branches 89.09%、Functions 100% |
| 全仓 | 371/371 模块；38/38 架构/Gate |
| 整体覆盖率 | Lines 96.82%、Branches 89.86% |
| Workspace | 19 个 workspace，依赖方向和源码 import 通过 |
| 供应链 | 0 vulnerabilities |

## Review 结论

CKL-402 的四项验收条件全部满足，15 项风险已修复，无未解决高/中风险。可以进入 CKL-403 Incremental Indexer。
