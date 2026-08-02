# ZhiLoop Code Review

## 统计概览

| 指标 | 当前 | 累计 |
|---|---:|---:|
| CR 标识/次数 | CKL-701 | 44 次 |
| 耗时 | 720s | 21510s |
| 高风险 | 8 | 211 |
| 中风险 | 10 | 293 |
| 低风险 | 0 | 0 |
| 修复程度 | 18/18（100%） | 100% |

## 风险矩阵

| 风险 | 问题 | 修复结果 |
|---|---|---|
| 高 | 把 streamed delta 或 item/started 当作最终知识 | 只从 `item/completed` 和终态 Turn 生成事实。 |
| 高 | 把 `thread/closed` 误判为 session 永久结束 | 依据官方卸载语义忽略该运行时信号，由既有闭合策略裁决。 |
| 高 | 断线发生在 Item 完成后导致用户结论或工具结果丢失 | `turn/completed.items` 重放遗漏的最终 Item。 |
| 高 | 重连重放造成 Ledger 重复沉淀 | 跨连接事件身份确定性；两次回放第二轮全部返回 duplicate。 |
| 高 | agent delta 与最终答案不一致 | 只缓存 completed agentMessage，`final_answer` 优先。 |
| 高 | `item/completed` 携带 inProgress 仍被采信 | 对带状态的最终 Item 强制 terminal guard。 |
| 高 | 巨大通知或 payload 占满 Hook/sidecar 内存 | 原始通知和规范化 payload 双 4 MiB 上限。 |
| 高 | Thread/Turn 标识混用导致子线程知识串线 | 以 `thread.id` 作为标准 sessionId，`sessionId` 树标识不替代 Thread 边界。 |
| 中 | Adapter 状态随长连接无限增长 | seen/thread/final-message 三类状态统一有界，默认 10,000。 |
| 中 | 使用接收时刻覆盖 App Server 权威时间 | Thread、Item、Turn 分别使用 createdAt/completedAtMs/completedAt。 |
| 中 | Hook 与 App Server payload 语义漂移 | 对等 Fixture 验证 user.prompted/turn.stopped 及核心字段一致。 |
| 中 | 未知字段改变事件身份 | 只将 allowlist 字段规范化，futureField 不进入 payload/hash。 |
| 中 | 未知通知被静默丢弃 | 未知 method 返回独立 unsupported diagnostic。 |
| 中 | 未知 Item 被猜测成 Tool 或知识 | 非物质 Item 安全忽略，升级先补 Fixture。 |
| 中 | 多模态 User Item 丢失 | prompt 用 text 合并，完整规范化 content 同时保留。 |
| 中 | Aggregated diff 重复快照无法幂等 | sourceItemId 固定为 turn diff，contentHash 区分新快照并折叠相同快照。 |
| 中 | Adapter 偷偷启动进程或连接网络 | 实现仅依赖 crypto、Domain、Schema，无 transport/process/network。 |
| 中 | 协议版本不可追溯 | Thread cliVersion/sourceVersion 写入 Envelope，文档记录 0.144.4 兼容基线。 |

## Gate 证据

| 检查项 | 结果 |
|---|---|
| App Server Adapter 专项 | 17/17；Lines 98.36%、Branches 95.56% |
| 重连/Ledger 边界 | 1/1；第二连接 5/5 duplicate，最终总数 5 |
| 性能 | 10,000 events 139.656ms；约 71,605 events/s |
| 全仓 | 575/575 模块；45/45 架构/Gate |
| 整体覆盖率 | Lines 97.04%、Branches 90.21%、Functions 98.38% |
| Workspace / 供应链 | 34 个依赖边界通过；0 vulnerabilities |

## Review 结论

CKL-701 三项验收满足，18 项风险全部修复，无遗留 actionable finding。最终态权威、断线补偿和持久化幂等成立，且未引入 App Server transport 或本机配置副作用。可以进入 CKL-702。
