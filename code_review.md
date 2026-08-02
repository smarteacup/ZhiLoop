# ZhiLoop Code Review

## 统计概览

| 指标 | 当前 | 累计 |
|---|---:|---:|
| CR 标识/次数 | CKL-603 | 40 次 |
| 耗时 | 750s | 18930s |
| 高风险 | 10 | 179 |
| 中风险 | 11 | 255 |
| 低风险 | 0 | 0 |
| 修复程度 | 21/21（100%） | 100% |

## 风险矩阵

| 风险 | 问题 | 修复结果 |
|---|---|---|
| 高 | 每个冲突各问一个问题导致确认洪泛 | 单次决策最多一个 Request，其余全部 defer。 |
| 高 | 仅限制每 Turn 仍无法满足 P6 低频 Gate | 实现滚动 20 Turn 只允许一次提问。 |
| 高 | 用户沉默被当作同意 GLOBAL 晋升 | Scope safe effect 固定 `KEEP_PROJECT`。 |
| 高 | 用户沉默后执行规则覆盖或不可逆动作 | Rule safe effect 固定 `KEEP_RULE`；不可逆项只提升优先级，不改变默认。 |
| 高 | 低影响 UNKNOWN 生成审核任务和人工债务 | 固定 `KEEP_PROPOSED`，`reviewTasksCreated=0`。 |
| 高 | 不同 Adapter 自行解释 Evidence/Closure reason code | 提供 Evidence、Closure、Rule 三类受限 Trigger Adapter。 |
| 高 | 外部输入绕过 TypeScript 传入未知 kind/impact | 运行时枚举、identity、ID、集合与组合约束验证。 |
| 高 | Confirmation Schema 的显式选项 effect 越权 | 每类允许 effect 集合在 Domain 唯一定义，Parser 精确匹配两项。 |
| 高 | 一个确认误改未声明 Candidate | Request 和所有 default 都携带精确、唯一、上限 20 的 subject IDs。 |
| 高 | 同一 Trigger 跨 Turn 反复询问 | history 按 triggerId 永久去重，超过 20 Turn 也不重问。 |
| 中 | 模型改写摘要绕过重复门禁 | Trigger ID 不包含展示摘要，只绑定来源/类型/目标。 |
| 中 | subject 顺序变化产生不同 ID | 哈希前排序，Request/default 输出同步规范化。 |
| 中 | `localeCompare` 在不同运行环境改变优先级 | 使用稳定 code-point 比较。 |
| 中 | 配置降低冷却或打开审核队列 | 5 个 interaction 安全项全部使用 literal Schema。 |
| 中 | Evidence Policy 与 Interaction 使用不同配置快照 | Evidence Policy 复核完整 interaction 安全字段。 |
| 中 | 恶意 Proxy/Getter 令策略抛错 | 验证入口异常捕获，返回无问题的 DEFER。 |
| 中 | 历史包含未来 Turn 干扰预算 | history ordinal 必须不大于当前 Turn。 |
| 中 | safeDefaultOptionId 不存在或指向错误 effect | Schema Parser 做语义级 safeDefault 校验。 |
| 中 | Option 嵌套扩展悄悄改变回写语义 | nested option `additionalProperties=false`。 |
| 中 | 同优先级选择不稳定 | irreversible、impact、kind、triggerId 完整排序。 |
| 中 | 调用方修改决策对象 | Request、Trigger Adapter 输出和 Policy 决策递归冻结。 |

## Gate 证据

| 检查项 | 结果 |
|---|---|
| Interaction 专项 | 13/13；Lines 98.75%、Branches 88.61% |
| Schema/Config/Evidence 联合回归 | 78/78 |
| 全仓 | 526/526 模块；43/43 架构/Gate |
| 整体覆盖率 | Lines 97.02%、Branches 90.14%、Functions 98.71% |
| Workspace | 32 个，依赖/import policy 通过 |
| 供应链 | 0 vulnerabilities |

## Review 结论

CKL-603 三项验收及 P6 的 20 Turn 低频约束均满足，21 项风险全部修复，无遗留 actionable finding。ConfirmationRequest 已具备 CKL-604 所需的精确 target、固定 option 和安全默认契约，可以进入自然对话确认回写。
