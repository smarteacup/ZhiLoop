# ZhiLoop Console P1 实施与验收报告

**变更**：`build-zhiloop-console` P1  
**发行版本**：`0.2.1`  
**运行模式**：本地 `SHADOW`，自动会话采集默认开启；知识自动编译、实际注入与 ACTIVE 仍保持关闭

## 1. 交付范围

P1 把 P0 的只读控制台扩展为可恢复的后台运行面：

- `job-runtime` 持久化 Job、Attempt、Lease、Checkpoint、重试、取消、fencing token 和幂等副作用键；进程重启后恢复未完成工作和安全投影。
- `automatic-ingestion` 以有界 scan/follow 调度发现 Codex 主会话，使用持久 CAS checkpoint，处理 transcript 替换/截断恢复，并对暂不可观察的父子关系明确报告 `NOT_CONFIGURED`。
- `configuration-service` 提供 GLOBAL/PROJECT 继承、草稿、校验、差异、expected revision、prepare/apply、last-known-good 回滚和不含 secret 的审计；尚未 READY 的 P2/P3 消费者配置不能激活。
- `observability` 对 spool 深度/年龄、消费游标、失败 Job 和 Hook 静默进行确定性告警评估；通知关闭或静默时段只抑制通知，不隐藏健康状态。
- Gateway/Web 提供任务进度与安全操作、配置生效/草稿/历史/回滚、告警、SSE invalidation、断线续传、resync 和有界 polling fallback。
- `zhiloop acceptance` 对新建真实 Codex 会话执行 Hook → Spool → Ledger → Catalog → Cursor 的失败关闭验收；只持久化 session、阶段、时间和不透明 SHA-256 引用。

## 2. 关键不变量

1. Hook 不等待 Job、扫描、配置、告警、Console 或 acceptance SQLite；所有 P1 工作位于完成后调度的后台路径。
2. Sidecar 仍是 Ledger 和运行状态的唯一写入者；浏览器与 Gateway 只能通过严格的版本化 Control API 命令写入。
3. Job 操作必须同时满足合法状态、能力 READY、`expectedRevision` 和幂等键；运行中取消只登记请求，由 handler 在安全边界确认。
4. 手动重试只允许 `RETRY_WAIT` 或明确 retryable 的失败 Job，并沿用原 Job/effect key；不会绕过副作用幂等边界。
5. 配置激活先 prepare，再逐组件 apply；任何失败都逆序恢复组件并保持 last-known-good。未来消费者未 READY 时，相关字段只能保存草稿，不能激活。
6. SSE revision 严格单调且有条数/字节/连接/待发送缓冲上限；丢失窗口只发 `resync.required`，客户端再做全量刷新。
7. acceptance 缺失、过期、错序、错 session、重复或持久化失败都只能得到 `NOT_VERIFIED`。

## 3. 模块边界

| 模块 | 负责 | 不负责 |
|---|---|---|
| `packages/job-runtime` | 持久状态机、租约、重试、取消、operator command | 业务扫描、HTTP、UI |
| `packages/automatic-ingestion` | 会话发现/跟随/checkpoint/recovery/acceptance evidence | 知识编译与发布 |
| `packages/configuration-service` | 配置事务、继承、回滚、审计 | 直接控制进程或浏览器 |
| `packages/observability` | 纯告警评估与通知决策 | 外部通知发送 |
| `apps/sidecar` | 串行组合、唯一写入、能力真值 | Web 渲染 |
| `apps/console-gateway` | loopback 安全边界、SSE、协议转发 | 直接访问 SQLite/Codex 文件 |
| `apps/console-web` | 状态展示和受门禁交互 | 浏览器持久化、绕过 Control API |

## 4. Review 发现与修复

