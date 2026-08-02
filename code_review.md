# ZhiLoop Code Review

## 统计概览

| 指标 | 当前 | 累计 |
|---|---:|---:|
| CR 标识/次数 | CKL-404 | 27 次 |
| 耗时 | 400s | 12120s |
| 高风险 | 5 | 90 |
| 中风险 | 7 | 140 |
| 低风险 | 0 | 0 |
| 修复程度 | 12/12（100%） | 100% |

## 风险矩阵

| 风险 | 问题 | 修复结果 |
|---|---|---|
| 高 | NaN/Infinity/维度错在删除旧记录后才失败 | 全 batch 校验后构造 next Map，再原子替换。 |
| 高 | replace 追加导致旧版本 chunk 仍召回 | 按 assetId 删除旧批次后整体替换；remove 清空。 |
| 高 | embedding 模型变化仍按 contentHash 复用旧向量 | Port 强制 embeddingVersion，缓存 namespaced，索引禁止混版。 |
| 高 | 向量失败回滚已可用 FTS | Vector 是 CKL-403 后置 sink；失败仅标记可重试，SQLite 保持完成。 |
| 高 | LRU 小于当前 batch 时逐条淘汰导致本批缺向量 | batch-local resolved Map 与跨批 LRU 分离。 |
| 中 | disabled 仍调用 embedding | sink 首行按 `index.enabled` 返回；专项调用数为 0。 |
| 中 | embedding 输出数量错位 | 数量必须与去重输入精确相等。 |
| 中 | duplicate chunkId 覆盖 | 替换前 Set 拒绝。 |
| 中 | 零向量 cosine 除零 | 返回通道分数 0。 |
| 中 | 缓存无界 | 1～1,000,000 可配置 LRU，默认 10,000。 |
| 中 | limit 无界 | search limit 1～100。 |
| 中 | cosine 分数直接与 BM25 相加 | Port 只输出通道内排名；CKL-502 明确使用 RRF。 |

## Gate 证据

| 检查项 | 结果 |
|---|---|
| 专项 | 6/6；Lines 98.92%、Branches 91.30% |
| 全仓 | 390/390 模块；38/38 架构/Gate |
| 整体覆盖率 | Lines 96.97%、Branches 90.08% |
| Workspace | 21 个，依赖/import policy 通过 |
| 供应链 | 0 vulnerabilities |

## Review 结论

CKL-404 三项验收条件满足，12 项风险全部修复。可以进入 CKL-405 知识治理 CLI。
