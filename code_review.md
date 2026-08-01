# ZhiLoop Code Review

## 📊 统计概览

### 当前 CR 情况

| 指标 | 数值 |
|---|---:|
| **CR 标识** | P1 Gate / 端到端幂等与故障恢复 |
| **CR 耗时** | 300s |
| **🔴 高风险** | 1 个 |
| **🟡 中风险** | 3 个 |
| **🟢 低风险** | 0 个 |
| **修复程度** | 已修复 4/4（100%） |

### 累计情况

| 指标 | 累计值 |
|---|---:|
| **总 CR 次数** | 11 次 |
| **总耗时** | 4060s |
| **🔴 高风险累计** | 14 个 |
| **🟡 中风险累计** | 33 个 |
| **🟢 低风险累计** | 0 个 |
| **平均修复程度** | 100% |

## 改动说明

本次新增脱敏录制 Hook Fixture 和两条 P1 端到端 Gate：同一会话三次回放、Daemon 全故障时 Hook 失败开放、Spool 恢复到 Ledger、敏感值验证，以及 raw event 到 source/session/Turn/Session boundary 的完整追踪。

Gate 同时修复 Spool 与 Ledger 的幂等身份不一致，并加强 Ledger 对相同 eventId、不同身份元数据的冲突检查。Node 24.18.0 下全仓 189 个模块测试、14 个架构/Gate 测试通过，整体 Lines 97.81%、Branches 90.54%，npm audit 0 vulnerabilities。

## 风险矩阵

| 增/删 | 风险 | 代码定位 | 问题描述 | 影响范围 | 修复结果 |
|---|---|---|---|---|---|
| 增 | 🔴 高 | `packages/hook-runtime/src/spool.ts` / duplicate | eventId 不含 observedAt；重复 Stop 在不同时间被观察时 Ledger 返回 duplicate，但 Spool 比较完整信封并误报 conflict。Daemon 故障下第二次 Hook 会无法降级落盘。 | 事件丢失、Hook 降级不可靠 | Spool 改用与事件 ID 一致的身份字段和脱敏 payload 比较，允许 occurredAt/context 元数据变化；增加重复观察 Fixture 和 P1 全故障回放。 |
| 增 | 🟡 中 | `packages/conversation-ledger/src/event-ledger.ts` / duplicate | Ledger 过去只比较 contentHash 和 storedPayloadHash；哈希碰撞或上游缺陷可让不同 source/session/turn/type 静默成为 duplicate。 | 错误归属、审计不可追踪 | duplicate 额外比较 source、sourceItemId、eventType、sessionId、turnId、correlationId；身份冲突抛错。 |
| 增 | 🟡 中 | `scripts/p1-gate.test.mjs` / trace | 只验证 Ledger count 无法证明 session.ended 等边界事件进入后续投影。 | Gate 假阳性、Episode 丢边界 | 对每个 Ledger eventId 检查其必须出现在 Normalized Turn 或 Session boundary 引用集合。 |
| 增 | 🟡 中 | `scripts/p1-gate.test.mjs` / failure flow | 只断言 Hook 返回 0 不能证明 Spool 可恢复或正文已脱敏。 | 数据静默滞留、隐私回归 | 全部 5 次 Hook 后 drain 到真实内存 Ledger，断言 delivered=4、remaining=0、敏感原值消失且替换标记存在。 |

## Gate 证据

| 检查项 | 结果 | 结论 |
|---|---|---|
| 录制 Fixture 三次回放 | Ledger 4 → 4 → 4 | 通过 |
| Daemon 全故障 | 5/5 Hook exitCode 0 | 通过 |
| Spool 恢复 | 4 unique delivered、0 remaining | 通过 |
| 重复 Stop | 1 Session、1 Turn | 通过 |
| source/session | 4/4 可追踪 | 通过 |
| Turn/Session boundary | 4/4 eventId 被引用 | 通过 |
| 敏感信息 | 合成 token 不存在，`[REDACTED]` 存在 | 通过 |
| 全仓质量 | 189 模块 + 14 架构/Gate，audit 0 | 通过 |

## 性能与瓶颈复盘

- P1 Gate 两条端到端场景在本机约 125ms 完成；主要成本是临时文件 fsync 和 SQLite 初始化，不进入正常成功入队 P95。
- eventId duplicate 查询仍走 SQLite UNIQUE 索引，新增身份字段比较只发生在冲突路径，不增加额外查询。
- Spool 恢复保持 at-least-once；Ack 后删除失败会重放，由 Ledger duplicate 吸收。

## 已知边界

- Fixture 是脱敏的可重复样本，不代表所有 Codex 版本字段；未来 Hook 协议升级必须添加对应版本 Fixture。
- Gate 使用内存 Ledger 和临时 Spool，不覆盖真实 Unix Socket IPC、安装权限、开机启动和卸载回滚。
- observedAt 变化允许 duplicate 后保留首次记录时间；如果未来需要记录多次观察，应新增 observation 表，不能改变 eventId 语义。

## Review 结论

P1 Gate 未发现未修复风险，三项验收条件全部通过。事件采集、失败恢复、幂等账本和 Session/Turn 追踪可以冻结为 P1 基线，项目可进入 P2/CKL-201。
