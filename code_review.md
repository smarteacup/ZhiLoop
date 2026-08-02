# ZhiLoop Code Review

## 统计概览

| 指标 | 当前 | 累计 |
|---|---:|---:|
| CR 标识/次数 | CKL-503 | 32 次 |
| 耗时 | 480s | 14880s |
| 高风险 | 6 | 119 |
| 中风险 | 9 | 181 |
| 低风险 | 0 | 0 |
| 修复程度 | 15/15（100%） | 100% |

## 风险矩阵

| 风险 | 问题 | 修复结果 |
|---|---|---|
| 高 | Port 返回未知/重复/缺失 ID 注入或删除候选 | 输出必须恰好覆盖输入 ID 集合且每个一次，否则完整 fallback。 |
| 高 | Port 返回完整 Asset 篡改 Scope/Status/Evidence | Port 只返回 assetId/score/reason；最终 Asset 来自 CKL-502 原对象克隆。 |
| 高 | Rerank 异常导致结果为空或顺序改变 | unavailable/error/timeout/invalid output 均按 originalRank fallback。 |
| 高 | 超时后模型请求仍持续消耗 | deadline 触发 AbortController，Port 可立即取消底层调用。 |
| 高 | 同 subject 多个 id 同时进入注入 | 最终排序后按 subjectKey 保留最高项，记录 kept/removed。 |
| 高 | 将 body/Episode 正文发送给 Rerank 模型 | 输入只含 title/summary/边界/证据 ID/通道解释，不含 body/source episode。 |
| 中 | NaN/Infinity/越界 score 破坏排序 | score 必须 finite 且在 [-1,1]。 |
| 中 | 无理由的模型排序不可解释 | 每项强制 1～10 个受限 reason codes。 |
| 中 | Port 接收超过 30 候选造成上下文膨胀 | originalRank 排序后硬截前 30，并输出 limit 诊断。 |
| 中 | 超长 query 进入 Port | 20k 上限，超限原样 fallback。 |
| 中 | deepFreeze 反向冻结调用者对象 | Port 输入和最终输出先 clone，再冻结副本。 |
| 中 | score 并列导致非确定顺序 | originalRank 后 assetId 稳定 tie-break。 |
| 中 | provider 错误包含控制字符/长正文 | diagnostic 去控制字符并截断 500。 |
| 中 | timer 未释放造成进程滞留 | success/error/timeout 均在 finally clearTimeout。 |
| 中 | 输出解释丢失 RRF 贡献 | 每项保留 originalRank、Scope/Status/Evidence 和 contributions。 |

## Gate 证据

| 检查项 | 结果 |
|---|---|
| 专项 | 15/15；Lines 100%、Branches 97.29% |
| 全仓 | 446/446 模块；40/40 架构/Gate |
| 整体覆盖率 | Lines 97.20%、Branches 90.35% |
| Workspace | 25 个，依赖/import policy 通过 |
| 供应链 | 0 vulnerabilities |

## Review 结论

CKL-503 三项验收满足，15 项风险全部修复，无遗留 actionable finding。可以进入 CKL-504。
