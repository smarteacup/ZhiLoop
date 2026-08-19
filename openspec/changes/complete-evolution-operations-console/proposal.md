## Why

ZhiLoop 已具备持久化复验、修复草稿、语义演进、告警和历史知识迁移能力，但多数能力仍只能通过底层控制命令观察和触发，操作者无法在一个安全、可解释的界面中完成生产闭环。现在需要把这些 Read Model 和受控命令接入本地控制台，并补齐 CodeGraph 显式初始化，确保状态可见、失败可诊断、写操作可审计且不会影响 Codex 主链路。

## What Changes

- 扩展运行总览与会话/知识详情，统一展示编译、复验、修复、Freshness、Evidence、演进和来源链。
- 新增 CodeGraph 管理区域，以 preview → commit 两阶段流程初始化已观察项目，初始化后执行 status/version/query smoke test 并刷新 capability revision。
- 新增迁移中心，展示历史知识迁移 dry-run、分页项目、跳过/失败原因、提交进度与安全回滚。
- 新增告警中心，展示结构化本地告警、聚合次数、关联实体、失败原因和建议动作，并支持确认与静默。
- 将所有操作命令统一绑定 CSRF、项目边界、`expectedRevision` 与 `idempotencyKey`；stale preview 可自动刷新一次，但有副作用的 commit 不自动重放。
- 为长任务提供有界轮询与卸载清理；所有失败展示中文说明、英文 reason code、retryable、attempt/maxAttempts、nextAttemptAt 和建议操作。
- 补齐七个页面/区域的正常、空、加载、降级、失败和 revision conflict 测试，以及关键浏览器链路、安全、响应上限和只读无副作用验收。

## Capabilities

### New Capabilities

- `code-intelligence-console`: CodeGraph 项目 capability、显式初始化 preview/commit、任务进度、smoke test 与安全路径约束。
- `knowledge-migration-console`: 历史代码知识迁移的 dry-run、分页明细、受控提交、进度、失败诊断和回滚操作面。
- `operational-alert-console`: 持久化告警的有界查询、中文诊断、关联跳转、确认和静默。

### Modified Capabilities

- `local-console-runtime`: 增加演进操作 Read Model、命令并发约束、有界长任务刷新和只读无副作用要求。
- `knowledge-governance-console`: 增加 Recipe、Verification Run、Anchor、Freshness、Repair Draft、复验和修复预览的可观察/可操作要求。
- `codex-session-console`: 增加会话 Snapshot、Candidate、Evidence、承诺、演进与来源链的统一展示和安全刷新。

## Impact

- 影响 `apps/console-web` 的路由、页面、中文枚举、错误模型、轮询生命周期和浏览器测试。
- 影响 `apps/console-gateway` 与 `apps/sidecar` 的查询/命令协议、CSRF 转发、revision/idempotency 校验和有界 DTO。
- 复用 `knowledge-revalidation-runtime`、`knowledge-repair-runtime`、`knowledge-legacy-migration`、`knowledge-alerts`、Evidence/Freshness Store 和 Runtime Audit，不改变其事实所有权。
- 新增 CodeGraph 初始化 Durable Job 适配器；只允许对已观察、规范化且未发生符号链接逃逸的项目目录写入 `.codegraph/`。
- 不启用自动知识发布，不允许浏览器直读 SQLite、文件系统或 Codex transcript，也不改变 Hook 的失败开放边界。
