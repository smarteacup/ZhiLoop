# ZhiLoop Code Review

## 统计概览

| 指标 | 当前 | 累计 |
|---|---:|---:|
| CR 标识/次数 | P4 Gate | 29 次 |
| 耗时 | 360s | 13200s |
| 高风险 | 4 | 100 |
| 中风险 | 5 | 154 |
| 低风险 | 0 | 0 |
| 修复程度 | 9/9（100%） | 100% |

## 风险矩阵

| 风险 | 问题 | 修复结果 |
|---|---|---|
| 高 | Gate 直接构造最终 Asset，绕过对话与验证链 | 从录制 Hook 生成 Episode，经真实 Compiler/Scope/Verifier/Policy 后才 materialize。 |
| 高 | 全部不发布也能得到 0% 误确认 | Dataset 强制 200 个正例且 false negative 必须为 0。 |
| 高 | 重建只比较搜索命中，可能丢版本或边 | 比较当前资产、immutable versions、Relation、Evidence 与 FTS 结果。 |
| 高 | Shadow 评估意外调用 Publisher | Runner 只收集 shouldPublish 决策并断言可见写入数为 0。 |
| 中 | 错误率使用总样本稀释负例风险 | 分母固定为所有 expectedShouldPublish=false 的 300 个负例。 |
| 中 | ERROR 被错误当成 UNKNOWN 或支持证据 | 独立 100 例异常 Probe，真实 Registry 隔离后均不得发布。 |
| 中 | indexVersion 重建后不同导致假失败 | 等价快照排除运行序号，只比较业务内容。 |
| 中 | 临时 Gate 数据污染工作区/用户目录 | 仅 mkdtemp 写入并 finally 清理，不触及用户配置。 |
| 中 | 远端模型使 Gate 不可复现 | 使用确定性模型 Port；Schema 与后续领域/存储路径仍为真实实现。 |

## Gate 证据

| 检查项 | 结果 |
|---|---|
| 专项 | P4 Gate 2/2；500 个 Shadow cases |
| 全仓 | 409/409 模块；40/40 架构/Gate |
| 整体覆盖率 | Lines 97.00%、Branches 90.14% |
| Workspace | 22 个，依赖/import policy 通过 |
| 供应链 | 0 vulnerabilities |

## Review 结论

P4 Gate 三项验收满足，Shadow 错误自动确认率 0.00%，9 项风险全部修复，无遗留 actionable finding。可以进入 CKL-501。
