# ZhiLoop Code Review

## 统计概览

| 指标 | 当前 | 累计 |
|---|---:|---:|
| CR 标识/次数 | CKL-507 | 36 次 |
| 耗时 | 420s | 16680s |
| 高风险 | 7 | 147 |
| 中风险 | 9 | 217 |
| 低风险 | 0 | 0 |
| 修复程度 | 16/16（100%） | 100% |

## 风险矩阵

| 风险 | 问题 | 修复结果 |
|---|---|---|
| 高 | Search/Related 命中对象伪造 Scope/Status/正文 | 对命中 ID 批量 current；输出只使用 current 对象字段。 |
| 高 | 项目 A MCP 返回项目 B 知识 | 四工具统一执行 QueryContext Scope gate，USER/TEAM 当前拒绝。 |
| 高 | `ckl.get` 展开旧版本 | 请求 version 必须等于 current，变化时只返回 VERSION_MISMATCH。 |
| 高 | Related 越界 seed 扩散到关系图 | 所有 seed 先做 current + status + scope 资格校验。 |
| 高 | MCP 故障拖垮主动注入 | 两包双向无依赖，架构测试固定；工具错误不进入注入链。 |
| 高 | 完整 Envelope 重复注入导致上下文膨胀 | search/related 排除已知 id@version；get 只返回 content/evidence 新增字段。 |
| 高 | Backend 对同 ID 声称多个 current | version/contentHash 任一冲突即拒绝整次调用。 |
| 中 | known 旧版本阻止新版本返回 | 去重键包含 id@version，current 新版本仍可返回。 |
| 中 | 自然语言 query 或批量输入无界 | query 20k、items 8、seed 20、known/check 100 硬限制。 |
| 中 | 非法 Trace ID 污染工具追溯 | 所有 Backend result 先校验有限单行 ID。 |
| 中 | Get 重复 title/summary/scope 等已知字段 | ExpansionDelta 类型和契约测试只允许 L3 新增内容。 |
| 中 | Check 无法解释不合格原因 | 当前版本、状态、Scope 分别输出 reason codes。 |
| 中 | 取消请求仍触发 Backend | 四工具入口先检查 AbortSignal，测试验证零调用。 |
| 中 | 重复 seed/check ID 造成歧义 | 输入集合强制唯一。 |
| 中 | 调用者修改工具结果污染缓存 | 全部结果递归 freeze。 |
| 中 | Relation 输出重复 seed | 显式 seed 集合过滤后再做 known 去重。 |

## Gate 证据

| 检查项 | 结果 |
|---|---|
| 专项 | Knowledge MCP 6/6；Lines 97.16%、Branches 88.18% |
| 全仓 | 491/491 模块；41/41 架构/Gate |
| 整体覆盖率 | Lines 97.04%、Branches 90.16% |
| Workspace | 29 个，依赖/import policy 通过 |
| 供应链 | 0 vulnerabilities |

## Review 结论

CKL-507 五项验收满足，16 项风险全部修复，无遗留 actionable finding。可以进入 P5 Gate。
