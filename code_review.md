# ZhiLoop Code Review

## 统计概览

| 指标 | 当前 | 累计 |
|---|---:|---:|
| CR 标识/次数 | CKL-505 | 34 次 |
| 耗时 | 480s | 15780s |
| 高风险 | 7 | 132 |
| 中风险 | 9 | 199 |
| 低风险 | 0 | 0 |
| 修复程度 | 16/16（100%） | 100% |

## 风险矩阵

| 风险 | 问题 | 修复结果 |
|---|---|---|
| 高 | Trace 从 Rerank 结果复制 Scope/Evidence/来源导致解释被污染 | 信任字段和通道贡献固定取 Retrieval 原结果，只接收 Rerank 排名解释。 |
| 高 | Executor 返回其他 Golden Query 的 Trace 冒充结果 | Trace 记录 prompt SHA-256；Runner 校验 prompt/project/task 身份。 |
| 高 | 跨 Case 重复 Trace ID 破坏追溯唯一性 | Runner 维护本次 Trace ID 集合，重复按 Case ERROR。 |
| 高 | 调用方伪造配置指纹掩盖算法变化 | Runner 内部 canonical JSON + SHA-256，不接收外部指纹声明。 |
| 高 | 指标达标但 Scope 泄漏或自动 L4 仍开启默认注入 | `defaultInjectionAllowed` 绑定完整 Gate，而非仅质量阈值。 |
| 高 | forbidden 命中未影响门禁 | 单独累计 forbiddenHits，任何命中使完整 Gate 失败。 |
| 高 | 单 Case 异常终止整份评估 | Case 级隔离为 ERROR；相关 expected 仍进入 Recall 分母。 |
| 中 | Recall/Precision 分母定义随实现漂移 | 固定 micro top-K 公式并输出 hits/relevant/returned totals。 |
| 中 | 空或重复 relevant ID 产生虚高指标 | Dataset 要求每 Case 至少一个、唯一且合法 relevant ID。 |
| 中 | relevant 与 forbidden 重叠形成不可满足 Case | 加载时要求两集合不相交。 |
| 中 | 非 JSON、循环、非 finite 配置哈希不稳定 | canonicalizer 显式拒绝并覆盖攻击型测试。 |
| 中 | Rerank rank/版本/候选集合不一致 | 校验唯一连续 rank、original rank、ID 子集与版本。 |
| 中 | 错误文本泄露控制字符或无限增长 | 去 NUL/换行并限制 500 字符。 |
| 中 | 复杂度选择缺少风险/歧义/冲突/预算解释 | Trace 强制生成四个 reason-code 轴，Runner 统计缺失数。 |
| 中 | P95/空数据边界不确定 | 固定 nearest-rank P95；无成功 Trace 时复杂度统计为 0。 |
| 中 | Runner 并发造成结果顺序不稳定 | 当前离线顺序执行并保持 Dataset Case 顺序。 |

## Gate 证据

| 检查项 | 结果 |
|---|---|
| 专项 | Retrieval Evaluation 8/8；Lines 98.01%、Branches 89.89% |
| 全仓 | 471/471 模块；40/40 架构/Gate |
| 整体覆盖率 | Lines 97.06%、Branches 90.27% |
| Workspace | 27 个，依赖/import policy 通过 |
| 供应链 | 0 vulnerabilities |

## Review 结论

CKL-505 四项验收满足，16 项风险全部修复，无遗留 actionable finding。可以进入 CKL-506。