| 严重度 | 发现 | 修复 |
|---|---|---|
| 高 | Web 使用 `/configuration/drafts`，Gateway 实际为 `/configuration/draft`，mock 测试掩盖跨层漂移 | 修正路径，并把配置 HTTP 路径提升为共享 Control API 常量 |
| 高 | Gateway 默认 5 秒观察后台状态，不满足状态到 UI P95 小于 1 秒 | 改为仅在 SSE/poll 客户端存在时启动、完成后再调度的 500ms 观察；增加一秒预算回归 |
| 高 | Job 进度变化未推进 operator revision，旧页面仍可能提交取消/重试 | checkpoint/progress 同步推进 Job revision，Web 只使用 Job revision；缺失 revision 时失败关闭 |
| 高 | acceptance 若在 Hook 路径同步写 SQLite 会增加 Hook 延迟 | Hook 只把 content-free 元数据加入有界内存队列，返回后批量持久；失败保持 `NOT_VERIFIED` |
| 高 | Codex 对新写入的 unmanaged Hook 默认不信任，普通任务不会触发采集 | 安装器通过 Codex App Server 精确读取 Hook `currentHash` 并用用户配置 expected-version 原子登记信任；禁用、漂移或并发修改均失败关闭，升级/卸载可恢复原状态 |
| 高 | 从旧版 CLI 发起升级时仍由旧部署代码编排，新 artifact 新增的安装步骤可能不执行 | 先由旧 runtime 完整校验 artifact，再复制到不可变快照并委派 artifact 自身 `deploy-main`；防递归、tamper、验证间漂移、超时和输出上限均有直接回归 |
| 高 | 未验证的 `release.json.nodePath` 在完整性校验前执行或进入 launcher，可把 artifact provenance 变成代码执行入口 | metadata Node 字段只保留为 provenance；验证、委派和 launcher 固定使用当前受信 `process.execPath`，并校验当前 Node 支持范围 |
| 高 | 同版本 release 仅按文件 digest 复用，复制到临时目录后未再次验证，存在 metadata 不一致和校验/切换间漂移 | 复用、委派快照和 staging 全部比较 digest 与完整 metadata；原子切换前再次执行 inventory/hash 验证 |
| 中 | P1 workspace 未完整进入本地发行清单 | release builder 与 installer required inventory 同时纳入 Job、自动采集、配置、告警及其依赖 |
| 中 | 通知禁用可能被误解为没有告警 | 告警健康评估始终运行，`notify=false` 只产生明确 suppression decision |

## 5. Gate 证据

| Gate | 结果 |
|---|---|
| 架构/发行 Node Gate | 56/56 通过；含真实构建发行、安装、SHADOW capture、CCM 不变与可恢复卸载 fixture |
| Vitest | 104 files / 947 tests 通过 |
| Coverage | statements 90.85%、branches 85.59%、functions 92.60%、lines 94.28% |
| Build / lint / test typecheck / dependency | 50 workspaces，全部通过 |
| Job recovery / command | lease fencing、restart recovery、checkpoint resume、operator revision、幂等回放、安全取消/重试通过 |
| Configuration | stale revision、consumer disabled、partial apply、rollback、restart-required、secret redaction 通过 |
| Live update | SSE replay/resync/连接与字节上限通过；后台状态到 UI 一秒预算回归通过 |
| Hook isolation | 自动扫描 in-flight 时 200 次 Hook 的 P95 增量 `<5ms`，绝对 P95 `<100ms` |
| Acceptance privacy | SQLite evidence 专项 statements 92.12%、branches 96.42%；无正文/路径/secret，旧 session 复验失败关闭 |
| 真实发行安装 | journal 状态 `COMMITTED`；安装版本 `0.2.1`，模式 `SHADOW`；`zhiloop doctor` 六项检查全部 `PASS` |
| CCM 不变性 | 部署前后 `~/.ccm/config.json` SHA-256 均为 `fdfcd36b64b35783ce2a8895d86dff5ac91a50798a3ebc836ac7a56ffb84178b` |
| 新任务实机验收 | 普通只读 Codex CLI 任务 `019fc8ad-f5a8-7353-a121-7a64ba5749a6`，未使用 Hook 信任绕过参数且未手动 capture；第二个自动扫描周期后 Hook、Spool、Ledger、Catalog、Cursor 五段全部 `VERIFIED`；证据引用 `acceptance:d45b54b281e9ab9e824353431ec8f550c5d34986421ac87e3ab84e7d9958545e` |
| 升级自举安全回归 | local-deployment + Sidecar 最终 83/83；覆盖旧 runtime 委派、同版本防递归、tamper、Node provenance 不执行、timeout/output bound、metadata 一致性和切换前复验 |

实机验收先以信任绕过参数隔离验证运行链路，再完成精确 Hook 信任注册。最终验收任务没有使用绕过参数，也没有人工触发采集：首周期产生 `FOLLOW_PENDING`，debounce 后的第二周期自动写入 Cursor 并完成五段验证。CCM 配置 SHA-256 在升级前后保持一致。

## 6. 保留边界

- 自动会话采集只把 transcript 事件沉淀到 Ledger；P2 完成前不会自动生成、发布或修改知识。
- 可靠父子会话元数据源尚未组合时保持 `NOT_CONFIGURED`，不会等待全部 sub-Agent 才交付主会话。
- P2/P3 的 compiler、retrieval、Codex query 配置目前只能作为有界草稿保存，不能在能力未 READY 时生效。
- 所有知识内容、prompt、tool payload、transcript 路径、凭证和环境变量都不进入 Job 投影、告警、acceptance 或 Gateway 诊断。
