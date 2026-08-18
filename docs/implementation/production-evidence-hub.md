# 生产证据验证中枢实施说明

**对应 OpenSpec**：`compose-production-evidence-hub`  
**状态**：Implemented，等待本变更最终 Gate 归档

## 1. 目标与边界

本模块把 Candidate、Freshness 和后续 Pre-injection 的证据验证统一到 `KnowledgeVerificationService`。它只观察代码仓库、不可变会话快照和已存储的验证记录，不执行候选知识提供的命令，不自动初始化 CodeGraph，也不修改业务仓库。

核心安全语义：

- Candidate 发布失败关闭：必需证据缺失、未知、冲突或验证期间版本漂移时，不得提升到可发布状态。
- 后台保鲜失败开放：验证服务暂时不可用不会阻塞 Codex；调度器进入 `DEGRADED`、保留待处理 ChangeSet，并且不改写原知识正文或新鲜度结论。
- 一个批次只接受一个代码版本和一个 CodeGraph 索引版本；前后版本不一致时整批丢弃。
- 历史命令与测试只从本次不可变 Snapshot 读取。Freshness 没有原 Snapshot 时返回 `UNKNOWN`，绝不重跑命令或把缺失当作成功。

## 2. 模块划分

| 模块 | 职责 | 明确不负责 |
|---|---|---|
| `domain` / `schemas` | Assertion、Evidence 和 JSON Schema 契约 | 文件、SQLite、进程和 CodeGraph I/O |
| `code-intelligence` | 符号、调用路径、影响范围的只读端口与 Probe | CLI 参数、进程管理、仓库初始化 |
| `codegraph-adapter` | argv 调用、能力/索引版本归一化、有界查询与缓存 | 发布策略、知识状态迁移 |
| `evidence-probes` | 仓库文件/依赖/配置与 Snapshot 历史观察 | 命令执行、任意正则/结构化求值 |
| `evidence-engine` | 每种 Assertion 恰好一个结果、异常隔离和 Evidence 构造 | 适配器生命周期与持久化 |
| `knowledge-verification` | 请求校验、代码/图版本围栏、Probe 组装、Recipe/Run 持久化 | Candidate 编译、Registry 发布、调度 |
| `sidecar` | 生产组装、配置热切换、Snapshot 传递、Freshness 调度 | 伪造 Evidence 或自动修改项目 |

依赖方向由 Workspace allowlist、AST import checker 和 `production-evidence-boundary.test.mjs` 固定，领域包不能反向导入 filesystem、Ledger、SQLite 或 CodeGraph Adapter。

## 3. 验证链路

### 3.1 Candidate

1. Worker 一次加载并校验不可变 Snapshot。
2. Compiler 产出带 Assertion 的 Candidate。
3. 同一 Snapshot（含 identity/content hash 和 Ledger records）传给共享验证服务。
4. 服务捕获代码版本，按 Assertion Kind 选择只读 Probe，验证后再次捕获代码与图版本。
5. 版本稳定才写入脱敏 Run Summary；Evidence Policy 决定目标状态。
6. 默认 `PREVIEW_ONLY` 只返回预览。明确 Commit 且策略允许发布后，才写 Markdown、Registry、Freshness，并保存该知识版本的 `evidence-recipe-v1`。

### 3.2 Freshness

1. Git Change Source 以 `HEAD + porcelain digest` 形成版本化 ChangeSet。
2. Invalidation Engine 根据路径、配置、依赖和符号锚点选择受影响知识。
3. Freshness Worker 从持久化 Candidate/Assertion 配方构建复验请求。
4. 共享验证服务按最多 4 路有界并发执行，每项仍有独立超时、取消和版本围栏。
5. 全批返回同一代码/图版本后才迁移 Freshness 状态；冲突标记 `CONFLICT`，能力不足标记 `UNKNOWN`。
6. 失败时调度器保留 ChangeSet，进入降级并等待下一次重试；不会确认 Git baseline。

## 4. 支持的证据

