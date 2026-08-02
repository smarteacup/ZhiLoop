# CKL-702：历史线程回填

## 1. 结论

CKL-702 已完成。新增独立包 `@zhiloop/codex-backfill`，通过只读 `CodexHistoryPort` 分页调用 `thread/list`/`thread/read`，复用 CKL-701 Adapter 生成标准事件，并仅在显式 `dryRun:false` 时写入 Event Sink。

默认调用不需要数据库、不写 Ledger、不修改 Codex/CCM；真实 App Server transport、鉴权和进程生命周期仍由 CKL-703 包装层提供。

## 2. 模块边界

| 模块 | 责任 | 不负责 |
|---|---|---|
| `CodexHistoryPort` | list/read 分页与取消信号 | JSON 映射、Ledger、策略 |
| `CodexBackfillService` | Scope、策略、dry-run、分页、暂停/恢复编排 | transport、SQLite 细节 |
| `SqliteBackfillCheckpointStore` | Run、Page Cursor、Thread 状态与 revision fencing | App Server 调用、事件入库 |
| `BackfillEventSink` | 幂等追加标准事件 | 回填决策 |
| `ProcessedThreadPort` | 判断既有 Episode/Candidate 是否已处理 | 具体知识仓库实现 |

这使后续插件只需装配 App Server RPC Client、Ledger 和候选仓库查询，不会复制回填领域逻辑。

## 3. 默认 dry-run

`dryRun` 缺省为 `true`。dry-run 会执行只读分页和必要的 `thread/read`，返回：

- PROJECT/GLOBAL Scope；PROJECT 必须同时提供可信 `projectId` 与绝对 cwd。
- 扫描、可回填、跳过线程数。
- 每个线程的 ID、cwd、Turn 数、估计 JSON 字节和决策；不返回 preview 或正文。
- 总估计数据量、next cursor 和是否因 maxThreads 暂停。

只有明确传入 `dryRun:false` 且同时提供 Checkpoint 与 EventSink，服务才允许产生外部写入。

## 4. 跳过策略与门禁

| 决策 | 条件 |
|---|---|
| `SHORT_SESSION` | Turn 数低于 `minTurns`，默认 2 |
| `SENSITIVE_SESSION` | 命中显式 Thread ID、preview term 或 cwd prefix |
| `ALREADY_PROCESSED` | ProcessedThreadPort 或当前恢复 Run 已终态处理 |
| `ACTIVE_SESSION` | 任一 Turn 仍为 `inProgress` |
| `OUT_OF_SCOPE` | PROJECT Thread cwd 不在声明 cwd 边界内 |
| `OVERSIZED_SESSION` | 单 Thread JSON 超过默认 16 MiB，硬上限 64 MiB |
| `DUPLICATE_LISTING` | 同一扫描中跨页重复返回 Thread |

路径比较支持 POSIX、Windows drive 和 UNC；Windows 路径统一分隔符并按大小写不敏感比较。前缀匹配使用目录边界，`/project` 不会误匹配 `/project-other`。

默认敏感 preview terms 为 `password/secret/token/credential/密码/密钥`，调用方可显式替换；正文不会出现在报告中。

## 5. 中断与恢复

SQLite 维护：

- `backfill_runs`：requestHash、Scope、RUNNING/COMPLETED、opaque cursor、时间。
- `backfill_threads`：PROCESSING/COMPLETED/SKIPPED 和跳过原因。
- 同一 requestHash 同时只允许一个 RUNNING Run。

处理顺序是：Thread 标记 PROCESSING → read/adapt/append → 标记 COMPLETED → 全页完成后 CAS 推进 Cursor。进程在页中间退出时，Cursor 不推进；再次执行相同请求会恢复同一 Run，重复列出当前页，终态 Thread 直接跳过，PROCESSING Thread 重新执行。Ledger 的确定性 eventId 把已经写入的部分返回为 duplicate。

`AbortSignal` 和 `maxThreads` 都返回 `PAUSED`，而不是把 Run 错标为完成。循环 Cursor 在写入断点前被拒绝，避免断点倒退或卡死。

## 6. 历史事件重建

每个 Thread 被投影为：

1. 一次 `thread/started`。
2. 每个持久化 Item 的 `item/completed`；User Item 使用 Turn startedAt，其余 Item 使用 completedAt。
3. 每个 Turn 的 `turn/completed`。

这些通知交给 CKL-701 Adapter。`turn.items` 会再次提供补偿，但 Adapter 的连接内确定性去重确保同批不重复；跨恢复重放由 Ledger 去重。

## 7. 性能与瓶颈

纯内存 1,000 Thread dry-run 编排约 7.692ms（约 129,999 threads/s，315,890 估计字节）。该数字只衡量策略和编排，真实瓶颈预计是 `thread/read` RPC 往返、历史 JSON 大小和 SQLite 写入；因此服务使用分页、单线程上限、暂停点和逐页 Cursor，不预加载无界历史。

## 8. 验证证据

```text
npx vitest run packages/codex-backfill/src/checkpoint.test.ts packages/codex-backfill/src/service.test.ts --coverage ...
node --test scripts/codex-backfill-boundary.test.mjs
npm run check
npm audit --audit-level=high --registry=https://registry.npmjs.org
```

结果：专项 9/9，Lines 96.42%、Branches 88.07%、Functions 100%；真实 Ledger 边界 1/1；全仓 584/584 模块测试、46/46 架构/Gate 测试；35 个 Workspace 边界通过；整体 Lines 97.01%、Branches 90.10%、Functions 98.44%；0 vulnerabilities。

## 9. 后续

CKL-703 将提供 transport/sidecar/plugin 包装、安装计划、Hook 合并、健康检查和可逆卸载。安装动作仍与本仓实现分离，并只在明确授权后执行。
