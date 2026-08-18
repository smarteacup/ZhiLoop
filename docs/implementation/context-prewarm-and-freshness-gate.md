# M7 上下文预热与注入前保鲜门禁

预热缓存只保存稳定的 L1 目录，不保存知识正文或实时代码事实。真正进入 Prompt 的最终代码类候选仍按当前资产版本、内容哈希、项目和 Freshness 投影做一次门禁。

```text
session/project/policies/revisions -> L1 cache
prompt -> retrieval -> eligibility -> freshness gate -> Context Envelope
```

缓存故障和 Freshness UNKNOWN 都不会阻塞 Codex；区别是前者退化为实时召回，后者禁止把无法确认的实现结论注入成当前事实。

实现约束：预热最多占用 50ms、扫描最多 10,000 条 Registry 投影且扫描前后 revision 必须一致；缓存每会话最多保留 8 个依赖版本。相同 session/project/worktree/branch/Registry/Policy/Scope 在不同 Turn 共用一个目录，显式刷新会幂等清空该会话目录。

Freshness 许可绑定 `assetId + assetVersion + contentHash + projectId`。旧版本不能借用新版本结果；`IMPLEMENTATION` 或带 Symbol 的知识在投影缺失、版本不匹配、REVALIDATE、CONFLICT、UNKNOWN 时从最终候选剔除，并在 Retrieval diagnostics 中记录原因。
