# ZhiLoop 累计代码审查报告

## 审查统计

| 指标 | 本轮（M6 知识保鲜） | 累计 |
|---|---:|---:|
| Review 次数 | 1 | 7 |
| 风险发现 | 8 | 50 |
| 高风险 | 4 | 25 |
| 中风险 | 3 | 20 |
| 低风险 | 1 | 5 |
| 已修复 | 8 | 50 |
| 未解决 | 0 | 0 |
| 本轮耗时 | 16 分 00 秒 | 已知耗时 1 小时 27 分 03 秒（首轮历史报告未记录耗时） |

## M6 审查结论

M6 把发布知识投影为可反查的代码 Anchor，并以独立 Freshness 状态驱动重验证计划。SQLite 保留不可变版本历史，只让当前指针进入变更反查；Worker 在 Registry 与索引之间增加可恢复 checkpoint。8 个问题全部修复，无未解决风险。

## M6 风险矩阵

| 等级 | 发现 | 风险 | 修复与证据 |
|---|---|---|---|
| 高 | 初版只以 `asset_id` 保存一条当前投影 | 新版本覆盖旧 Candidate、Fingerprint 和 Anchor，破坏可追溯性 | 改为 `(asset_id, asset_version)` 不可变历史表、当前指针表和版本化 Anchor；历史读取测试 |
| 高 | 版本读取发生在 `BEGIN IMMEDIATE` 之前 | 两个进程可同时通过版本检查，后写覆盖先写 | 版本/CAS 检查、投影、Anchor 和当前指针更新进入同一写事务 |
| 高 | 投影未核对 Asset 与 Candidate 的身份字段 | 错误 outbox 组合会把别的 Candidate 锚定到正式知识 | 校验 subject、kind、correlation 和 source Episodes；不一致失败关闭 |
| 高 | 只有变更、尚未复验时沿用 invalidation 的 `MARK_STALE` | 相关改动会被误当成已证实冲突，提前污染生命周期 | 无复验结果只进入 `REVALIDATE`；明确 REFUTED 才输出 `CONFLICT + MARK_STALE` |
| 中 | 变更路径和 key 直接进入反查 | 非规范路径造成漏召回、跨项目歧义或异常查询负载 | 拒绝绝对路径、反斜线、空段、`.`/`..`、换行和超长 key；项目维度索引 |
| 中 | 从 SQLite 读出的嵌套 Candidate 只浅冻结 | 调用方可修改内存记录，后续计划与审计读取不一致 | 完整性校验后递归冻结整个投影 |
| 中 | 旧 checkpoint 缺少新增 stage 时直接读取 `.attempts` | 升级后续跑可能抛 TypeError | publication-started 判定使用缺失安全访问；旧记录兼容回归 |
| 低 | 仅有通用失败矩阵，没有验证保鲜阶段恢复不重复前序副作用 | checkpoint 顺序回归难以及时发现 | 增加 Markdown/Registry 成功、Freshness 失败后精确续跑的集成测试 |

## M6 关键维度确认

- **状态分层**：Freshness 与历史 `KnowledgeStatus` 独立；计划保留正文，只通过 expected version 提议刷新 Fingerprint 或标记 STALE。
- **数据模型**：每个正式版本保存 Candidate、Fingerprint、Anchor 和完整性哈希；当前指针决定注入前需要复验的活动版本。
- **召回边界**：按 project + PATH/SYMBOL/CONFIG/DEPENDENCY 索引，调用方提供 1–10,000 的硬上限；无关变更返回空集。
- **恢复边界**：`FRESHNESS_PROJECT` 位于 Registry 后、增量索引前；成功的 Markdown/Registry 不重放，投影自身同版本同载荷幂等。
- **生产边界**：Sidecar 独占并关闭本地 `knowledge-freshness.sqlite`；目录/文件权限分别为 `0700/0600`。

## M6 Gate 证据

| Gate | 结果 |
|---|---|
| Workspace dependency/import/direct-test | 通过，64 workspaces |
| ESLint、TypeScript build/test typecheck | 通过 |
| Architecture/Gate tests | 56/56 通过 |
| Vitest unit/integration | 159 files，1375/1375 通过 |
| Coverage | statements 90.10%，branches 85.03%，functions 91.70%，lines 93.66% |
| OpenSpec strict validation | `track-knowledge-freshness` 有效 |
| Diff hygiene | `git diff --check` 通过 |

## M5 审查结论

M5 将 CodeGraph 定位为实时代码事实提供者，而非 ZhiLoop 知识库的替代或权威正文。新增的 `code-intelligence` 只暴露规范化路径、行号和符号事实；`codegraph-adapter` 使用非 shell argv 调用、版本/健康协商和指纹缓存。6 个问题全部修复，并通过本机 CodeGraph 0.9.4 真实只读烟测。

## M5 风险矩阵