| Assertion | 数据源 | 关键行为 |
|---|---|---|
| `SYMBOL_EXISTS` | CodeGraph | 精确符号与可选路径；索引不可用为 `UNKNOWN` |
| `CALL_PATH_EXISTS` | CodeGraph | 有界深度、访问符号数、进程调用数、结果数和总时限 |
| `IMPACT_CONTAINS` | CodeGraph | 有界影响集合；目标存在/不存在可支持或反驳 |
| `FILE_CONTAINS` | 当前仓库 | canonical path、拒绝 symlink escape/二进制/超限；EXACT 默认可用 |
| `DEPENDENCY_PRESENT` | 当前 manifest | npm、Maven、Gradle、Cargo、Go；版本不确定保持 `UNKNOWN` |
| `CONFIG_EQUALS` | 当前配置 | JSON/YAML/TOML/properties 的有界标量读取 |
| `USER_ACCEPTED/REJECTED` | 当前 Snapshot | 只匹配不可变 Ledger 事件 |
| `COMMAND_SUCCEEDED/TEST_PASSED` | 当前 Snapshot | 只观察历史退出码/测试记录，不保留原始输出 |
| `CROSS_PROJECT_VERIFIED` | 验证 Run Store | 仅计入 canonical project 不同且对应知识版本当前、`FRESH` 的证明 |

REGEX/STRUCTURAL 不会弱化成字符串匹配；只有显式注册的有界 evaluator 才可执行，否则返回 `UNKNOWN`。

## 5. 持久化与隐私

`knowledge-verification.sqlite` 使用 `0600`、WAL、`synchronous=FULL` 和 STRICT tables，保存：

- `verification_recipes`：知识 ID、版本、recipe 版本、Assertion JSON 与 canonical hash。
- `code_verification_runs`：请求/运行身份、purpose、project、知识版本引用、代码/图版本、资格标记和脱敏结果摘要。

Run Summary 不保存 Candidate 正文、文件内容、命令文本或命令输出。相同身份重放必须幂等；相同主键不同内容视为冲突；读取时重新校验 canonical hash，损坏记录拒绝使用。

## 6. 资源上限与故障语义

- 每个验证请求默认最多 100 个 Assertion，服务总时限默认 5 秒，可配置范围 10ms～60s。
- Snapshot 默认最多 10,000 条记录；P2 生产输入进一步限制为 5,000 条、50,000 sequence span。
- 仓库读取有路径深度、文件大小、文本类型和 evaluator 超时上限。
- CodeGraph 有 query timeout、输出、路径深度、visited symbols、process calls 和 result count 上限。
- Freshness 一个项目批次最多 4 路验证并发；Scheduler 仍保持单飞、批次上限与 completion-based 调度。
- CodeGraph 不存在、未初始化或索引旧：返回可解释 `UNKNOWN`，不自动执行 `codegraph init`。
- 代码/索引漂移、结果数量错误、持久化冲突：整批失败，不产生混合版本证据。

## 7. 配置与运维

`codeIntelligence.queryTimeoutMs` 控制单次 CodeGraph 调用；验证服务总超时按其 5 倍计算并限制在 1～60 秒。配置更新先构造并校验新服务，再原子替换共享运行时引用；若后续 Scheduler 配置失败则回滚验证引用。

关闭顺序保证消费者先停止，再关闭 governance、verification、freshness、checkpoint 和 registry store。验证数据库可独立检查、备份和重建运行历史，但 Recipe 是持续保鲜的输入，不应在保鲜启用时单独删除。

## 8. 验收范围

直接测试覆盖：路径穿越/符号链接逃逸、超大/二进制文件、损坏 manifest/config、evaluator 超时、Snapshot 边界、每种 Assertion、结果基数、取消/超时、代码与图漂移、SQLite 重启/重放/损坏/隐私、跨项目去重、真实 Candidate 发布、历史命令/测试 Freshness `UNKNOWN`、CodeGraph 缺失失败关闭、真实文件变化冲突、运行时降级及并发上限。

最终命令与真实回放证据记录在 `production-evidence-hub-gate-report.md`。
