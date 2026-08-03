## Why

ZhiLoop 已能在本机以 SHADOW Sidecar 采集指定 Codex 会话，但用户仍需依赖 CLI、SQLite 和日志判断状态，无法直观看到会话、注入、知识提炼、召回和闭环链路，也不能安全治理知识或调整基础策略。现在需要建立一个与 Hook 关键路径隔离的本地只读优先控制台，先解决可见性和可控性，再承载后续生产知识流水线、自然语言召回与 ACTIVE 灰度。

## What Changes

- 增加只监听 loopback 的 Console Gateway 和浏览器控制台，使用当前用户 Unix socket 调用 Sidecar Control API，不直接读写业务存储。
- 增加统一 Capability、Stage、Job 状态模型，以及总览、任务、诊断和实时状态更新。
- 增加类似 Codex 的只读 Session Catalog，展示未采集和已采集会话、Turn、游标、实际/影子注入及按需展开记录。
- 增加会话级 capture 和 extraction snapshot 任务，支持预览、幂等提取、结果查看以及会话到知识的双向追溯。
- 增加知识列表、版本、证据、关系、修改、停止召回、恢复和影响预览；默认保留不可变历史。
- 增加独立召回页面，支持确定性自然语言搜索和本地 Codex read-only/ephemeral 辅助问答，并为答案提供知识版本引用。
- 增加基础配置的有效值、草稿、校验、diff、原子激活、历史和回滚，覆盖注入预算、后台调度、重试、告警、Codex 查询和隐私策略。
- 所有未接通能力必须显示 `DISABLED/NOT_CONFIGURED/NOT_VERIFIED` 和稳定原因码，禁止用空数据或无效开关表示成功。
- 保持现有 SHADOW、Hook deadline、fail-open、Sidecar 唯一写入者和 CCM 凭证/配置不受影响。

## Capabilities

### New Capabilities

- `local-console-runtime`: 本地受认证控制台、Control API、统一状态、总览、任务、诊断和实时事件。
- `codex-session-console`: 只读 Codex 会话目录、会话详情、注入追踪、主动采集和 snapshot 知识提取。
- `knowledge-governance-console`: 知识浏览、来源追溯、版本化修改、停止召回、恢复和影响预览。
- `knowledge-query-console`: 自然语言混合召回、可解释 Trace 和本地 Codex 辅助的带引用只读问答。
- `console-configuration`: 基础配置的字段级约束、作用域、草稿校验、原子激活、审计和回滚。

### Modified Capabilities

None.

## Impact

- 新增 `apps/console-web`、`apps/console-gateway`，并扩展 `apps/sidecar` 的版本化 Control API composition。
- 新增 `packages/control-api`、`packages/operational-read-model`、`packages/observability`、`packages/configuration-service` 和 Codex knowledge query adapter；复用现有 domain、capture、registry、retrieval、injection、MCP 与 model-codex-exec 端口。
- 新增会话目录、阶段、任务、注入、查询、配置 revision 和 operator audit 投影；Ledger 与知识历史继续保持不可变或可重建语义。
- 本地发行包增加静态 Web 资源、Gateway launcher 和 `zhiloop ui`；首版仅支持当前用户 macOS，不开放远程访问。
- 引入前端构建和浏览器 E2E 依赖，但 Console 故障或高负载不得增加 Hook P95 超过设计门禁。