| 等级 | 发现 | 风险 | 修复与证据 |
|---|---|---|---|
| 高 | CodeGraph 原始 query 包含内部 node ID、score 和 backend 字段 | Vendor 实现细节进入 Evidence/Knowledge，后续无法替换适配器 | 严格投影为 symbol/kind/path/line/language/exported；测试明确断言 node ID 不存在 |
| 高 | 未初始化与健康索引的空结果可被混同 | 未配置 CodeGraph 时可将真实符号误判为不存在 | 先协商 READY/NOT_CONFIGURED/INCOMPATIBLE/UNAVAILABLE；非 READY 探针恒为 UNKNOWN，不调 query |
| 高 | 版本调用超时时初始逻辑仍根据 stdout 标记 INCOMPATIBLE | 运行故障被误分类为永久配置问题，无法正确重试 | 进程失败/超时/输出超限先级高于版本解析；回归测试 |
| 中 | CodeGraph fuzzy query 可返回同类名和子成员 | 单看“有返回”会产生虚假 SYMBOL_EXISTS Evidence | Probe 再比较精确 symbol 和可选 path；健康空命中才是 REFUTED |
| 中 | 不绑定代码指纹的查询缓存会返回旧事实 | 代码改动后知识仍被旧结果支持 | LRU key 包含 root + projectFingerprint + operation + query + limit；指纹改变重查测试 |
| 低 | 子进程 stdout/stderr 最初可无界增长 | 损坏或恶意适配器输出导致内存压力 | 1 MB 硬上限，超限 SIGKILL；所有操作 10 ms–10 s 超时边界；不记录原始 stderr |

## M5 关键维度确认

- **进程边界**：`spawn(executable, argv, shell:false)`，最小 PATH 环境，不使用用户内容构造 shell 字符串。
- **写入边界**：Adapter 只允许 version/status/query/callers/impact，没有 init/index/sync 代码路径。
- **能力边界**：当前实际包为自包含 CLI，无可导入 SDK；因此首版使用可测 ProcessPort，保留了后续 SDK Adapter 替换点。
- **Evidence 边界**：非 READY 只能 UNKNOWN；精确命中才 SUPPORTED；健康空结果才 REFUTED。
- **交付边界**：本模块提供真实 Probe 和适配器；默认后台仍不擅自初始化项目，配置与控制台激活属于 M7/M8。

## M5 Gate 证据

| Gate | 结果 |
|---|---|
| Workspace dependency/import/direct-test | 通过，63 workspaces |
| ESLint、TypeScript build/test typecheck | 通过 |
| Architecture/Gate tests | 56/56 通过 |
| Vitest unit/integration | 157 files，1368/1368 通过 |
| Coverage | statements 90.12%，branches 85.05%，functions 91.74%，lines 93.67% |
| Real CodeGraph smoke | 0.9.4 READY，KnowledgeWorkerRuntime 规范化查询通过 |
| OpenSpec strict validation | `connect-codegraph-fact-layer` 有效 |
| Diff hygiene | `git diff --check` 通过 |

## M4 审查结论

M4 新增了独立 `knowledge-evolution` 领域包，将 Candidate 与当前知识的关系编译为 `STORE/SUPPLEMENT/SUPERSEDE/CONTRADICT/SCOPE_SPLIT/SKIP` 或显式 `PENDING`。决策在 Evidence Policy 之前持久化，但只能限制发布，不能提升状态或放大 Scope。7 个审查问题全部修复，无未解决风险。

## M4 风险矩阵

| 等级 | 发现 | 风险 | 修复与证据 |
|---|---|---|---|
| 高 | Evidence Policy 原来只在状态迁移时发布 | 同状态的真实内容修订永久无法生效；若 Worker 直接绕过又会继承旧授权 | 新增 `contentRevisionRequested`，只有本轮用户接受或必需 Evidence 全部支持才允许无状态迁移的新版本；正反测试 |
| 高 | 不同 Scope 最初一律判为 `SCOPE_SPLIT` | 项目知识可被自动放大为 TEAM/GLOBAL | 只允许同级隔离 Scope 或可证明更窄的层级；放大结果改为 `PENDING` |
| 高 | 已 `VERIFIED` 目标的补充最初可直接自动发布 | 新正文可不当继承旧版本的高权威状态 | VERIFIED 的 SUPPLEMENT 和 IMPLEMENTED/VERIFIED 的 SUPERSEDE 均设置 `requiresConfirmation`，传入 Policy 冲突门禁 |
| 高 | `CONTRADICT` 的 conflict IDs 最初先于已验证的 `USER_REJECTED` 生效 | 用户已明确拒绝仍被要求再次确认，且无法记录 REJECTED 结果 | Worker 识别本轮已 SUPPORTED 的拒绝 Evidence，对该路径不重复施加冲突门禁，仍不生成 outbox |
| 中 | 把 subject、title、summary 拼成一条 FTS 查询 | Registry 的 AND token 语义使召回近似退化为全字段完全命中 | 改为最多 5 个受控查询，Adapter 去重后仍最多返回 5 条；FTS 排名不直接作为关系证据 |
| 中 | 旧 checkpoint 缺失 `EVOLUTION_MATCH` 时，`retryFailed` 路径直接读 `.status` | 升级后的显式恢复可抛 TypeError，无法执行新 stage | 改为缺失安全访问；普通旧 checkpoint 续跑测试与全量回归通过 |
| 低 | 新包初次纳入全局覆盖率后分支为 84.94% | 达不到既定质量 Gate | 补充 Scope 层级、alias/symbol、无效语义裁决和损坏输入分支；全局恢复到 85.07% |

