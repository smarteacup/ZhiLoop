# ZhiLoop Code Review

## 统计概览

| 指标 | 当前 | 累计 |
|---|---:|---:|
| CR 标识/次数 | CKL-601 | 38 次 |
| 耗时 | 540s | 17580s |
| 高风险 | 8 | 160 |
| 中风险 | 10 | 234 |
| 低风险 | 0 | 0 |
| 修复程度 | 18/18（100%） | 100% |

## 风险矩阵

| 风险 | 问题 | 修复结果 |
|---|---|---|
| 高 | Semantic Verifier 新增任务外 Gate | 输出 Gate ID 必须与声明的 SEMANTIC 集合完全相等，否则 ASK_USER 且丢弃新 ID。 |
| 高 | 模型语义 PASS 覆盖 Boundary/测试失败 | Boundary 和确定性 Gate 在任何 Semantic 调用前决策并返回。 |
| 高 | 其他 task 的 Envelope 满足当前任务 | ContextEnvelope taskId 必须与 taskId 严格相等。 |
| 高 | `../`/`./`/绝对路径绕过 Boundary | Diff/Gate/Boundary 全部要求 canonical repository-relative path。 |
| 高 | 信息不足泛化为模糊重试 | 只返回原 requiredKnowledge 中缺失或 detail 不足的精确 ID。 |
| 高 | Correction 无法区分 Gate 与 Boundary | Schema 独立输出 unmetGateIds 和 violatedBoundaryIds。 |
| 高 | Semantic timeout 被 abort rejection 抢先误报 | catch 同时检查 error 和 AbortSignal.reason 的 Timeout 类型。 |
| 高 | Final conclusion 明确未完成仍 PASS | claimedComplete=false 强制 RETRY_WITH_CORRECTION。 |
| 中 | Tool/Test 重复 ID 选择首个造成歧义 | evidence 集合 ID 强制唯一。 |
| 中 | 结果 reason/gate fields 漂移 | 版本化 JSON Schema，嵌套 Gate Result strict。 |
| 中 | Semantic Port 读取完整对话引入隐式需求 | Port 输入只含 objective、声明 Gate、Envelope、Diff、Tool、Test、Conclusion。 |
| 中 | Semantic 输出 unknown 被当 PASS | UNKNOWN 固定 ASK_USER。 |
| 中 | Port 不可用伪造失败/成功 | 不可用固定 ASK_USER，不改变 Gate 事实。 |
| 中 | Required L3 被 L1/L2 误满足 | detail level 数值比较并覆盖浅层测试。 |
| 中 | Boundary 违规只给泛化文本 | 返回原始 boundaryId，可直接生成 correction delta。 |
| 中 | Closure policy 文件与默认值漂移 | 仓库 YAML 与 DEFAULT_CONFIGURATION 契约测试。 |
| 中 | 输出被调用者修改 | Schema parse 后 clone + recursive freeze。 |
| 中 | 无界 evidence 集合拖慢 Stop | Gate/Boundary/Knowledge 100，Diff/Tool/Test 10k 硬限制。 |

## Gate 证据

| 检查项 | 结果 |
|---|---|
| 专项 | Closure Verifier 8/8；Lines 100%、Branches 89.83% |
| 全仓 | 499/499 模块；43/43 架构/Gate |
| 整体覆盖率 | Lines 97.06%、Branches 90.15% |
| Workspace | 30 个，依赖/import policy 通过 |
| 供应链 | 0 vulnerabilities |

## Review 结论

CKL-601 五项验收满足，18 项风险全部修复，无遗留 actionable finding。可以进入 CKL-602。
