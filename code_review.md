# ZhiLoop Code Review

## 统计概览

| 指标 | 当前 | 累计 |
|---|---:|---:|
| CR 标识/次数 | CKL-502 | 31 次 |
| 耗时 | 780s | 14400s |
| 高风险 | 8 | 113 |
| 中风险 | 10 | 172 |
| 低风险 | 0 | 0 |
| 修复程度 | 18/18（100%） | 100% |

## 风险矩阵

| 风险 | 问题 | 修复结果 |
|---|---|---|
| 高 | BM25/cosine/exact 原始分数直接相加 | 通道内排序后只用 rank，RRF contribution 为 `1/(k+rank)`。 |
| 高 | Scope 作为弱权重被高分结果抵消 | Scope 是融合前强制门禁，且 Relation 目标二次过滤。 |
| 高 | 调用者伪造 QueryContext boundary 跨项目 | 校验 boundary 与可信 project/task 一致，不一致整请求拒绝。 |
| 高 | FTS/Port 返回旧版本导致历史知识召回 | 每个 source hit 与 getCurrent 的 version+contentHash 对照。 |
| 高 | Vector 旧 chunk 或 supersede chunk 继续命中 | chunk version+assetContentHash 必须等于 current；同 asset 去重。 |
| 高 | Relation 从项目 A 搭桥到项目 B | 仅 eligible seed 扩展，target 再走 Scope gate。 |
| 高 | STALE/SUPERSEDED/tombstone 默认进入结果 | eligibility 只允许 ACCEPTED/IMPLEMENTED/VERIFIED；tombstone 无条件拒绝。 |
| 高 | NaN/负 rank 污染 RRF 为 NaN | Port hit 强制 positive safe rank、finite rawScore 和有界 reason。 |
| 中 | 一个可选通道失败拖垮召回 | 每通道隔离捕获并返回 CHANNEL_FAILED，保留其他结果。 |
| 中 | embedding/index 版本不一致产生无意义相似度 | 版本不等时不 embed/search，记录 VECTOR_VERSION_MISMATCH。 |
| 中 | 超长 prompt 直接发送 embedding 增加成本 | Vector query 上限 20k，超限仅关闭该通道。 |
| 中 | 同资产多 chunk/多 query 重复加分 | 各通道先按 assetId 去重，跨通道才累计一次 contribution。 |
| 中 | Relation 从不合格结果出发 | seed 来自 Exact/FTS/Vector 经 status+scope 过滤后的 provisional RRF。 |
| 中 | 通道无法独立关闭 | options 与 policy topK 均可逐通道关闭，并保留诊断。 |
| 中 | 全表扫描固定 1,000 截断 | SQLite Adapter 以 1,000 条分页读至末页。 |
| 中 | 融合输出无界 | 每通道 <=100，最终 <= rerank.candidates <=100。 |
| 中 | 错误消息携带控制字符/超长供应商正文 | diagnostic 统一去控制字符并截断 500。 |
| 中 | 下游修改 contribution/Scope 事实 | RetrievalResult 递归 freeze。 |

## Gate 证据

| 检查项 | 结果 |
|---|---|
| 专项 | 12/12；Lines 98.13%、Branches 89.04% |
| 全仓 | 431/431 模块；40/40 架构/Gate |
| 整体覆盖率 | Lines 97.13%、Branches 90.21% |
| Workspace | 24 个，依赖/import policy 通过 |
| 供应链 | 0 vulnerabilities |

## Review 结论

CKL-502 四项验收满足，18 项风险全部修复，无遗留 actionable finding。可以进入 CKL-503。
