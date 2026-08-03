# ZhiLoop Code Review

## 📊 统计概览

### 当前 CR 情况

| 指标 | 数值 |
|---|---:|
| CR 标识 | `main@144cecc+rendered-budget-follow-up` |
| CR 耗时 | 212s |
| 🔴 高风险 | 0 个 |
| 🟡 中风险 | 2 个 |
| 🟢 低风险 | 0 个 |
| 修复程度 | 已修复 2/2（100%） |

### 累计情况

| 指标 | 累计值 |
|---|---:|
| 总 CR 次数 | 48 次 |
| 总耗时 | 22959s |
| 🔴 高风险累计 | 222 个 |
| 🟡 中风险累计 | 306 个 |
| 🟢 低风险累计 | 0 个 |
| 平均修复程度 | 100% |

## 改动说明

本次变更修正渐进披露的两个生产化问题。Token 上限从只核算内部 `ContextEnvelope` 改为核算完整 `additionalContext`，安全前缀、Authority 语义、渐进披露协议、Trace 元数据和知识目录均进入同一固定点估算；编排器和 Hook 复用新模块 `@zhiloop/context-renderer`，避免两套规则漂移。

目录预算新增 `disclosedItems` 与 `omittedItems`。存在合格但未展示的知识时，注入内容提供结构化 `progressiveDisclosure.directory.nextAction`，模型可以先用窄化 `ckl.search` 找回 L1 Pointer，再按需用 `ckl.get` 展开 L2/L3；Binding Rule 仍优先以 L2 保留。

`ContextOrchestrationRequest.traceId` 以及两个预算计数字段成为内部必填契约，相关 Schema、调用方、Gate 和文档已同步。项目尚未部署，没有外部兼容调用方；默认 800-token 配置、Scope/Status/current-version 门禁和 OFF/SHADOW/ACTIVE 回滚语义均未放宽。

## 风险矩阵

| 维度 | 风险 | 代码定位 | 问题描述 | 影响范围 | 修复结果 |
|---|---|---|---|---|---|
| 增/新增字段 | 🟡 中 | `packages/codex-context-injection/src/service.ts` | Hook 的运行时边界最初只用 `>= 0` 校验 `omittedItems`，错误 Provider 可能传入小数或非安全整数并产生失真的目录元数据。 | ACTIVE 注入的预算可信度和 continuation 决策。 | 对 max/estimated/disclosed/omitted 全部增加 `Number.isSafeInteger` 门禁，并加入小数省略数拒绝回归，已修复。 |
| 删/测试重构 | 🟡 中 | `packages/model-codex-exec/src/model.test.ts` | 并发全仓测试下，5ms timer 可能在 Fake Process 注册 abort listener 前触发；事件不会回放，导致用例等待到 Vitest 5s 总超时。生产 `NodeCodexExecProcess` 已处理 pre-aborted signal，但测试替身未遵守同一端口语义。 | CI/Gate 稳定性，不影响生产 Adapter。 | Fake Process 在注册 listener 前检查 `signal.aborted` 并立即 reject；完整 Gate 重跑稳定通过，已修复。 |

## 配置检查

| 配置 | 变更前 | 变更后 | 结论 |
|---|---:|---:|---|
| `injection.defaultMaxTokens` | 800 | 800 | 硬预算未扩大，核算对象改为最终渲染文本 |
| `injection.defaultLevel` | `L1_POINTER` | `L1_POINTER` | 渐进披露默认层级未变化 |
| OFF/SHADOW/ACTIVE | 已启用 | 已启用 | 发布与快速回滚门禁未变化 |

仓库没有 pre/prod/inner 多环境注入配置；本次没有新增部署配置项。新增 workspace 依赖由 allowlist、TypeScript Project References 和 import policy 共同约束。

## Gate 证据

| 检查项 | 结果 |
|---|---|
| OpenSpec strict validate | `progressive-knowledge-disclosure` 有效，19/19 任务完成 |
| 渐进披露专项 | 34/34 通过 |
| 共享 Renderer 直接测试 | 3/3；Statements 95.83%、Branches 94.44%、Functions 100%、Lines 94.44% |
| 真实会话模拟 | 7/7 场景通过；截断后 `ckl.search` → L2/L3 展开通过 |
| Workspace/import policy | 38/38 通过 |
| 架构/Gate | 51/51 通过 |
| 模块测试 | 630/630 通过 |
| 全仓覆盖率 | Statements 94.47%、Branches 89.81%、Functions 97.99%、Lines 96.86% |

## Review 结论

最终渲染预算、Binding Rule 保留、截断可发现性、Scope/Status/version 校验和搜索后定向展开均有直接自动化证据。发现的两个中风险问题已闭环，无遗留 actionable finding；性能上自动路径最多 8 条候选且无新增 I/O，固定点序列化开销有界，未发现当前部署规模下的瓶颈。
