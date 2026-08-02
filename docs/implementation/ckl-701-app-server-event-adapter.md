# CKL-701：App Server Event Adapter

## 1. 结论

CKL-701 已完成。`@zhiloop/ingestion-codex` 新增有状态但有界的 `CodexAppServerEventAdapter`，将 Codex App Server v2 的 thread、turn、item 和 diff 通知转换为既有 `EventEnvelope`，与 Hook/Transcript 共用 Ledger、Normalizer 和后续知识编译链。

实现只适配传入的 JSON 通知，不启动 `codex app-server`、不建立 stdio/WebSocket 连接，也不修改用户 Codex/CCM 配置。

协议依据是 [Codex App Server 官方文档](https://learn.chatgpt.com/docs/app-server) 与本机 Codex CLI 0.144.4 执行 `codex app-server generate-ts` 生成的 v2 类型。生成物只用于核对，没有复制进运行时代码。

## 2. 映射规则

| App Server 通知/Item | 标准事件 | 决策 |
|---|---|---|
| `thread/started` | `session.started` | 使用 `thread.id` 作为会话边界，保留 cwd、CLI 版本、provider 和 source |
| `item/completed:userMessage` | `user.prompted` | 文本合并为 prompt，同时保留规范化多模态 content |
| `item/completed:commandExecution/mcpToolCall/dynamicToolCall/...` | `tool.completed` | 统一为 toolName/toolUseId/toolInput/toolResponse |
| `item/completed:fileChange` | `file.changed` | 使用最终 status 和 changes |
| `item/completed:agentMessage` | 状态缓存 | 只缓存完成态；final_answer 优先于 commentary/未知 phase |
| `turn/diff/updated` | `file.changed` | 保存当时最新 aggregated unified diff 快照 |
| `turn/completed` | `turn.stopped` | 使用终态、错误、时长和最终 assistant message；`turn.items` 补偿断线期间漏收的 completed Item |
| `item/started`、delta、`turn/started` | 不落事件 | 不是最终事实，避免增量文本和最终结果不一致 |
| `thread/closed` | 不落事件 | 该通知只表示无订阅者后从内存卸载，不代表对话永久结束 |

会话关闭仍由已有 SessionEnd Hook、Transcript 明确信号、下一会话或 inactivity timeout 规则决定。这样恢复一个已卸载 Thread 不会出现“session.ended 之后又有事件”的假异常。

## 3. 最终态与断线恢复

官方协议明确 `item/completed` 是 Item 权威状态；Adapter 不从 `item/started` 或 delta 生成知识事实。若连接在 Item 完成后断开，`turn/completed.items` 可重建遗漏的 user/tool/file 事件和最后 assistant message。

同一来源事件 ID 只依赖 source、threadId、turnId、最终 Item ID、event type 和规范化内容，不依赖观察时间：

```text
eventId = sha256(codex-app-server, threadId, turnId, eventType, sourceItemId, contentHash)
```

单连接内使用有界集合过滤重复通知；重新连接后的新 Adapter 可以再次产生相同事件，由 SQLite Ledger 返回 `duplicate`。两次完整 Fixture 回放最终仍为 5 条唯一事件。

## 4. 安全与性能边界

- 原始通知和单个规范化 payload 默认上限 4 MiB。
- thread metadata、最终消息和连接内去重集合默认各受 10,000 条有界状态上限约束。
- `item/completed` 中携带 `inProgress` 状态会失败关闭。
- 输入只允许普通 JSON；未知顶层字段不进入 payload 或事件身份。
- Adapter 不持久化原始通知；Ledger 入库前仍执行既有脱敏。
- 10,000 条 userMessage 完成通知本机单进程约 139.656ms，即约 71,605 events/s、13.966µs/event；瓶颈将是后续 SQLite 持久化而非规范化。

## 5. 兼容性声明

| 项目 | 当前验证值 | 策略 |
|---|---|---|
| Codex CLI | 0.144.4 | Fixture 与本机生成 TS 类型对齐 |
| App Server API | v2 stable notifications | 不依赖 experimental method |
| Item 时间 | `completedAtMs` 毫秒 | 缺失/非法失败关闭 |
| Turn 时间 | `completedAt` 秒 | 缺失时使用注入 clock |
| 未知通知 method | 显式 diagnostic | 升级时先增加 Fixture，再扩展 allowlist |
| 未知 Item type | 安全忽略 | 不把非物质 UI/推理 Item 猜成知识事实 |

## 6. 验证证据

```text
npx vitest run packages/ingestion-codex/src/app-server-adapter.test.ts --coverage ...
node --test scripts/app-server-adapter-boundary.test.mjs
npm run check
npm audit --audit-level=high --registry=https://registry.npmjs.org
```

结果：专项 17/17，Lines 98.36%、Branches 95.56%；断线重放边界 1/1；全仓 575/575 模块测试、45/45 架构/Gate 测试；34 个 Workspace 边界通过；整体 Lines 97.04%、Branches 90.21%、Functions 98.38%；0 vulnerabilities。

## 7. 后续

CKL-702 将在这一 Adapter 之上实现 `thread/list`/`thread/read` 分页回填、策略跳过、dry-run 和持久化断点。Transport 与鉴权继续作为端口，不进入事件映射领域逻辑。
