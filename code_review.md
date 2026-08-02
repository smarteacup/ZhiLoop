# ZhiLoop Code Review

## 统计概览

| 指标 | 当前 | 累计 |
|---|---:|---:|
| CR 标识/次数 | CKL-605 | 42 次 |
| 耗时 | 600s | 20430s |
| 高风险 | 8 | 198 |
| 中风险 | 10 | 277 |
| 低风险 | 0 | 0 |
| 修复程度 | 18/18（100%） | 100% |

## 风险矩阵

| 风险 | 问题 | 修复结果 |
|---|---|---|
| 高 | pin 让 PROPOSED/STALE/越 Scope 资产复活 | Retrieval 先执行全部安全 eligibility，再应用 feedback。 |
| 高 | suppress 在其他项目也隐藏资产 | exact scopeKey 分区，QueryContext 推导值必须一致。 |
| 高 | 同 Scope suppress 后仍重复出现 | fused eligible 结果在返回前强制删除 suppressed ID。 |
| 高 | 伪造 feedback score 操纵排序 | relevant/irrelevant 非负有界且 `score=relevant-irrelevant`。 |
| 高 | 单次误反馈直接改变上下文深度 | L1 至少 2 个负样本；L3 至少 3 个正样本、2 次展开和 50% 使用率。 |
| 高 | feedback 降低高风险证据级别 | risk/ambiguity/conflict 在 feedback 后强制 L3。 |
| 高 | feedback 自动注入 L4 | Hint 类型和运行时只接受 L1-L3。 |
| 高 | MCP 拉取被误当实际使用 | Expansion/Usage 独立表，usage 必须绑定真实 expansion + trace。 |
| 中 | 同资产同时 pin 和 suppress | Store 以最后控制事件为准；外部 Profile 矛盾时拒绝。 |
| 中 | 重放反馈放大权重 | event ID + payload hash 幂等，不同内容冲突。 |
| 中 | pin/suppress 操作顺序不稳定 | occurredAt + eventId 确定性排序。 |
| 中 | 跨 Scope 统计影响复杂度 | Profile SQL 只聚合 exact scopeKey。 |
| 中 | relevant 多但从未使用仍提升 L3 | L3 必须同时满足 MCP actual usage。 |
| 中 | 调用方伪造 0 样本 L3 Hint | Context Orchestrator 复核 sampleCount 和固定 reason code。 |
| 中 | feedback 覆盖用户显式 requestedLevel | 显式 requestedLevel 优先。 |
| 中 | token feedback 导致预算膨胀 | 原 Context budget 降级/截断逻辑保持最后裁决。 |
| 中 | 一个 expansion 重复标记多次 used | `UNIQUE(expansion_id)` 和显式冲突诊断。 |
| 中 | Profile 集合无界拖慢召回 | Retrieval feedback 输入上限 10,000，SQLite 复合索引。 |

## Gate 证据

| 检查项 | 结果 |
|---|---|
| Feedback Store 专项 | 6/6；Statements 93.87%、Branches 91.46%、Lines 98.64% |
| Feedback/Retrieval/Context 联合 | 31/31 |
| 全仓 | 558/558 模块；43/43 架构/Gate |
| 整体覆盖率 | Lines 96.98%、Branches 89.89%、Functions 98.43% |
| Workspace | 34 个，依赖/import policy 通过 |
| 供应链 | 0 vulnerabilities |

## Review 结论

CKL-605 三项验收满足，18 项风险全部修复，无遗留 actionable finding。反馈只能后置影响 eligible 候选与 L1-L3 深度，不能绕过知识状态、Scope、高风险或预算门禁。可以执行 P6 Gate。
