# ZhiLoop Code Review

## 📊 统计概览

### 当前 CR 情况

| 指标 | 数值 |
|---|---:|
| CR 标识 | `main@1743851+capture-codex-session` |
| CR 耗时 | 210s |
| 🔴 高风险 | 0 个 |
| 🟡 中风险 | 2 个 |
| 🟢 低风险 | 0 个 |
| 修复程度 | 已修复 2/2（100%） |

### 累计情况

| 指标 | 累计值 |
|---|---:|
| 总 CR 次数 | 49 次 |
| 总耗时 | 23169s |
| 🔴 高风险累计 | 222 个 |
| 🟡 中风险累计 | 308 个 |
| 🟢 低风险累计 | 0 个 |
| 平均修复程度 | 100% |

## 改动说明

本次变更新增按 Codex session ID 主动采集历史或正在运行会话的能力。CLI 通过 owner-only Unix socket 请求 Sidecar；Sidecar 在配置的 `~/.codex/sessions` 根目录内精确读取 `session_meta`，调用已有 transcript adapter 生成确定性事件，再按 append-before-cursor 顺序写入 ledger。

对外新增 `zhiloop capture --session <id> [--dry-run] [--json]`。正式采集支持持久化锚点游标、增量恢复和重复吸收；预览不写 event 或 ingestion cursor。报告明确返回 `knowledgeCompiled: false`，避免把事件沉淀误解为生产知识已经编译。

SQLite 新增 `ingestion_cursors` 辅助表但保留 `user_version = 1`，旧 `0.1.2` 能在回滚时继续打开 ledger。部署配置新增 `codexSessionsRoot`，由当前用户 home 统一渲染；升级失败仍使用原 journal 逆序恢复配置、current、LaunchAgent 和 Hook receipt。

## 风险矩阵

| 维度 | 风险 | 代码定位 | 问题描述 | 影响范围 | 修复结果 |
|---|---|---|---|---|---|
| 增/可观测接口 | 🟡 中 | `apps/sidecar/src/transport.ts`、`apps/sidecar/src/deployment-cli.ts` | transcript adapter 已产生安全的行号和字节偏移，但初版 transport 只返回错误码，CLI 无法定位坏行；虽无正文泄漏，但不满足可诊断契约。 | 历史会话存在损坏或未来格式漂移时的排查效率。 | Sidecar response 和 `SidecarRequestError` 增加仅数字的 `lineNumber`/`byteOffset`，CLI 透传安全位置元数据；新增坏行正文不进入响应或日志的回归测试，已修复。 |
| 增/性能与并发 | 🟡 中 | `packages/codex-session-capture/src/service.ts` | 活跃 transcript 末尾没有完整换行时，adapter 会返回未前进游标与 `hasMore=true`；初版会重复读取直到总批次上限。大事件批次若一次同步 append，也可能延迟 Hook 事件循环。 | 活跃会话重复采集的空转开销，以及大 transcript 下 Hook 延迟。 | 增加无游标进展即停止并保留 `hasMore`；event append 固定最多 500 条/批并在批间 `setImmediate` 让出事件循环；增加不完整末行单批停止测试，已修复。 |

## 配置检查

| 配置 | 变更前 | 变更后 | 结论 |
|---|---|---|---|
| `codexSessionsRoot` | 无 | `<home>/.codex/sessions` | 安装器、路径类型、Sidecar parser、临时安装验收和文档已同步 |
| `rolloutMode` | `SHADOW` | `SHADOW` | 注入门禁未放宽 |
| `hookTimeoutMs` | 750ms | 750ms | Hook fail-open 时限未改变 |
| SQLite `user_version` | 1 | 1 | 新辅助表对旧 sidecar 回滚兼容 |
| release version | `0.1.2` | `0.1.3` | Sidecar metadata、package、builder 和健康验收一致 |

仓库没有 pre/prod/inner 多环境配置。`codexSessionsRoot` 只有一个安装器生成来源，测试配置与临时发行验收均使用同一 `DeploymentPaths` 字段，没有环境遗漏。

## Gate 证据

| 检查项 | 结果 |
|---|---|
| OpenSpec | `capture-codex-session` 4/4 规划产物完成 |
| Workspace/import policy | 41 workspaces 通过 |
| Lint / build / test typecheck | 全部通过 |
| 主动采集专项 | 41/41 通过 |
| 临时发行验收 | build → install → dry-run → capture → repeat → uninstall 通过 |
| 架构/Gate | 52/52 通过 |
| 模块测试 | 681/681 通过 |
| 新模块覆盖率 | Statements 87.24%、Branches 80.55%、Functions 100%、Lines 92.74% |
| 全仓覆盖率 | Statements 92.70%、Branches 87.98%、Functions 95.43%、Lines 95.68% |

## Review 结论

会话身份、路径边界、参数上限、单写入者、append-before-cursor、崩溃重放、活跃文件、日志脱敏、旧版本回滚和 SHADOW 语义均有直接实现与测试证据。发现的两个中风险问题已闭环；无遗留 actionable finding。当前主要产品边界仍是主动采集只到 ledger，生产知识编译与注入没有被本变更隐式开启。
