# ZhiLoop 累计代码审查报告

## 审查统计

| 指标 | 本轮（M2 执行模式） | 累计 |
|---|---:|---:|
| Review 次数 | 1 | 3 |
| 风险发现 | 8 | 23 |
| 高风险 | 4 | 11 |
| 中风险 | 3 | 10 |
| 低风险 | 1 | 2 |
| 已修复 | 8 | 23 |
| 未解决 | 0 | 0 |
| 本轮耗时 | 15 分 34 秒 | 已知耗时 29 分 53 秒（首轮历史报告未记录耗时） |

## M2 审查结论

M2 覆盖 Worker 执行模式、发布授权、Preview→Commit 续跑、旧 checkpoint 兼容和 P2 Durable Job 映射。8 个风险均已修复并补测试；当前没有未解决问题。默认调用不会发布，低权限调用不能继承或恢复发布能力，发布授权在部分写入后不可替换。

## M2 风险矩阵

| 等级 | 发现 | 风险 | 修复与证据 |
|---|---|---|---|
| 高 | 原布尔开关默认值是不暂停，新增调用不传参数即发布 | 后台编译或未来调用方可能无意写入正式知识 | 用三态 `executionMode` 替换；缺省强制 `PREVIEW_ONLY`；默认不写三类存储测试 |
| 高 | 仅有发布模式，没有稳定授权证明 | 任意内部调用只要传枚举即可越过人工门禁 | `SAFE_AUTO_PUBLICATION` 强制结构化授权；P2 Commit 绑定 durable idempotency key；缺失授权在创建 work 前失败 |
| 高 | 部分发布后允许换一个提交/策略身份继续 | 同一 outbox 的写入可能由两个不同决策共同授权，审计链断裂 | publication stage 首次 attempt 后锁定授权；不同授权返回 `PUBLICATION_AUTHORIZATION_CONFLICT` |
| 高 | 低权限调用带 `retryFailed` 时可能重置 terminal publication stage | Preview 调用虽然不立即发布，却能绕过 operator retry 边界，为后续发布恢复 attempt | 按当前 mode 过滤可恢复阶段；Preview 不能重置 Markdown/Registry/Index；terminal index 测试 |
| 中 | 为兼容旧 completed checkpoint 提前返回时跳过 immutable Ledger 摘要复核 | 已完成 work 的源漂移无法被发现，破坏原回放不变量 | completed replay 仍先执行 `inspectSnapshot`，之后无元数据写入返回；原回归恢复通过 |
| 中 | completed legacy checkpoint 缺少新字段时被惰性补写 | 纯读取回放会无故增加 revision，制造审计噪声和 CAS 冲突 | 只有未完成 work 才补写执行元数据；completed legacy replay revision 不变 |
| 中 | SQLite Store 最初只靠 TypeScript 类型信任 mode/authorization JSON | 损坏或手工写入的数据可能进入权限判断 | Store 在 serialize/parse 两侧校验枚举、授权 kind 和有界字段，同时兼容字段缺失的旧记录 |
| 低 | 新分支使全局分支覆盖率短暂降到 84.99% | 发布门禁的新边界不受既定质量阈值保护 | 增加无效授权、生命周期 generation 和低权限 retry 用例；1,336 项测试后恢复到 85% |

## M2 关键维度确认

- **调用链**：`CANDIDATE_PREVIEW → PREVIEW_ONLY → AWAITING_COMMIT`；`CANDIDATE_POLICY_COMMIT → EXPLICIT_COMMIT authorization → SAFE_AUTO_PUBLICATION`。
- **身份边界**：mode 不进入 immutable work identity，保证续跑；每次调用的 mode 是当次能力上限，checkpoint 历史高权限不会被继承。
- **重放边界**：成功阶段跳过；相同授权恢复未完成发布；不同授权 fail closed；低权限 replay 不执行也不重置发布阶段。
- **隐私边界**：checkpoint 只保存 idempotency identity/policy hash，不保存对话正文、prompt 或凭证。
- **兼容边界**：旧 schemaVersion 1 JSON 可读；无 SQLite migration；已完成记录不补写、不重复副作用。

## M2 Gate 证据

| Gate | 结果 |
|---|---|
| Workspace dependency/import/direct-test | 通过，60 workspaces |
| ESLint、TypeScript build/test typecheck | 通过 |
| Architecture/Gate tests | 56/56 通过 |
| Vitest unit/integration | 154 files，1336/1336 通过 |
| Coverage | statements 90.21%，branches 85.00%，functions 91.87%，lines 93.76% |
| OpenSpec strict validation | `formalize-knowledge-execution-modes` 有效 |
| Diff hygiene | `git diff --check` 通过 |

## M1 审查结论

本轮覆盖 M1 自动知识编译的调度决策、SQLite 检查点、P2 Preview 协调、Sidecar 生命周期与配置事务。审查按完整方法、端到端调用链和并发/数据边界进行了三层确认。7 个实际问题均在合并前修复并补充自动化证据；当前没有未解决的高风险问题，自动链路无法越过 Candidate Preview 门禁。

## M1 变更范围

- 新增独立 `knowledge-compilation-scheduler` 包：触发规则、扫描 Service、SQLite CAS Store 和非重叠 Scheduler。
- Conversation Ledger 增加按会话聚合的事件、Turn、最新序列与活动时间统计。
- 从 P2 Console 抽出手动/自动共用的 `P2CandidatePreviewCoordinator`。
- 新增自动投递 Adapter 和 Sidecar-owned Runtime，并接入启动、关闭和配置热更新。
- P2 状态增加自动编译状态与有界的最近运行报告。
- 新增 OpenSpec、实施说明和覆盖率门禁配置。

## M1 风险矩阵

