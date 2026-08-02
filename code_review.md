# ZhiLoop Code Review

## 统计概览

| 指标 | 当前 | 累计 |
|---|---:|---:|
| CR 标识/次数 | P5-GATE | 37 次 |
| 耗时 | 360s | 17040s |
| 高风险 | 5 | 152 |
| 中风险 | 7 | 224 |
| 低风险 | 0 | 0 |
| 修复程度 | 12/12（100%） | 100% |

## 风险矩阵

| 风险 | 问题 | 修复结果 |
|---|---|---|
| 高 | 只按 Recall/Precision 开启注入，忽略 Scope/L4/来源 | ACTIVE 使用完整 `gatePassed` Evidence；所有安全审计必须同时为零/100%。 |
| 高 | Golden 配置与激活配置不一致 | Runner 内部计算 config SHA-256，Rollout Evidence 使用同一报告值。 |
| 高 | 项目 B 资产通过主动注入或 MCP 泄漏 | Dataset forbidden + Trace scope audit + MCP current Scope 三层 Gate。 |
| 高 | timeout 测试只检查状态但仍有 stdout | 同时断言 `output=undefined` 且序列化结果为空字符串。 |
| 高 | MCP 故障成为主动注入依赖 | 架构 Gate 检查双向 package dependencies 均不存在。 |
| 中 | 自动 L4 未被显式统计 | Golden report 审计 automaticL4Count=0。 |
| 中 | 默认 Envelope 预算回归 | 固定数据集 P95 必须 ≤800 且 overBudget=0。 |
| 中 | 结果有 ID 但没有来源 | Traceability 要求 channel、rerank reason 和 sourceEpisode 全部存在。 |
| 中 | L3 展开重复 L2 内容 | 分别从 L1/L2 调用 get，断言无 title/scope 且只有 delta。 |
| 中 | forbidden 资产未进入 Precision 分母仍被忽略 | 单独断言 forbiddenHits=0。 |
| 中 | Fixture Gate 被误当生产放量结论 | 报告明确仅授权 P6，真实部署仍 OFF 并需目标项目 Shadow Evidence。 |
| 中 | Gate 无法复现 | Dataset、配置、Fallback 模式和所有 reason axes 固定入库。 |

## Gate 证据

| 检查项 | 结果 |
|---|---|
| 专项 | P5 Gate 2/2；Recall@5/Precision@5/Traceability 100% |
| 全仓 | 491/491 模块；43/43 架构/Gate |
| 整体覆盖率 | Lines 97.04%、Branches 90.16% |
| Workspace | 29 个，依赖/import policy 通过 |
| 供应链 | 0 vulnerabilities |

## Review 结论

P5 Gate 五项验收满足，12 项风险全部修复，无遗留 actionable finding。可以进入 P6。
