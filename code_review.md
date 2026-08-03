# ZhiLoop Code Review

## 统计概览

| 指标 | 当前 P1 | 累计 |
|---|---:|---:|
| CR 标识 | `main@e4b2d53+build-zhiloop-console-p1` | 52 次 |
| 高风险 | 10 | 240 |
| 中风险 | 9 | 327 |
| 低风险 | 0 | 2 |
| 修复程度 | 19/19（100%） | 100% |

## 改动说明

本次交付 Console P1 的持久 Job、自动会话采集、配置事务、告警、实时更新、Job 安全命令和真实 Codex acceptance。发行版本为 `0.2.0`，运行模式仍固定 `SHADOW`；P2 知识编译、P3 召回/Codex query、P4 实际注入与 ACTIVE 均没有被提前开启。

核心边界保持不变：Hook 不等待 P1 后台服务或 Console；Sidecar 是 Ledger/运行状态唯一写入者；Gateway 只监听 loopback；浏览器不持久化业务数据；Job 写命令必须通过状态、能力、revision 和幂等门禁；配置失败保持 last-known-good；acceptance 缺证据只能 `NOT_VERIFIED`。

## 风险矩阵

| 维度 | 风险 | 影响 | 修复结果 |
|---|---|---|---|
| 跨层路由 | 高 | Web 的配置草稿路径与 Gateway 单复数不一致，真实请求失败但 mock 通过 | 修正并把配置 HTTP 路径提升到共享 Control API 常量 |
| 实时性 | 高 | 默认 5 秒后台观察不满足 UI P95 `<1s` | 仅有客户端时启用 completion-based 500ms 观察；新增一秒预算测试 |
| Job 并发 | 高 | checkpoint/progress 未推进 operator revision，旧页面可能通过并发校验 | 所有可见语义状态推进 Job revision；heartbeat 单独排除 |
| Job 取消 | 高 | 运行中直接终止会跨越不可中断副作用边界 | 只登记取消请求，handler 在安全 checkpoint 确认；lease fencing 保持有效 |
| Job 重试 | 高 | terminal retry 若创建新 Job/effect key 可能重复副作用 | 沿用原 Job/effect key，仅 retryable failure 或 RETRY_WAIT 可重试，并只增加一次有界 attempt |
| Job UI | 高 | legacy snapshot 缺 revision 时回退 checkpoint/0 可能误启命令 | 只接受 `job.revision`；缺失时 fail-closed，并有直接回归 |
| Job migration | 高 | 新 command 表/revision 在并发启动时可能迁移竞争 | 独占、版本化前向迁移，旧 v1 数据升级测试通过 |
| Acceptance Hook | 高 | Hook 内同步 SQLite FULL 写会增加关键路径延迟 | Hook 只入有界内存队列，返回后 `setImmediate` 批量单事务落库 |
| Acceptance 新鲜度 | 高 | 旧 session 可被新的 `taskCreatedAt` 冒充为新任务 | 每阶段时间必须不早于创建时间；旧 session 重验保持 NOT_VERIFIED |
| Acceptance 隐私 | 高 | 原始 evidence identity/路径若入库会扩大敏感面 | 只持久化 exact session、stage、timestamp、opaque SHA-256 和结果状态 |
| 发行依赖 | 中 | P1 workspace 未进入 release inventory，安装后可能缺包 | builder 与 installer required inventory 同时冻结新增运行时包 |
| Alert 语义 | 中 | `notify=false` 若关闭评估会隐藏故障 | 健康评估始终运行，只抑制通知决定 |
| 配置事务 | 中 | component partial apply 可能与数据库 effective revision 分裂 | prepare/apply 串行，失败逆序 rollback；提交失败同样回滚组件 |
| 配置未来字段 | 中 | 未组合 consumer 的预算被激活会制造虚假能力 | draft 可保存，consumer 非 READY 时 activation 被拒绝 |
| SSE 资源 | 中 | 慢客户端、断线和 replay 过期可能造成内存增长或状态缺口 | 条数/字节/连接/pending buffer 上限；Last-Event-ID 与 resync/poll fallback |
| 自动采集循环 | 中 | 0ms interval、重叠 scan/poll 或无限 retry 形成 call storm | 配置下限、完成后调度、single-flight、有界页/批次/attempt |
| 源旋转恢复 | 中 | transcript 替换/截断后沿用旧 cursor 会跳过或重复事件 | 持久 recovery attempt key、显式 cursor rebase、Ledger 幂等去重 |
| Acceptance 持久化 | 中 | 每阶段单独 FULL 事务和 prune 会阻塞事件循环 | `recordMany` 单事务、单 prune，10k session 硬上限 |
| 资源清理 | 中 | Sidecar composition 中途失败可能泄漏 SQLite handle | create/close 全路径逆序清理并保留原始错误 |

## 配置与边界检查

| 边界 | 结论 |
|---|---|
| rollout | 仍为 `SHADOW`；没有单 boolean ACTIVE 开关 |
| Hook deadline | P1 runtime 无 Hook callback；scan in-flight P95 增量 `<5ms` 回归通过 |
| SQLite | Job/配置/acceptance 使用 WAL、有界 busy timeout、0600；Ledger 单写入者不变 |
| Browser | 无 localStorage、sessionStorage、IndexedDB；SSE 只使用 HttpOnly 会话 cookie |
| Gateway | loopback、Host/Origin/CSRF、限流、消息大小和响应大小门禁维持 |
| Secret/正文 | 不进入 Job 投影、配置 audit、alert、acceptance 或 Gateway diagnostics |
| CCM | 源码和测试未修改 `~/.ccm`；部署前基线 hash 为 `fdfcd36b64b35783ce2a8895d86dff5ac91a50798a3ebc836ac7a56ffb84178b` |

## Gate 证据

| 检查项 | 结果 |
|---|---|
| Node Gate | 56/56 通过 |
| Vitest | 104 files / 947 tests 通过 |
| Coverage | statements 90.85%、branches 85.59%、functions 92.60%、lines 94.28% |
| Build / lint / typecheck / dependencies | 50 workspaces，全部通过 |
| P1 性能 | Hook P95 delta `<5ms`；状态到 UI `<1s`；无重叠 scan/poll |
| 安全/恢复 | Job fencing/restart/idempotency、配置 LKG、SSE bound、acceptance fail-closed 全部通过 |

## Review 结论

当前源码阶段的 19 个发现均已闭环，没有遗留高风险 finding。P1 代码满足提交和本地发行构建条件；Release Review 仍以真实 `0.2.0` journal、doctor、CCM hash 不变以及新建 Codex 会话五阶段 acceptance 为最终门禁。在这些真实证据完成前，不勾选 5.7/6.11，也不进入 P2 自动编译启用。
