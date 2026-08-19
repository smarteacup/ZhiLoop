# 演进运维控制台实施报告

**交付版本**：ZhiLoop 0.4.3
**完成日期**：2026-08-19  
**OpenSpec Change**：`complete-evolution-operations-console`

## 1. 完成结论

持续知识演进的生产事实与恢复命令已经接入本地控制台。浏览器只通过 loopback Gateway 访问版本化、有界 DTO；Gateway 不读取 SQLite、Codex transcript 或仓库，Sidecar 仍是 Job、Verification、Freshness、Repair、Migration、Alert 和 CodeGraph capability 的事实所有者。

本次交付不改变 `SHADOW + PREVIEW_ONLY` 默认模式，也不打开自动知识发布。CodeGraph 初始化、迁移提交、回滚、告警确认/静默、知识复验和修复候选提交均为显式命令。

## 2. 模块能力

| 模块 | 已实施能力 | 关键边界 |
|---|---|---|
| 运维总览 | 聚合 Compile、Revalidate、Repair、CodeGraph、Freshness、Migration、Alert、Injection 八个区域 | 同步读取各权威 Store；不同 Store revision 不做错误等值比较；读取不创建任务 |
| CodeGraph | 已观察项目列表、能力/版本、preview → commit、Durable Job、失败诊断与重试 | 服务端 canonical root；拒绝 `/`、Home、非目录及 symlink escape；固定 `codegraph init -i`，无 shell，总输出 5 MiB |
| 知识演进 | Recipe、Verification Run、Freshness revision、关联 Job、Repair Draft、手动复验与修复候选提交 | knowledge/freshness revision 门禁；幂等回执；候选仍回到正常治理路径，不直接发布 |
| 历史迁移 | 项目 dry-run、计数、分页明细、显式提交、任务进度、回滚影响说明与冲突结果 | 列表不返回正文；Registry revision 与幂等门禁；后续活动冲突时保留派生数据 |
| 持久化告警 | 项目筛选、有界游标、聚合次数、中文诊断、关联跳转、确认和限时静默 | 原始 Alert 不变；operator revision 独立 CAS；两标签页旧 revision 必须失败；CRITICAL 始终可见 |
| 会话时间线 | 采集、Snapshot/提取阶段、Candidate 演进状态与注入 attempt 的只读组合 | 不把 Ledger/Candidate 等同于已发布知识；Codex transcript 保持只读 |
| 实时刷新 | SSE 只传失效信号；资源重新读取；断线轮询与指数退避 | 每页最多一个请求和 timer；卸载 abort；连续五次失败停止自动刷新 |
| 中文诊断 | 状态、原因、迁移分类、告警类型统一中文显示 | 原始英文 enum/reason code 保留在 `title` 与诊断组件中；未知值安全回退 |

## 3. 对外控制面

| 方法与路径 | 用途 | 副作用 |
|---|---|---|
| `GET /api/v1/evolution/operations` | 八区域运维摘要 | 无 |
| `GET /api/v1/codegraph/projects` | 已观察项目 CodeGraph 能力 | 无 |
| `POST /api/v1/codegraph/projects/:id/preview` | 初始化影响预览 | 仅保存不可变预览，不写仓库 |
| `POST /api/v1/codegraph/projects/:id/commit` | 创建初始化 Durable Job | 有；CSRF/revision/idempotency 门禁 |
| `GET /api/v1/knowledge/:id/evolution` | 知识演进证据 | 无 |
| `POST /api/v1/knowledge/:id/revalidate` | 复验当前知识 | 有；只创建/复用持久化任务 |
| `POST /api/v1/repair-drafts/:id/submit` | 提交修复候选 | 有；不直接发布知识 |
| `GET /api/v1/migrations*` | 迁移摘要和有界明细 | 无 |
| `POST /api/v1/migrations/preview` | 迁移 dry-run | 仅保存预览，不写知识派生数据 |
| `POST /api/v1/migrations/:id/commit|rollback` | 迁移或安全回滚 | 有；CSRF/revision/idempotency 门禁 |
| `GET /api/v1/alerts` | 告警有界查询 | 无 |
| `POST /api/v1/alerts/:id/acknowledge|suppress` | 更新独立操作状态 | 有；不修改原始 Alert |

## 4. 关键审查修复

- CodeGraph checkpoint 进度从错误的 `60/100` 修正为 Job Runtime 合法的 `0.6/1.0`，避免初始化任务统一进入 `JOB_HANDLER_FAILED`。
- 告警命令改为绑定独立 operator revision，旧标签页不能覆盖较新的确认或静默操作。
- CodeGraph stdout/stderr 共用一个输出预算，避免两个流分别占满上限。
- 命令幂等指纹只包含语义字段；客户端重试时间变化仍返回原回执，语义变化则冲突。
- 成功的 CodeGraph commit 先查 durable receipt，再检查预览时效，因此网络重试不会因预览已过期而丢失原任务。
- 运维总览读取 Repair、CodeGraph、Freshness、Migration 和 Alert 的真实持久化 revision，不再用互不相关的 revision 是否相等推测一致性。
- 告警先按项目过滤再分页；告警与迁移页面均可继续读取服务端返回的下一页。

## 5. 验证结果

| Gate | 结果 |
|---|---|
| Workspace dependency/import/direct-test | 通过，75 workspaces |
| ESLint、TypeScript build/test typecheck | 通过 |
| Architecture/P0～P7/隔离部署 Gate | 60/60 通过 |
| Vitest 单元/集成/UI/安全测试 | 201 files，1,692/1,692 通过 |
| Coverage | statements 90.02%，branches 85.01%，functions 92.20%，lines 93.87% |
| CodeGraph 真实 Job 回归 | preview、commit、初始化、status/version/query smoke、READY 发布与过期后幂等重放通过 |
| HTTP 安全边界 | Session、Origin、CSRF、严格字段、大小/分页边界和 malformed request 测试通过 |

最终本机部署仍需从已通过 Gate 的源码重新构建不可变发行包，并运行 `doctor`、health 与浏览器 smoke；部署步骤见 [本地部署与回滚](../deployment.md)。
