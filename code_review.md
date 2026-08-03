# ZhiLoop Code Review

## 📊 统计概览

### 当前 CR 情况

| 指标 | 数值 |
|---|---:|
| CR 标识 | `main@0af59d8+build-zhiloop-console-p0c` |
| CR 耗时 | 900s |
| 🔴 高风险 | 6 个 |
| 🟡 中风险 | 6 个 |
| 🟢 低风险 | 2 个 |
| 修复程度 | 已修复 14/14（100%） |

### 累计情况

| 指标 | 累计值 |
|---|---:|
| 总 CR 次数 | 51 次 |
| 总耗时 | 24549s |
| 🔴 高风险累计 | 230 个 |
| 🟡 中风险累计 | 318 个 |
| 🟢 低风险累计 | 2 个 |
| 平均修复程度 | 100% |

## 改动说明

本次变更交付 ZhiLoop Console P0c：Sidecar 组合会话目录和运行态投影，提供严格 Control API；Gateway 增加 capture preview/commit；Web 增加显式采集状态机；本地发行增加独立 Gateway、静态资源和 `zhiloop ui`。核心链路保持 Sidecar 单写入者约束，Gateway、浏览器和 CLI 都不能直接写 Ledger 或 Codex 会话。

capture commit 绑定会话、preview revision、transcript identity hash 和 idempotency key；成功 receipt 持久化并可跨 Sidecar 重启精确重放。Hook/spool 事件由后台批量增量投影，查询前执行 freshness barrier；生产知识、召回、闭环和配置写入仍以真实 `DISABLED/NOT_COMPOSED` 状态展示，没有硬编码 READY。

发行版本提升为 `0.1.5`。没有放宽 SHADOW、Hook 时限或 CCM 凭证边界；Console 进程不在 Hook 依赖或执行路径中。Sidecar、Operational Read Model、Gateway、Web、CLI 和 installer 均有直接模块测试，并纳入根级 build、lint、测试类型检查、依赖边界和真实发行验收。

## 风险矩阵

| 维度 | 风险 | 代码定位 | 问题描述 | 影响范围 | 修复结果 |
|---|---|---|---|---|---|
| 增/运行时投影 | 🔴 高 | `apps/sidecar/src/application.ts`、`control-plane.ts` | Hook 写入 Ledger 后运行态事件未增量投影，页面直到重启或手动采集都看不到事件。 | 实时会话事件与诊断可信度。 | worker drain 后调度投影，所有相关查询前执行 freshness barrier，并增加 Hook→Ledger→事件列表回归。 |
| 增/启动性能 | 🔴 高 | `control-plane.ts`、`operational-read-model/src/store.ts` | 冷启动按事件开启 SQLite 事务并同步追赶，会阻塞事件循环且随 Ledger 线性恶化。 | 大 Ledger 下 Sidecar 启动和控制面响应。 | 500 条分批读取、单批单事务、批间 `setImmediate` 让出事件循环；内存状态只在批事务成功后推进。 |
| 增/真实部署时限 | 🔴 高 | `control-plane.ts` | 启动时同步扫描完整 Codex transcript 目录，真实历史规模超过安装器 5 秒 READY 门禁并触发回滚。 | 既有重度 Codex 用户无法升级 P0c。 | 服务先 READY，Ledger 后台分批追赶；catalog 首次查询时发现并把能力从 `STARTING` 投影为 `READY/DEGRADED`。真实目录 1 秒内健康响应，状态迁移有直接回归。 |
| 增/真实首屏时限 | 🔴 高 | `session-catalog/transcript-source.ts`、`console-gateway/runtime.ts` | 服务就绪后首次目录请求仍全量读取结构化 sub-Agent transcript，超过 2 秒 Unix 查询预算，Overview/会话接口返回 503。 | P0 安装成功但真实 UI 首屏不可用。 | header 预检排除嵌套 sub-Agent、并发扫描 single-flight；真实 431 文件首次扫描约 1.8 秒，Gateway 使用 5 秒有界本地预算。 |
| 增/发行边界 | 🔴 高 | `apps/cli/src/ui-cli.ts`、`scripts/build-local-release.mjs` | CLI 初版直接依赖 Gateway 应用模块，发行物缺少独立 Gateway runtime，违反 app→app 边界且安装后无法启动。 | 所有真实 `zhiloop ui` 启动。 | CLI 仅 spawn 发行入口；Gateway 独立 composition root 随发行物打包，依赖门禁通过。 |
| 增/凭证泄漏 | 🔴 高 | `apps/console-gateway/src/runtime.ts` | 默认打开浏览器时曾把一次性 bootstrap URL 同时写到终端输出。 | 屏幕录制、终端日志与 shell history 暴露短时凭证。 | 默认模式只输出 origin；仅显式 `--no-open` 才返回 bootstrap URL，并有格式化回归。 |
| 增/跨重启幂等 | 🟡 中 | `operational-read-model/src/store.ts`、`control-plane.ts` | 成功 commit 仅在内存缓存，Sidecar 重启后无法精确重放。 | 客户端超时重试与升级恢复。 | 新增持久化 receipt 表和严格 schema/fingerprint 校验，重启回放与冲突均有集成测试。 |
| 增/历史兼容 | 🟡 中 | `control-plane.ts` | 历史 Ledger 的非 SHA-256 `contentHash` 与新 Control schema 不兼容，可能阻断启动。 | 既有用户 Ledger 升级。 | 只在元数据投影层对 legacy identity 做确定性 SHA-256 派生，不修改 Ledger。 |
| 增/诊断准确性 | 🟡 中 | `control-plane.ts` | spool 无法读取时初版按深度 0 且 healthy 返回。 | 运维误判、丢失积压告警。 | 返回 worker unhealthy/retryable failure，并落安全诊断；不可读 spool 回归通过。 |
| 增/错误语义 | 🟡 中 | `console-gateway/src/server.ts`、Web capture 状态机 | Gateway 初版把 stale/conflict 折叠为 unavailable，页面无法指导重新 preview。 | 手动采集恢复路径。 | 保留远端 `STALE_REVISION/CONFLICT` 为 409，Web 分态展示并可重试。 |
| 增/发行清单 | 🟡 中 | `local-deployment`、release fixture | UI/Gateway 新文件与必需发行清单一度漂移，可能出现测试 artifact 通过但真实缺文件。 | 安装完整性。 | 单一 `REQUIRED_LOCAL_RELEASE_FILES` 驱动校验与 fixture，验收启动真实 Sidecar+UI。 |
| 增/会话分类 | 🟡 中 | `session-catalog/transcript-source.ts` | 新版 Codex 把 sub-Agent 身份放在结构化 `source.subagent` 中，旧判定只识别顶层 parent/string source，导致子 Agent 混入主会话列表。 | 会话列表重复、扫描放大、主会话语义错误。 | 同时识别顶层 parent 与结构化 subagent/collaboration；2MiB nested-child fixture 验证只读 header 后排除。 |
| 增/协议性能 | 🟢 低 | Sidecar/Gateway socket reader | 每个数据块都 `Buffer.concat`，大消息呈二次复制。 | 接近上限的本地请求/响应。 | 逐块查找换行，仅完成 frame 时 concat 一次。 |
| 增/本地密钥权限 | 🟢 低 | `control-plane.ts` | 已存在的 cursor HMAC key 只校验类型和长度，未校验 owner/mode。 | 本机多用户环境下分页 token 完整性。 | POSIX 下要求当前 uid 且 group/world 无权限；新增过宽权限拒绝测试。 |

