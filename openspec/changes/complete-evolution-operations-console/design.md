## Context

模块 A～E 已经把 Evidence、Durable Revalidation、Repair Draft、Semantic Evolution、Alert 和 Legacy Migration 做成 Sidecar 内的持久化生产能力，也已通过控制协议暴露部分命令。现有 Console 主要覆盖 P0/P1 和早期 P2 的会话、知识、配置、召回与后台任务视图；演进状态散落在多个 DTO 中，CodeGraph 初始化仍缺少受控写路径，迁移与持久化告警没有完整操作面。

Console Gateway 只能作为 loopback 同源安全边界和协议代理，不能拥有业务状态或直接读取 SQLite。Sidecar 是 Job、Checkpoint、Verification、Freshness、Migration、Alert 和 Runtime Audit 的唯一 Read Model 所有者。Codex transcript 保持只读，Hook 必须继续失败开放。

## Goals / Non-Goals

**Goals:**

- 在现有 React 单页应用中提供运行总览、会话、知识、注入、CodeGraph、迁移和告警七个一致的操作区域。
- 通过版本化、有界、脱敏的 Sidecar 查询返回真实 Read Model，并把所有业务写入收敛为受控命令。
- 提供 CodeGraph 初始化 preview/commit Durable Job，严格限定目标项目并在完成后发布经过 smoke test 的 capability。
- 让 revision conflict、重试、永久失败和降级状态对操作者可理解、可诊断、可恢复。
- 建立组件、协议、安全、浏览器和只读副作用测试，防止轮询风暴、跨项目访问与错误成功提示。

**Non-Goals:**

- 不从 Console 启用自动知识发布或改变任何 Knowledge Policy。
- 不让 Gateway、浏览器或 CodeGraph 成为知识真相源。
- 不提供任意 shell 命令、任意 repository path 或任意数据库查询能力。
- 不在本变更中接入外部告警 provider；告警确认和静默只更新本地操作状态。
- 不重构已完成的 Evidence、Freshness、Repair、Migration 领域算法。

## Decisions

### 1. 使用一个版本化 Operations Read Model 聚合页面数据

Sidecar 新增 `evolution.operations.get` 查询，将各 store 的有界摘要组合为 `EvolutionOperationsSnapshot`，包含独立 section revision 和统一 observedAt。详情仍通过资源专用查询按需加载，列表只返回摘要和引用。

这样既避免浏览器对多个 store 状态做推测，也避免单个超大响应。备选方案是页面并发调用所有底层查询，但会产生跨 revision 撕裂、错误合并和更复杂的轮询，因此不采用。

### 2. 命令使用统一 envelope，preview 与 commit 分离

所有新命令携带 `projectId`、`expectedRevision`、`idempotencyKey` 和 correlationId；Gateway 继续验证 Session/Origin/CSRF，Sidecar 再验证项目所有权和业务 revision。preview 是无副作用查询，可在 stale 后自动刷新一次；commit/rollback/ack/suppress 不自动重放。

复用已有迁移命令和 revalidation/repair handlers，Console 不绕过它们直接写 store。统一错误 DTO 为 `reasonCode/message/retryable/attempt/maxAttempts/nextAttemptAt/suggestedAction/currentRevision`。

### 3. CodeGraph 初始化是受限 Durable Job

新增 project observation registry，从会话与配置中记录 canonical repository root。preview 只接受 registry 中的 projectId，不接受客户端提供的任意最终路径；Sidecar 对 root 做 realpath、目录、根/Home 禁止、workspace owner 与 `.codegraph` 目标逃逸校验，并返回目标、当前 capability、工具版本和风险。

commit 绑定 previewId、previewRevision、repository identity 和幂等键，创建 `CODEGRAPH_INITIALIZE` job。worker 仅执行固定 argv 的 `codegraph init -i`，不经过 shell；成功后依次执行 status、version 和受限 query smoke test。三项证据完整后 capability 才能变为 READY，失败则持久化稳定 reason code 和告警。

备选方案是在自动编译时懒初始化，但它产生不可预期的仓库写入并破坏显式授权，因此拒绝。

