# ZhiLoop Code Review

## 统计概览

| 指标 | 当前 | 累计 |
|---|---:|---:|
| CR 标识/次数 | CKL-504 | 33 次 |
| 耗时 | 420s | 15300s |
| 高风险 | 6 | 125 |
| 中风险 | 9 | 190 |
| 低风险 | 0 | 0 |
| 修复程度 | 15/15（100%） | 100% |

## 风险矩阵

| 风险 | 问题 | 修复结果 |
|---|---|---|
| 高 | 全部候选不合格时仍生成 L2 元数据 | 复杂度选择基于通过 Status 和 Scope 门禁的候选；空集固定 L0。 |
| 高 | `scopeMatched=false` 候选被上游误传后注入 | Orchestrator 增设 Scope 防御过滤并记录不合格原因。 |
| 高 | 自动注入 L4 泄露完整 Episode | 自动模式或未显式展开时硬降为 L3，并输出原因码。 |
| 高 | Task Contract 挤掉动态项目知识 | Contract 只消耗剩余预算；超限优先省略 Contract。 |
| 高 | 参考知识被渲染成规则 | 每项显式携带 Authority，Envelope 汇总 MIXED，不根据自然语言推断。 |
| 高 | 超预算仍输出导致下游上下文膨胀 | 保守 token 估算、按优先级截断、L3/L2→L1→L0 降级，最终 Schema 前再次校验。 |
| 中 | L1 携带正文或 Evidence 越层 | JSON Schema 按 detailLevel 使用字段门禁，越层字段验证失败。 |
| 中 | Scope/Status/Authority 排序混淆 | 比较器固定 Scope > Status > Authority > Rerank rank > ID。 |
| 中 | JSON Schema strict 模式未启动即失效 | 所有 conditional required 在同一子模式声明 properties，并由 AJV 严格编译测试覆盖。 |
| 中 | 配置 YAML 与代码默认值漂移 | 读取仓库 `injection-policy.yaml` 并与 DEFAULT_CONFIGURATION 做契约测试。 |
| 中 | Tokenizer 差异低估体积 | UTF-8 JSON 采用 3 bytes/token 保守估计，CKL-505 再审计真实复杂度。 |
| 中 | Reason code 自身挤掉知识 | Contract 省略场景先移除普通 level 原因，保留异常原因和动态知识。 |
| 中 | 调用者对象被递归冻结 | 输出在 schema parse 后 structuredClone，再 deep freeze。 |
| 中 | 运行时非法 level/runId/budget 造成非确定错误 | 对公开请求边界做显式 level、文本和整数范围检查。 |
| 中 | 顶层扩展破坏前向兼容 | 顶层保留 extension，嵌套信任结构拒绝未知字段。 |

## Gate 证据

| 检查项 | 结果 |
|---|---|
| 专项 | Orchestrator 13/13；Lines 93.43%、Branches 88.88%；Schema 4/4 |
| 全仓 | 461/461 模块；40/40 架构/Gate |
| 整体覆盖率 | Lines 96.82%、Branches 90.05% |
| Workspace | 26 个，依赖/import policy 通过 |
| 供应链 | 0 vulnerabilities |

## Review 结论

CKL-504 七项验收满足，15 项风险全部修复，无遗留 actionable finding。可以进入 CKL-505。