## 配置检查

| 配置/边界 | 变更前 | 变更后 | 结论 |
|---|---|---|---|
| Gateway bind | loopback 设计 | 独立 runtime 仍只允许 `127.0.0.1`/`::1` | 远程绑定直接失败 |
| 浏览器会话 | 一次性 bootstrap | 默认打开不打印凭证，HttpOnly/CSRF 维持 | token 不进入 query/cookie 脚本面 |
| Control 消息上限 | 1 MiB 契约 | Sidecar transport 5.5MB 外层、Control 1MiB、响应 1MiB | 各层都有硬上限 |
| rolloutMode | `SHADOW` | `SHADOW` | 未放宽注入门禁 |
| Browser persistence | 无 | 明确禁止 local/session storage 与 IndexedDB | 会话/知识不在浏览器持久化 |

仓库没有 pre/prod/inner 多环境配置。本阶段新增值均为构造参数和有界默认值，部署期仍需在 P0c launcher/release 中提供唯一配置来源。

## Gate 证据

| 检查项 | 结果 |
|---|---|
| 根级 Node Gate | 56/56，通过；含真实本地发行、两次安装、采集、UI 链路、卸载与 CCM 不变性 |
| Vitest | 87 files / 774 tests，通过 |
| Coverage | statements 91.21%、branches 86.49%、functions 92.90%、lines 94.46% |
| 性能/规模 | Catalog 250/250；Overview P95 <300ms；10 万事件首屏 <500ms 且全量无缺口 |
| 安全 | 未授权 100/100 拒绝；stale/conflict、路径、socket、secret mode、CSRF、限流与消息上限通过 |
| Build / lint / typecheck / dependency | 46 workspaces，全部通过 |

## Review 结论

P0c 的启动/首屏时限、主会话分类、投影新鲜度、批处理、身份、路径、分页、事务、响应大小、认证、CSRF、敏感信息、跨重启幂等和发行边界已有直接实现与测试证据。本轮 14 个发现均已闭环，当前无遗留 actionable finding；代码满足 P0 发布条件，实际用户目录部署仍需作为 4.9 的最终 Gate。