| 等级 | 发现 | 风险 | 修复与证据 |
|---|---|---|---|
| 高 | 检查点最初只比较 Ledger sequence，没有绑定流水线身份 | compiler、prompt、policy 或配置变化后，同一历史范围永远不会重新生成候选，旧知识无法演进 | 增加 `lastCompiledPipelineHash`；幂等键绑定完整 pipeline identity；增加流水线变化重编译测试 |
| 高 | 单轮扫描最初只有会话上限，没有 Preview 投递上限 | 大量历史会话同时满足条件时可瞬时压满模型任务队列和 SQLite 写入 | 新增 `maxDispatchesPerRun`，默认 25；报告 `bounded`；增加边界测试 |
| 高 | 自动 Adapter 最初接收调用方给出的幂等键但未重算 | 错误或伪造调用可能绕过“同不可变范围同流水线一个任务”的身份约束 | Adapter 基于当前请求重算并恒等比较，不匹配即 fail closed；增加伪造 key 测试 |
| 中 | 用全局 Ledger sequence 差值估算会话新增事件 | 其他会话写入造成 sequence 空洞，可能提前触发当前会话 | Ledger 新增 per-session event/turn count；检查点分别保存 observed/compiled counters；交错会话测试 |
| 中 | 先读取不可用/未采集完成会话的 Ledger 统计再判断资格 | 源缺失会制造无意义错误、拖慢扫描并污染降级状态 | Catalog 层先过滤 `AVAILABLE + CAPTURED_CURRENT`，Coordinator 投递前仍二次确认 |
| 中 | 热更新组件在新 effective config hash 提交前读取旧 hash | 配置变化后创建的 Snapshot identity 与实际运行配置不一致 | Application 从候选配置预计算 future hash 后构造 Runtime；失败使用 rollback closure 恢复旧 Runtime；配置测试 |
| 低 | 新包和 Sidecar 新文件最初未纳入 coverage include | 主链可通过但新调度代码不受覆盖率门禁约束 | 更新 `vitest.config.ts`；补齐触发、冲突、恢复、边界和真实 P2 runtime 测试；全量分支覆盖率 85% |

## M1 关键维度审查

### 正确性与一致性

- Catalog 只做廉价初筛；自动 Adapter 在创建 Snapshot 前重新核对 Ledger revision、source version、pipeline hash、capture 状态和 dispatch key。
- 手动与自动链路共用 Coordinator，因此增量范围、Snapshot identity 和 Durable Job 幂等规则只有一套实现。
- 检查点 CAS 冲突会重读并重新决策，达到上限后只记录诊断，不执行最后写入覆盖。
- `CURRENT` 只在 Coordinator 确认没有可提取范围后写入；返回的 compiled sequence 必须与预期范围相符。

### 并发、性能与 SQLite

- Scheduler 单飞；慢扫描完成后才启动下一次间隔，不会定时器堆积。
- 扫描同时受 page、page count、session count 和 dispatch count 四层上限保护，Catalog cursor 循环也会 fail closed。
- Store 使用 WAL、`synchronous=FULL`、主键 CAS 和 `(status, next_eligible_at, session_id)` 索引；文件权限为 `0600`。
- `stop()` 取消下一轮但允许当前事务排空，Sidecar 关闭顺序先停调度再关 Store。

### 隐私与安全

- 调度检查点和运行报告只保存 ID、计数、时间、哈希、状态和有界诊断，不包含对话正文。
- 自动调度端口只暴露 `dispatchPreview`；P2 Worker 固定 `stopAfterCandidatePolicy: true`，不存在调用 Commit/Publication 的代码路径。
- 错误消息经有界诊断投影，不把 Ledger payload、prompt、环境变量或凭证写入状态。
- SQLite 路径由 Sidecar 数据目录确定，不接受会话内容拼接成文件路径或 SQL。

### 配置、兼容性与模块边界

- `automaticKnowledgeCompilation` 是向后兼容的可选根配置；缺省时使用安全默认值，`enabled: false` 明确停用。
- 解析器拒绝未知字段、非整数和越界值；候选 Runtime 验证成功后才替换，失败继续运行旧配置。
- 本仓库没有 pre/prod/inner 多套配置文件需要同步；统一 Sidecar schema、release 配置与运行时使用同一字段定义。
- Domain 调度包不依赖 Sidecar、UI、Transcript 文件或模型 SDK；workspace dependency/import/direct-test 检查全部通过。

## M1 Gate 证据

| Gate | 结果 |
|---|---|
| Workspace dependency/import/direct-test | 通过，60 workspaces |
| ESLint | 通过 |
| TypeScript build + test typecheck | 通过 |
| Architecture/Gate tests | 56/56 通过 |
| Vitest unit/integration | 154 files，1329/1329 通过 |
| Coverage | statements 90.21%，branches 85.00%，functions 91.84%，lines 93.76% |
| Diff hygiene | `git diff --check` 通过 |

## 已接受限制

- 当前通过 Catalog 轮询发现变更，没有增量 change feed；四层扫描上限和完成后计时保证负载可控。
- Sidecar 配置切换存在极短的 fail-closed 替换窗口，但不会使用半生效的新配置，也不会使旧配置在验证失败时丢失。
- M1 只保证 Preview 被可靠创建/复用，不等待模型执行完成，不治理候选冲突，也不自动发布；这些职责属于后续模块。

## 历史审查摘要（ZhiLoop 0.3.9）

首轮审查发现并修复 8 项风险：terminal retry 语义、Snapshot pipeline identity、Codex Query deadline、升级配置继承、release 版本一致性、启动期配置语义、P1/P2 任务路由和 LaunchAgent READY 等待。首轮为高风险 4 项、中风险 4 项、未解决 0 项；当时 1,273 项 Vitest 及真实部署/浏览器验收均通过。
