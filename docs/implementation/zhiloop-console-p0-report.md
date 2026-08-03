# ZhiLoop Console P0 实施与 Gate 报告

## 交付边界

P0 交付的是当前用户本地、默认 SHADOW 的可观察与显式采集控制面。浏览器通过 loopback Gateway 查询 Sidecar；Sidecar 继续是 Ledger 唯一写入者，Gateway、Web 和 CLI 不直接写 Codex transcript 或 SQLite。Console 进程不进入 Hook 调用链。

## 实际能力矩阵

| 能力 ID | P0 实际状态 | 证据与边界 |
|---|---|---|
| `conversation.capture` | `READY / COMPONENT_READY` | preview/commit 已组合；提交绑定 session、revision、identity hash 和 idempotency key |
| `session.catalog` | `READY` 或 `DEGRADED` | transcript/App Server 能力决定；来源不可用时显示 `SOURCE_UNAVAILABLE` |
| `codex.live-hook` | `NOT_VERIFIED / CAPABILITY_NOT_VERIFIED` | 模拟 Hook 已通过；必须由新建真实 Codex task 验收后才能转 READY |
| `automatic.ingestion` | `DISABLED / CAPABILITY_DISABLED` | P1 durable job 和 scheduler 尚未组合 |
| `knowledge.compile` | `DISABLED / KNOWLEDGE_WORKER_NOT_COMPOSED` | capture 只到 Ledger，不宣称知识已提炼 |
| `knowledge.retrieval` | `DISABLED / CAPABILITY_DISABLED` | P3 检索查询端口尚未组合 |
| `context.injection` | `DISABLED / CAPABILITY_DISABLED` | SHADOW 质量与实际投递均未启用 |
| `knowledge.mcp` | `DISABLED / MCP_TRANSPORT_NOT_ENABLED` | 本地 MCP 传输尚未启用 |
| `closure.verification` | `DISABLED / STOP_VERIFIER_NOT_COMPOSED` | Stop 闭环验证尚未组合 |
| `active.rollout` | `DISABLED / ACTIVE_ROLLOUT_NOT_ELIGIBLE` | 不存在单布尔开关，必须完成 P4 资格证据 |

## P0 端到端链路

```text
zhiloop ui --no-open --json
  -> one-time fragment exchange
  -> HttpOnly session + in-memory CSRF
  -> GET overview/sessions/session detail
  -> POST capture preview
  -> explicit POST commit with revision/hash/idempotency
  -> Sidecar serialized capture transaction
  -> immutable Ledger append
  -> DISABLED knowledge stage returned honestly
```

自动化本地发行验收执行 build artifact → 两次安装 → UI bootstrap → Overview → 会话列表 → 会话详情 → preview → commit → 重复采集 → 卸载，并逐字节确认 Codex transcript 和 CCM config 未变化。

## Gate 结果

| Gate | 结果 |
|---|---|
| Catalog fixture coverage | 250/250，100%，高于 99% |
| Overview P95 | 最大 200 能力 + 20 会话，200 次采样，门限 `<300ms` |
| 100k 事件分页 | 首屏 `<500ms`；全量无重复、无遗漏 |
| Hook P95 增量 | Console/Gateway 不在 Sidecar launcher 与 Hook import/执行路径中，结构增量为 0ms |
| 未授权请求 | 100/100 拒绝，转发到 query port 为 0 |
| Gateway 安全 | loopback-only、Host/Origin/CSRF、CSP、no CORS、限流、大小/超时、路径穿越测试通过 |
| 浏览器存储 | 无 localStorage、sessionStorage、IndexedDB；静态资源无远程 URL |
| 发行与回滚 | runtime inventory、哈希、journal rollback、重复安装、卸载和 CCM 不变性通过 |

## 已知 P0 限制

- preview 是短时进程内授权，Sidecar 重启后会安全失效；成功 commit receipt 持久化到运行态数据库，相同命令在重启后仍可精确重放，冲突参数仍会被拒绝。
- transcript 是追加文件，没有 OS 文件租约；commit 前会重新验证 identity 并再次 dry-run，变化时返回 stale/conflict。
- 会话来源只展示可安全识别的主会话；子 Agent 聚合和自动 follow 属于 P1。
- P0 的任务页是运行态只读投影；durable job、配置写入、报警/SSE、知识治理、召回和闭环按后续优先级继续实施。

## Release Review 结论

P0 页面状态均来自 Control API/Sidecar 投影，没有硬编码 READY。Hook/spool 写入会按批增量投影，查询前有 freshness barrier；认证、隐私、单写入者、跨重启幂等、stale、恢复和 Hook 隔离均有直接自动化证据。全量门禁为 56 个 Node 测试与 773 个 Vitest 测试通过，语句覆盖率 91.22%；允许发布 `0.1.5` 本地 SHADOW 控制台，但不得据此开启自动知识编译、实际注入或 ACTIVE。
