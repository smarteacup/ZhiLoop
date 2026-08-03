# ZhiLoop Code Review

## 📊 统计概览

### 当前 CR 情况

| 指标 | 数值 |
|---|---:|
| CR 标识 | `main@85aeb89+progressive-knowledge-disclosure` |
| CR 耗时 | 97s |
| 🔴 高风险 | 1 个 |
| 🟡 中风险 | 0 个 |
| 🟢 低风险 | 0 个 |
| 修复程度 | 已修复 1/1（100%） |

### 累计情况

| 指标 | 累计值 |
|---|---:|
| 总 CR 次数 | 47 次 |
| 总耗时 | 22747s |
| 🔴 高风险累计 | 222 个 |
| 🟡 中风险累计 | 304 个 |
| 🟢 低风险累计 | 0 个 |
| 平均修复程度 | 100% |

## 改动说明

本次变更把知识注入从统一 L2/L3 调整为渐进式披露。自动 UserPrompt 首次上下文会为 Binding Rule 保留 L2 门禁摘要，其他候选只提供 L1 简介；Codex 再用 `ckl.get` 定向展开所选知识到 L2 边界或 L3 正文与证据。

运行中接口同步调整：`ckl.search/related` 返回 L1 Pointer，`ckl.get.targetDetailLevel` 为可选新增字段，不传时仍保持旧 L3 行为。Push 与 Pull 继续复用 current version、状态和 QueryContext Scope 校验；自动高风险信号不再批量注入 L3，而由显式 Pull 或有限闭环补充。

默认策略从 L2 改为 L1，Pointer 上限从 3 提高到 8，硬预算仍为 800 tokens。OpenSpec、ADR/TDD、插件 Skill、MVP/P5 Gate 和真实会话模拟已同步。

## 风险矩阵

| 维度 | 风险 | 代码定位 | 问题描述 | 影响范围 | 修复结果 |
|---|---|---|---|---|---|
| 增/接口重构 | 🔴 高 | `packages/stop-continuation/src/types.ts:4`、`packages/stop-continuation/src/service.ts:174` | MCP Expansion 类型加入 L2 后，Stop context continuation 原端口会同时接受 L2，可能把仅有边界的结果当成满足 L3 required knowledge。 | 高风险任务闭环、缺失证据补充和完成门禁。 | 新增 `KnowledgeMcpEvidencedExpansionDelta` 收窄端口，并在运行时强制 `toDetailLevel=L3_EVIDENCED`；新增伪造 L2 delta 回归测试，已修复。 |

## 配置检查

| 配置 | 代码默认值 | 部署 YAML | 结论 |
|---|---|---|---|
| `injection.defaultLevel` | `L1_POINTER` | `L1_POINTER` | 一致 |
| `levels.L1_POINTER.maxItems` | 8 | 8 | 一致 |
| `levels.L2_COMPACT.maxItems` | 8 | 8 | 一致 |
| `defaultMaxTokens` | 800 | 800 | 未扩大硬预算 |

仓库没有 pre/prod/inner 多环境注入配置；受检 YAML 通过配置加载器与默认值契约测试。该默认行为变化仍受既有 OFF/SHADOW/ACTIVE rollout 和快速回滚保护。

## Gate 证据

| 检查项 | 结果 |
|---|---|
| OpenSpec strict validate | 1/1 通过 |
| ZhiLoop Skill validate | 通过 |
| 渐进披露专项 | 72/72 通过 |
| Stop/MCP/Orchestrator 回归 | 31/31 通过 |
| 真实会话模拟 | 7/7 场景通过；L1→L2/L3 定向展开通过 |
| 架构/Gate | 51/51 通过 |
| 模块测试 | 626/626 通过 |
| 覆盖率 | Lines 96.86%、Branches 89.73%、Functions 97.91% |

## Review 结论

新增接口保持旧 `ckl.get` 缺省 L3 兼容，Scope/状态/版本门禁没有放宽。发现的 1 个高风险闭环类型退化已通过类型收窄、运行时校验和回归测试闭环，无遗留 actionable finding。
