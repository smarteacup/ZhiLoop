# M6 知识保鲜实施说明

代码改动不会全库重新提取知识。发布时，ZhiLoop 把 Candidate 的路径、符号、配置和依赖断言投影成反向索引；变更到来时只重验证命中的知识。

```text
Knowledge publication -> freshness anchors
Git/CodeGraph changes -> affected asset IDs
affected Candidate assertions -> Evidence revalidation
invalidation-engine -> freshness state + CAS mutation plan
governance boundary -> optional new STALE/fingerprint version
```

`FRESH/REVALIDATE/CONFLICT/UNKNOWN` 表示“当前实现一致性”，不覆盖 `ACCEPTED/IMPLEMENTED/VERIFIED/STALE/SUPERSEDED` 的历史语义。

SQLite 使用不可变的 `(assetId, assetVersion)` 历史投影、独立当前版本指针和版本化 Anchor。版本检查与写入位于同一个 `BEGIN IMMEDIATE` 事务中：同版本同载荷幂等、不同载荷或非连续版本失败关闭；变更反查只返回当前版本，历史版本仍可审计。

Worker 在 `REGISTRY_PROJECT` 之后、`INCREMENTAL_INDEX` 之前持久化 `FRESHNESS_PROJECT` checkpoint。该阶段暂时失败时，恢复只重试保鲜投影，不重复 Markdown 或 Registry 副作用。