## M4 关键维度确认

- **匹配顺序**：先读 `subjectKey + kind + scope` 精确身份，再执行最多 5 个受控 FTS 查询，最终候选不超过 5 条；精确身份永远优先。
- **未决边界**：相似但无法确定关系时持久化 `PENDING`，不伪装为 STORE/SKIP；可选语义端口最多调用一次且只能选已给定目标。
- **发布矩阵**：CONTRADICT、SKIP、PENDING 无 outbox；其他决策仍必须通过 Evidence Policy、Scope 恒等和授权门禁。
- **版本边界**：SUPPLEMENT/SUPERSEDE 只写当前 lineage 的紧邻下一版；目标版本在决策后变化则返回可重试 `EVOLUTION_TARGET_STALE`。
- **数据边界**：新版本保留 aliases、applicability、symbols、Evidence 和 source Episodes，同时增加 DERIVED_FROM/SUPERSEDES/RELATED_TO 关系。

## M4 Gate 证据

| Gate | 结果 |
|---|---|
| Workspace dependency/import/direct-test | 通过，61 workspaces |
| ESLint、TypeScript build/test typecheck | 通过 |
| Architecture/Gate tests | 56/56 通过 |
| Vitest unit/integration | 155 files，1360/1360 通过 |
| Coverage | statements 90.29%，branches 85.07%，functions 91.94%，lines 93.81% |
| OpenSpec strict validation | `decide-knowledge-evolution` 有效 |
| Diff hygiene | `git diff --check` 通过 |

## M3 审查结论

M3 将用户在对话中的明确接受、拒绝和纠正编译为可回放的结构化结果，并把提取策略身份绑定到 Worker 不可变工作身份。审查发现的 6 个问题均已修复；模型不能自行声称获得用户授权，歧义不会被猜测解决，纠正只产生关系草案而不伪造新知识正文。

## M3 风险矩阵

| 等级 | 发现 | 风险 | 修复与证据 |
|---|---|---|---|
| 高 | 模型原始 Candidate 可以直接带 `USER_ACCEPTED` / `USER_REJECTED` | 模型可以伪造用户授权，越过承诺检测门禁 | 编译前删除所有模型声称的用户证据，只由确定性 detector 重新添加；伪造接受测试 |
| 高 | 删除伪造承诺后可能留下无 assertion/evidence 的 Candidate | 无根据知识仍可继续进入策略阶段 | 新增 `CANDIDATE_GROUNDING_REMOVED` fail-closed 检查；纯伪造 Candidate 回归测试 |
| 高 | Worker 身份未包含 `policyHash` | 策略变更后可错用历史 checkpoint，结果无法证明由哪份策略生成 | 请求必须提供有界 hash，纳入 work identity 和每条 Candidate provenance；P2 Snapshot 端到端传递 |
| 中 | Candidate provenance 最初展开完整 compiler result | 每条 provenance 重复嵌入整批 candidates，checkpoint 可二次方膨胀 | 改为 8 个必要字段的精确投影；键集合恒等测试 |
| 中 | Detector 未命中生产对话中“确认使用…”的直接表达 | 真实 P2 会话在移除模型自声明后无法获得用户接受证据 | 扩展有界的直接确认模式；语句单测与真实 P2 Gate 均通过 |
| 中 | 旧 checkpoint 没有新 stage 和 provenance | 升级后未完成工作可误判完成或无法续跑 | 新 stage 缺失视为 pending，且仅对单 Episode 历史工作确定性回填 provenance；完成记录保持只读 |

## M3 关键维度确认

- **信任边界**：用户承诺只来自 Ledger Episode 中可定位的用户轮次；模型输出只能提供待验证主张。
- **歧义边界**：同一表达唯一命中才应用；多候选命中保留 ambiguity，不更改 Candidate，不自动发布。
- **纠正边界**：拒绝会附加可追溯的 `CONTRADICTS` 关系草案；正文仍需后续提取和证据验证。
- **回放边界**：承诺 signal、ambiguity、draft 都按内容排序并持久化；相同 Ledger 摘要、compiler/prompt/policy 身份必然产生相同结果。
- **兼容边界**：旧 completed checkpoint 不改写；只对能够唯一证明来源的未完成工作回填数据。

## M3 Gate 证据

| Gate | 结果 |
|---|---|
| Workspace dependency/import/direct-test | 通过，60 workspaces |
| ESLint、TypeScript build/test typecheck | 通过 |
| Architecture/Gate tests | 56/56 通过 |
| Vitest unit/integration | 154 files，全部通过 |
| Coverage | statements 90.22%，branches 85.00%，functions 91.87%，lines 93.76% |
| OpenSpec strict validation | `compile-user-commitments` 有效 |
| Diff hygiene | `git diff --check` 通过 |

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