### 4. 页面采用路由区域加共享状态组件

在现有 App 路由中加入 CodeGraph、Migration、Alert 页面，并增强已有 overview/session/knowledge/injection 页面。共享 `StatusBadge`、`ReasonCode`、`OperationFailure`、`RevisionGuard`、`BoundedPager` 与 `JobProgress`，所有枚举通过集中映射输出中文，英文原码保留在 `title` 和诊断区域。

详情采用渐进加载：首屏摘要，展开时查询 Evidence/Recipe/Run/Anchor/Draft 或 migration items。响应超限时明确显示 bounded/truncated 和继续游标，不在 UI 静默截断。

### 5. 长任务使用单一可取消的刷新控制器

SSE revision 仅用于失效通知；页面收到通知后去抖刷新当前有界查询。SSE 不可用时，以指数退避的有界轮询降级，每页同时最多一个 timer/request；页面卸载、路由切换或任务进入终态时必须 abort 并清理 timer。连续失败达到上限后停止自动刷新并展示手动重试。

### 6. 告警确认和静默是独立操作投影

原始 Durable Alert 不修改或删除。`alert.acknowledge` 和 `alert.suppress` 写入独立 operator-state projection，绑定 alertId、revision、操作者本机会话和过期时间；列表将原始事实与操作状态组合。静默只影响提示和通知投影，不能隐藏 CRITICAL 事实或改变关联 Job/Freshness 状态。

### 7. 验收以无副作用快照和浏览器链路为核心

除常规单元/契约测试外，为每个只读页面在查询前后比较 Ledger sequence、Candidate count、Knowledge revision、Job count 和 store checksums。浏览器链路使用可控 fixture project 和 fake CodeGraph executable，覆盖初始化、复验、Evidence、冲突、Repair Draft 与迁移预览；真实本机 smoke 仅作为发布验收，不进入不稳定单测。

## Risks / Trade-offs

- [聚合快照跨多个 SQLite 文件无法单事务读取] → 每个 section 返回自身 revision/observedAt，聚合层标记 `CONSISTENT` 或 `MIXED_REVISION`，写命令始终绑定资源自身 revision。
- [CodeGraph 子进程卡死或输出过大] → 固定 argv、独立 timeout、输出字节上限、进程组终止和结构化摘要，原始输出不进入告警或页面。
- [初始化目标路径绕过] → 仅使用服务端 observation registry 的 realpath，拒绝根/Home/符号链接逃逸及 projectId 不匹配。
- [页面刷新风暴] → 单飞请求、AbortController、去抖 SSE、指数退避和终态停止，并以 timer 泄漏测试约束。
- [状态中文化掩盖诊断] → 中文只做显示层映射，稳定英文枚举始终保留在 title 和诊断详情。
- [告警静默被误解为问题解决] → UI 区分“已确认/已静默”和底层健康状态，CRITICAL 始终出现在未解决过滤器中。
- [大型迁移明细拖垮页面] → 服务端 keyset cursor、固定最大页大小、摘要与明细分离、正文不进入列表。

## Migration Plan

1. 先扩展协议类型和 Sidecar 有界 Read Model，不改变现有页面路由与命令。
2. 加入 CodeGraph observation/preview/job 与 alert operator-state store，默认 capability 为未配置，不触发初始化。
3. Gateway 注册新查询与命令白名单，保持旧客户端兼容。
4. 按 CodeGraph、迁移、告警顺序接入页面，再增强 overview/session/knowledge/injection。
5. 运行协议、安全、浏览器、只读副作用和全量回归 Gate 后更新部署版本。
6. 回滚时可回退 Console/Gateway/Sidecar 版本；新增数据库只包含派生状态，旧版本会忽略。已经开始的 CodeGraph job 可由当前 worker 完成或在租约后安全恢复，不删除 `.codegraph`。

## Open Questions

无阻塞问题。首版采用本地告警操作状态、30 秒最大轮询退避、每页 100 条明细上限和 5 MiB CodeGraph 输出硬上限；后续通过版本化配置调整。
