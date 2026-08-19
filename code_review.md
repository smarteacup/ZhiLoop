# ZhiLoop 累计代码审查报告

## 📊 统计概览

### 当前 CR 情况

| 指标 | 数值 |
|---|---:|
| CR 对象 | `main@0a7bf97` 工作区：Evolution Operations Console |
| CR 耗时 | 约 20 分钟 |
| 🔴 高风险 | 2 个 |
| 🟡 中风险 | 8 个 |
| 🟢 低风险 | 2 个 |
| 修复程度 | 已修复 12/12（100%） |

### 累计情况

| 指标 | 累计值 |
|---|---:|
| 总 CR 次数 | 17 次 |
| 总耗时 | 已知约 7 小时 24 分钟（首轮历史报告未记录耗时） |
| 🔴 高风险累计 | 55 个 |
| 🟡 中风险累计 | 66 个 |
| 🟢 低风险累计 | 10 个 |
| 平均修复程度 | 已修复 126/131（96.2%） |

## 改动说明

本次变更把持续知识演进的权威状态与恢复命令接入本地控制台，新增 CodeGraph 显式初始化、知识复验/修复、历史迁移、持久化告警和八区域运维摘要。所有浏览器读取仍经过 loopback Gateway 与严格 DTO，业务事实继续由 Sidecar 的 Durable Job、Verification、Freshness、Migration、Alert 和 capability Store 持有。

对外增加版本化查询及 CSRF 保护的 revision/idempotency 命令；旧协议与默认 `SHADOW + PREVIEW_ONLY` 行为不变，自动知识发布仍关闭。长任务采用 SSE 失效通知、单飞可取消重读和有界退避，不让控制台轮询进入 Codex Hook 主链路。

同时补充中文诊断、分页、持久化重放、进程边界与 HTTP malformed-input 测试，并完成全量 coverage Gate。

## Evolution Operations Console 风险矩阵

| 等级 | 代码定位 | 问题描述 | 影响范围 | 修复与证据 |
|---|---|---|---|---|
| 高 | `apps/sidecar/src/p2-codegraph-lifecycle.ts` checkpoint | 初始化进度按 `60/100` 写入，但统一 Job Store 只接受 `0..1` | 所有真实 CodeGraph 初始化任务在首次 checkpoint 后进入 `JOB_HANDLER_FAILED` | 改为 `0.6/1.0`；真实 runtime 测试覆盖 preview→commit→worker→READY→回执重放 |
| 高 | `packages/operational-alerts/src/store.ts` operator command | 命令只绑定原始 Alert revision；两标签页可依次用同一旧 revision 改写操作态 | acknowledgement/suppression 并发更新丢失，违反人工操作门禁 | Console DTO 分离 `alertRevision` 与 operator `revision`；CAS 绑定 operator revision；stale-tab 测试通过 |
| 中 | `packages/codegraph-adapter/src/process.ts` 输出截断 | stdout 与 stderr 分别使用完整上限 | 恶意/异常进程可返回声明值两倍数据，扩大内存和诊断泄漏面 | 两个流共享累计字节预算；混合输出测试证明总和不超过 5 MiB 配置 |
| 中 | `apps/sidecar/src/p2-evolution-runtime.ts` operations snapshot | 用不同 Store 的独立 revision 是否相等推测一致性，并主要读取 Job | 正常状态被误报 `MIXED_REVISION`，Repair/Freshness/Migration/CodeGraph 事实可能显示 EMPTY | 同步组合各权威 Store 的有界 revision/status；独立 revision 不再做等值比较；读取快照无任务副作用测试 |
| 中 | 同上，命令回执 | revalidate/repair/alert/CodeGraph 指纹曾包含 `requestedAt` | 网络重试仅时间变化也被当成幂等冲突 | 指纹只包含语义字段；不同时间稳定重放、语义变化冲突测试通过 |
| 中 | 同上，CodeGraph commit | receipt 查询发生在预览重新校验之后 | 已成功提交的请求在预览过期后重试会丢失原 Job 回执 | durable receipt 优先；过期后同命令返回同一 jobId |
| 中 | `packages/operational-alerts/src/store.ts` 查询 | 项目筛选曾在分页之后进行 | 指定项目页可能为空或漏项，next cursor 语义错误 | SQL 在 keyset pagination 前按 project 过滤；跨项目分页测试通过 |
| 中 | `apps/console-web/src/app/useBoundedOperation.ts` | loader 变化未进入 effect 依赖 | 切换项目/资源后可能继续轮询旧闭包 | `load` 纳入依赖并在 cleanup abort；路由切换与卸载测试通过 |
| 中 | `useInvalidationFeed.ts` | polling failure 无终止上限 | Sidecar 长期不可用时页面永久请求 | 指数退避并在连续五次失败后停止；fake timer 测试通过 |
| 中 | `apps/sidecar/src/p2-codegraph-lifecycle.ts` repository boundary | 已观察 root 未验证 POSIX 文件 owner | 当前用户可能对其他用户拥有的目录执行索引写入 | 在 realpath/目录校验后要求 `stats.uid === process.getuid()`；非 POSIX 保持兼容 |
| 低 | Alert/Migration 页面 | 首版只显示 next cursor/ordinal，无继续操作入口 | 操作者无法查看安全上限后的记录 | 增加“下一页”操作并只使用服务端游标；UI 测试验证参数透传 |
| 低 | `StatusBadge` / P2 labels | 未知未来枚举直接显示纯英文 | 不符合中文安全回退要求，且易被误认为正常原始状态 | 显示“未知状态（RAW）”，同时 `title`/诊断代码保留原值；组件测试更新 |

## Evolution Operations Console 配置检查

本轮未新增 `.properties`/`.yml` 运行配置，也未改变 `config.json` schema；CodeGraph 初始化继续使用既有 `codeIntelligence.initializeAutomatically=false` 安全默认值。新控制台能力按端口存在性降级，旧安装不会因缺少新页面配置而启动失败。

## Evolution Operations Console Gate 证据

| Gate | 结果 |
|---|---|
| Workspace dependency/import/direct-test | 通过，75 workspaces |
| ESLint、TypeScript build/test typecheck | 通过 |
| Architecture/P0～P7/隔离部署 | 60/60 通过 |
| Vitest | 201 files，1,692/1,692 通过 |
| Coverage | statements 90.01%，branches 85.00%，functions 92.20%，lines 93.87% |
| 当前未解决风险 | 0 |

## Legacy Code Knowledge Migration 审查结论

历史代码知识现在可由操作员先生成不可变 dry-run，再通过 revision/idempotency 门禁进入 durable migration job。迁移只从现存 Freshness Candidate、精确 Recipe 或显式 symbol anchor 重建代码断言；不读正文猜测，不修改 Markdown、Registry 内容、Scope、Authority 或 lifecycle。Recipe 与 Freshness 写入在各自事务内登记 migration owner；回滚仅删除仍由同一迁移拥有且没有后续活动的派生数据。审查覆盖权限、分类、并发、崩溃恢复、回滚、隐私、分页和控制面，12 个发现全部修复。

## Legacy Code Knowledge Migration 风险矩阵

| 等级 | 发现 | 风险 | 修复与证据 |
|---|---|---|---|
| 高 | 完成状态写入后、最终 checkpoint 写入前退出时，重放会把 `COMPLETED` 当 preview mismatch | 已成功迁移被永久标记失败，无法自动恢复 | 允许 exact revision 的 completed recovery，以已保存 processedCount 补写最终 checkpoint；崩溃窗口测试仅执行一次验证 |
| 高 | 完成 transition 使用新的系统时间 | 相同 effect key 重放时输入 hash 改变并触发幂等冲突 | 使用不可变 COMMITTING 时间；完成 effect 与重放输入稳定 |
| 高 | 预览后出现 Freshness 行时无法区分外部并发写与本迁移崩溃遗留 | 可能窃取他人数据的回滚所有权，或拒绝自己的安全重放 | 增加事务 owner 查询；只允许同 migration 的 `OWNED` 行重放，其他行 `TARGET_DRIFT` |
| 高 | 已回滚状态直接返回，绕过 revision 和 idempotency key | 新命令可伪装成历史成功回执 | 所有回放均经过原始 effect receipt；新 key 在终态明确冲突 |
| 高 | 回滚完成 effect 在重放时使用最新 header revision | 首次成功后再次调用同一命令产生 effect conflict | 完成 effect 永远绑定 rolling revision；精确命令跨终态稳定重放 |
| 高 | Recipe 回滚捕获所有异常并当作内容冲突 | SQLite/存储故障会被误报为人工修改并错误结束流程 | 仅 `KnowledgeVerificationConflictError` 转换为 `RECIPE_CHANGED`，其他错误向上重试/失败 |
| 中 | 回滚按正序扫描，与设计的逆序撤销不一致 | 多版本或依赖派生数据可能按错误顺序删除 | 新增受界 reverse paging，三项跨页回滚顺序测试为 3→2→1 |
| 中 | 相同 Registry 内容的新 dry-run 复用旧 migrationId | 回滚后无法创建新一轮迁移，或与旧时间载荷冲突 | migrationId 纳入 requestedAt；相同请求仍幂等，后续新预览获得新 ID |
| 中 | Recipe 与 Freshness 同时存在时未比较断言 | 不一致派生数据会被误报为 `ALREADY_CURRENT` | 比较 canonical code assertion hash，不一致明确 `RECIPE_FRESHNESS_MISMATCH` |
| 中 | 项目 Scope 匹配时未再核对断言中的 projectId | 跨项目 symbol/call/impact assertion 可能进入错误项目迁移 | 所有带 projectId 的代码断言先做集合校验；跨项目 Freshness/Recipe 均跳过 |
| 中 | 新请求类型未加入 Socket 的 P2 分流 | 合法 `knowledge.migrations.*` 在业务层之前被 `INVALID_REQUEST` 拒绝 | Transport 同时识别 extraction 与 migration 命名空间；真实 Unix Socket 测试覆盖 |
| 中 | commit 重放再次检查后来变化的 Registry revision | 已成功接收的同一幂等命令可能在重试时被拒绝 | Registry gate 只约束首次 READY→COMMITTING；已存在 effect 允许精确重放，worker 首次 effect 前仍二次门禁 |

## Legacy Code Knowledge Migration 关键维度确认

- **权限与无猜测**：只接受既有 Candidate/Recipe 或显式 symbol；aliases、keywords、summary/body 和模型均不用于发明 assertion。
- **形式知识不变**：迁移与回滚不写 Registry/Markdown；临时数据库验收对比迁移前后 KnowledgeAsset 完全相同。
- **崩溃恢复**：目标写入/审计写入、完成状态/checkpoint 两个窗口均有重放测试；stable verification request 和 owner receipt 防止重复派生数据。
- **回滚安全**：Recipe hash、Freshness active version/state revision/event 均需仍匹配；后续活动保留原数据并返回 `ROLLBACK_CONFLICT`。
- **控制与隐私**：控制 API 只返回 ID、hash、计数、enum、revision 和受界 reason；不包含知识正文、prompt、环境或 CodeGraph/Codex 原始输出。
- **能力真实性**：`LEGACY_KNOWLEDGE_MIGRATION` 只有生产 handler 注册后才报告 READY；终态失败持久化 `MIGRATION_FAILED`。

## Legacy Code Knowledge Migration Gate 证据

| Gate | 结果 |
|---|---|
| Workspace dependency/import/direct-test | 通过，75 workspaces |
| ESLint、TypeScript build/test typecheck | 通过 |
| Architecture/P0～P7 Gate | 60/60 通过 |
| Vitest unit/integration | 191 files，1,647/1,647 通过 |
| Coverage | statements 90.00%，branches 85.24%，functions 92.24%，lines 93.78% |
| OpenSpec strict validation | `migrate-legacy-code-knowledge` 有效 |
| 持久化回放 | target-write/checkpoint crash、terminal checkpoint crash、restart、rollback conflict 与 alert 均通过 |
| Diff hygiene | `git diff --check` 通过 |

## Semantic Evolution and Alerts 审查结论

确定性规则无法裁决时，Knowledge Evolution 现在可选择调用一次只读 Codex 语义适配器；模型只能看到受界摘要并从精确目标集合选择关系，任何异常都保持 `PENDING`。永久任务失败、CodeGraph 不可用和知识过期已经接入本地持久化告警，未配置外部 provider 时如实显示 `LOCAL_ONLY`。审查覆盖权限、隐私、超时、并发、SQLite、配置真实性和 producer 重放，2 个发现均已修复。

## Semantic Evolution and Alerts 风险矩阵

| 等级 | 发现 | 风险 | 修复与证据 |
|---|---|---|---|
| 高 | provider 异步投递期间，新 occurrence 可以先推进同一告警 revision | 投递回执按旧 revision 更新会冲突，或者覆盖刚聚合的 occurrence，造成计数丢失/错误投递状态 | 回执阶段重新读取最新 record 并只合并 delivery 字段；并发 pending provider 测试证明 occurrenceCount 保持 2 |
| 中 | dedupKey 初版只按哈希定位，未约束 type/project/entity 的语义身份 | 两个不同故障错误复用 key 时会被合并为一条告警，运维判断失真 | 已存在记录与新事件的 type/project/entity 不一致即拒绝；身份冲突测试通过 |

## Semantic Evolution and Alerts 关键维度确认

- **决策边界**：确定性引擎优先；语义调用每个未决候选最多一次；action、target、confidence 和 reason 在领域层二次校验。
- **权限边界**：模型输出不包含 scope 或 authority 字段，不能扩大范围，也不能将 Candidate 提升为发布状态。
- **隐私边界**：只投影 title/summary/assertion/source ID；告警只保存标识、原因码、计数和投递元数据。
- **存储与回放**：告警库使用 0600、WAL/FULL、STRICT、canonical hash、event receipt、revision CAS 和有界 cursor；重启后聚合结果不变。
- **配置真实性**：新安装语义裁决默认关闭；关闭时不组合 Adapter；不可用时报告 DEGRADED；没有 provider 时报告 LOCAL_ONLY。
- **失败隔离**：语义错误保持 PENDING；告警失败不改变主知识任务结果；Codex 主对话不被阻塞。

## Semantic Evolution and Alerts Gate 证据

| Gate | 结果 |
|---|---|
| Workspace dependency/import/direct-test | 通过，74 workspaces |
| ESLint、TypeScript build/test typecheck | 通过 |
| Architecture/P0～P7 Gate | 60/60 通过 |
| Vitest unit/integration | 187 files，1,612/1,612 通过 |
| Coverage | statements 90.00%，branches 85.10%，functions 92.10%，lines 93.77% |
| OpenSpec strict validation | `wire-semantic-evolution-and-alerts` 有效 |
| 持久化回放 | 单次语义调用；重复告警冷却聚合为一条，重启后计数保持 |
| Diff hygiene | `git diff --check` 通过 |

## Knowledge Repair Drafts 审查结论

Freshness 冲突现在会携带精确 Verification run 身份进入 durable repair job，并生成一个不修改旧知识的 `PENDING` 草稿。草稿存储以 exact asset/version/content hash 和 conflict run 为幂等身份，后续 Candidate 必须重新以 `PROPOSED` 进入正常门禁；`PROMOTED` 也只代表已有下游 intake receipt。审查覆盖身份、CAS、SQLite、隐私、旧版本、调度顺序、崩溃恢复、资源生命周期和覆盖率，6 个发现均已修复。

## Knowledge Repair Drafts 风险矩阵

| 等级 | 发现 | 风险 | 修复与证据 |
|---|---|---|---|
| 高 | 初版 effect replay 要求历史结果等于草稿当前状态 | 草稿从 READY 继续到 PROMOTED 后，重放早期 attach effect 会被误报损坏，破坏幂等语义 | receipt 只验证自身 hash、命令身份和历史结果结构，不与后来状态比较；跨后续状态重放测试通过 |
| 高 | Sidecar 新增草稿库后，构造/stop 异常仍可能提前退出清理 | 数据库锁泄漏、半启动实例或后续重启失败 | source→draft→jobs→intake 每级构造失败逆序关闭；close 即使 stop 失败也排空 worker 并逐项关闭全部资源 |
| 中 | effect 输入哈希未绑定 expected revision 与 updatedAt | 同 key、同 payload 但不同命令时序会被静默当作重放，掩盖调用方冲突 | effect hash 纳入 operation、draftId、expectedRevision、updatedAt 和语义 payload；差异重放返回冲突 |
| 中 | 通用文本校验禁止换行 | 正常 Markdown 知识正文会被草稿库误拒，真实冲突无法沉淀 | ID/原因码继续禁控制字符，summary/body 改为允许换行但限制 NUL 与长度；多行正文回归测试 |
| 中 | source Candidate 最初只检查 ID/status | 损坏的 assertion ownership、时间、episode 或 Evidence hint 可进入长期修复输入 | 补 Candidate 结构、范围、assertion candidateId、时间和提示字段检查；损坏输入矩阵 fail closed |
| 中 | 新 workspace 最初未纳入全仓 coverage include | 全量测试看似通过，但草稿核心异常分支不受 90%/85% 门禁保护 | 将 `knowledge-repair-drafts` 加入 coverage，补损坏 payload/effect、分页、CAS、checkpoint、取消和 transient failure 测试 |

## Knowledge Repair Drafts 关键维度确认

- **身份链**：Verification service 的稳定 runId 按 asset 一一映射，经 Freshness worker 校验后进入 repair job；handler 再核对 project、Candidate、knowledge version、code/graph revision 和 refuted assertion。
- **调度与恢复**：Freshness effect 先提交，repair job 入队后才提交 page checkpoint；两处之间退出会重放同一 run 和同一 job key，最终只有一个草稿。
- **权限边界**：自动流程不生成缺少 live fact 的替代正文；新 Candidate 只能是 `PROPOSED`，不能复用旧 Candidate ID，`inheritedAuthorization` 固定为 false。
- **存储边界**：SQLite 使用 0600、WAL/FULL、STRICT、canonical payload hash、unique conflict identity、revision CAS 和 effect receipt；查询、正文、断言和页大小均有界。
- **隐私边界**：任务投影继续只展示类型、实体、进度和原因；草稿正文只通过独立的受界 read API 获取，不进入后台任务列表。
- **兼容边界**：Registry、Markdown、Freshness 原记录和 lifecycle 均不改写；历史 revalidation Gate 报告标注了后续 capability 升级。

## Knowledge Repair Drafts Gate 证据

| Gate | 结果 |
|---|---|
| Workspace dependency/import/direct-test | 通过，72 workspaces |
| ESLint、TypeScript build/test typecheck | 通过 |
| Architecture/P0～P7 Gate | 60/60 通过 |
| Vitest unit/integration | 185 files，1,593/1,593 通过 |
| Coverage | statements 90.02%，branches 85.13%，functions 92.06%，lines 93.80% |
| OpenSpec strict validation | `generate-knowledge-repair-drafts` 有效 |
| 持久化回放 | draft insert 后/检查点前退出，第二 worker 恢复为同一草稿，旧 content hash 不变 |
| Diff hygiene | `git diff --check` 通过 |

## Durable Knowledge Revalidation 审查结论

知识编译与代码保鲜现在由同一套有类型、可租约恢复的任务运行时编排；Git 变化在基线确认前保持不可变，受影响知识集合冻结后分页复验，最后一步才 CAS 推进基线。注入与 MCP 使用严格的代码/图 revision 门禁，无法证明当前一致性的代码事实只被排除并触发补偿，不阻塞 Codex。审查覆盖租约围栏、幂等、分页、定时器、取消、SQLite、隐私、延迟、配置回滚、删除影响与失败语义；9 个发现已全部修复。

## Durable Knowledge Revalidation 风险矩阵

| 等级 | 发现 | 风险 | 修复与证据 |
|---|---|---|---|
| 高 | 初版只冻结“路径直接受影响”的 Recipe | Exact revision 门禁下，未直接命中路径但仍有效的代码知识会永久保留旧 revision 并持续被排除 | 生产默认冻结项目内全部当前代码 Recipe；稳定选择哈希绑定 `all-current-recipes-v1`，分页重启测试保持集合不漂移 |
| 高 | 新 Git 观察库最初使用新文件名 | 升级会绕过旧 `git-freshness-baseline.sqlite`，等价于静默重置已确认基线并制造重复变化 | 原路径原位迁移 revision/observation 表；旧表迁移与重启回归通过 |
| 高 | Sidecar 重启后没有恢复已观察 project/root 到 verifier | 已恢复任务会找不到项目根或把生产复验降级为未知，导致队列反复失败 | 从持久化 Git source 恢复 registry，并同步恢复 verifier root；关闭/重开后继续任务测试 |
| 中 | Revalidation use case 直接依赖 Git adapter DTO | 领域用例被具体采集实现绑死，后续 watcher/远端 source 无法替换 | 改为最小 `DurableKnowledgeChangePort`，依赖方向由架构测试固定 |
| 中 | 配置热更新先停旧 intake 再构造新 intake | 新配置或数据库构造失败会让当前有效消费者也被停掉 | candidate 先构造和验证，成功后再 stop/swap；失败保留旧实例，返回幂等 rollback |
| 中 | 只要项目存在 graph revision 就要求所有代码知识匹配 graph | 纯文件/配置知识被无关 CodeGraph 状态误杀 | 仅 graph-backed Freshness 记录要求 graph revision；文件事实只绑定 code revision |
| 中 | 补偿最初只能返回合成 wake 标识 | 已有不可变 observation 时，调用方拿不到真实 durable job，追踪链断裂 | `enqueuePending(projectId)` 优先返回真实 jobId；尚无 observation 时才返回稳定 wake identity |
| 中 | 动态能力快照把 `DEGRADED` 映射成 `DISABLED` | 控制台会把故障误报为人为关闭，运维决策错误 | 保留 READY/DEGRADED/DISABLED 原状态，并补中文任务/原因标签 |
| 中 | 组合失败清理先关闭 evolution job 再关闭自动编译 producer | producer 尾任务可能向已关闭 job store 入队，掩盖原始启动错误 | 清理顺序改为先关闭 producer，再关闭 evolution consumer/store；正常关闭顺序保持一致 |

## Durable Knowledge Revalidation 关键维度确认

- **租约与幂等**：generic job store 的 attempt/worker/fencing token 围栏保持不变；compile/revalidate 输入 canonical hash 和稳定 effect key 防止重复 Candidate、Verification、Freshness 事件和基线推进。
- **Git 与分页**：rename 保留新旧路径，dirty/untracked/commit/checkout 和缺失旧对象均有界处理；超过 10,000 路径分库存储，不截断；affected snapshot 使用精确资产版本游标。
- **失败语义**：Recipe 缺失成功投影为 `UNKNOWN`；revision 漂移、输出基数错误和存储损坏失败关闭；基线只在所有页与 effect 完成后推进。
- **Hook 延迟与安全**：门禁最多 200ms、限制候选与同步复验数量，不从 Hook 启动 Git scan、命令、测试或 CodeGraph 初始化；错误只排除代码事实，Codex 继续运行。
- **隐私与控制面**：任务投影只包含类型、状态、次数、revision、实体引用和原因码，不含 prompt、知识正文、Git 输出或 CodeGraph 事实；前端枚举保持中文。
- **兼容与生命周期**：旧 Freshness 行按可选 revision 字段兼容读取；旧 Git baseline 原位迁移；producer → intake/worker → stores 的关闭顺序经过真实 Sidecar SIGTERM/重启验证。

## Durable Knowledge Revalidation Gate 证据

| Gate | 结果 |
|---|---|
| Workspace dependency/import/direct-test | 通过，71 workspaces |
| ESLint、TypeScript build/test typecheck | 通过 |
| Architecture/P0～P7 Gate | 60/60 通过 |
| Vitest unit/integration | 183 files，1,580/1,580 通过 |
| Coverage | statements 90.00%，branches 85.02%，functions 92.02%，lines 93.81% |
| OpenSpec strict validation | `durabilize-knowledge-revalidation` 有效 |
| 真实回放 | 69 MB Codex transcript、Git/CodeGraph stale→sync、Sidecar SIGTERM→restart 均通过 |
| Diff hygiene | `git diff --check` 通过 |

## Production Evidence Hub 审查结论

Candidate 初次验证与 Freshness 复验现已共用同一个生产验证服务，上一轮的“合成 Evidence”和“Freshness 仅支持 Symbol”两个高风险缺口完成销项。本轮检查覆盖正确性、删除/兼容影响、并发、SQLite、性能、隐私、配置和故障语义；新增发现 5 个问题并全部修复。自动发布仍保持显式 Commit 门禁，CodeGraph 不可用或版本漂移时不发布。

## Production Evidence Hub 风险矩阵

| 等级 | 发现 | 风险 | 修复与证据 |
|---|---|---|---|
| 高 | Snapshot 将泛化工具状态 `completed` 解释为命令/测试成功 | 工具结束但测试失败时可能生成错误支持证据并越过发布门禁 | 仅接受退出码 0、`success=true` 或明确 `ok/passed/success/succeeded`；`completed` 回归为 `UNKNOWN` |
| 中 | Freshness 对受影响知识逐项串行复验 | 大批次延迟按知识数线性增长，容易超过调度周期 | 改为最多 4 路有界并发；失败后停止领取新项；并发峰值和失败降级测试 |
| 中 | 启动与配置热更新各自复制验证服务构造逻辑 | 两条路径的 Cross-project/CodeGraph/超时配置可能漂移 | 合并到单一 `createVerification`，热更新 validate-then-swap 并可回滚 |
| 中 | Git HEAD 与 porcelain 状态串行采集 | 全仓并发压力下更容易跨越超时或扩大版本变化窗口 | 使用 argv-only `Promise.all` 并行采集；前后版本围栏仍保持整批拒绝 |
| 中 | 新增生产验证包最初未进入全仓 coverage include | 全仓覆盖率可绿但遗漏核心安全解析和持久化分支 | 将两个新包和 P2 生产组装纳入覆盖统计，补路径/解析/降级/损坏/生命周期测试并达到全局门槛 |

## Production Evidence Hub 关键维度确认

- **正确性与失败语义**：每个选中 Assertion 恰好一个结果；必需证据未知/错误、代码或图版本漂移时整批失败关闭。Freshness 服务故障只让后台进入 `DEGRADED` 并保留 ChangeSet，不改正文。
- **兼容与删除影响**：删除 `evidenceFor` 合成实现后，Worker Port 统一改为版本化请求对象；所有旧调用、Fixture、Schema、策略与无效输入测试已迁移，P0～P7 未回归。
- **并发与性能**：Freshness Scheduler 保持项目单飞，内部最多 4 路复验；CodeGraph traversal 同时受深度、visited、process、结果、输出和 deadline 限制。
- **SQLite 与恢复**：独立 `knowledge-verification.sqlite` 使用 0600、WAL/FULL、STRICT、canonical hash、幂等冲突和损坏拒绝；Recipe 先写、Freshness 投影失败后重放仍幂等。
- **隐私**：Run Summary 不保存 Candidate 正文、文件内容、命令文本或输出；Evidence sourceRef 只含相对路径、摘要、版本和事件身份。
- **配置与生命周期**：验证超时由 CodeGraph query timeout 有界推导；更新先构造新实例、后切换引用，失败回滚；Sidecar 先停止消费者再关闭 Store。

## Production Evidence Hub Gate 证据

| Gate | 结果 |
|---|---|
| Workspace dependency/import/direct-test | 通过，68 workspaces |
| ESLint、TypeScript build/test typecheck | 通过 |
| Architecture/P0～P7 Gate | 57/57 通过 |
| Vitest unit/integration | 176 files，1505/1505 通过 |
| Coverage（含新包和生产组装） | statements 90.00%，branches 85.05%，functions 91.89%，lines 93.76% |
| OpenSpec strict validation | `compose-production-evidence-hub` 有效 |
| Diff hygiene | `git diff --check` 通过 |

## 0.4.0 生产闭环完成度复核结论

本轮不是重新否定 M1～M10 的模块级实现，而是从 Sidecar 生产组合、真实 consumer、持久化恢复和端到端验收角度复核“是否已经全部接通”。领域包和专项测试仍然成立，但发现 7 个需要后续实现的生产缺口；原设计中“均已接通”的表述已修正，并新增 `docs/design/continuous-knowledge-evolution-production-closure.md` 作为可实施方案。自动发布保持 `NOT_CONFIGURED` 是正确安全边界，不计为缺陷。

## 本轮风险矩阵

| 等级 | 发现 | 生产风险 | 当前处理 |
|---|---|---|---|
| 高 | `p2-production.ts` 对非用户断言统一生成 `UNKNOWN/VERIFICATION_SOURCE_UNAVAILABLE` | Candidate 初次生产验证没有消费已实现的 CodeGraph/本地 Probe，代码类知识不能获得真实 Evidence | 未实现；纳入 Production Evidence Hub |
| 高 | `p2-freshness-runtime.ts` 只组合 `SYMBOL_EXISTS` Probe | 文件、配置、依赖、命令、测试、调用链和影响断言无法保鲜 | 未实现；初次验证与复验统一到 Evidence Hub |
| 高 | Freshness 使用独立进程内 Scheduler，不使用 Durable Job | Sidecar 崩溃时缺少租约恢复、尝试记录和稳定幂等审计 | 未实现；纳入 Evolution Durable Job Runtime |
| 高 | `CONFLICT/MARK_STALE` 只形成计划或 Freshness 状态，没有 Repair Draft consumer | 过期知识虽能退出注入，却不能自动进入可审查修复闭环 | 未实现；增加幂等 Repair Draft Job |
| 中 | `semanticJudgeEnabled` 与 `evolutionAlerts` 已进入配置，但没有生产 consumer | 控制台可能把“字段已保存”误解为“能力已生效” | 未实现；配置必须对账 READY/DEGRADED/NOT_CONFIGURED |
| 中 | 没有旧代码知识的 Recipe/Freshness 迁移操作 | 升级前知识长期缺失投影，无法证明当前一致性 | 未实现；增加 dry-run/commit/checkpoint/rollback |
| 中 | CodeGraph 初始化、主动复验、修复和迁移没有完整控制台操作闭环 | 操作员只能看部分结果，无法完成诊断和恢复 | 未实现；纳入操作面和浏览器 Gate |
| 中 | 原设计状态写成 M1～M10 “均已接通” | 文档声明高于真实生产组合，后续可能错误启动灰度发布 | 已修复：改为分层完成度并链接生产闭环方案 |

## 本轮审查边界

- 已直接核对 M1～M10 OpenSpec、上位设计、Sidecar 生产组合、Evidence/Freshness 类型、Job Runtime 使用点、控制台字段与配置 consumer。
- 没有把“安全自动发布 consumer 故意未组合”当作缺陷；Golden Gate 通过前继续关闭。
- 本轮只产出方案和修正文档状态，未提前实现业务代码；7 个未解决项必须在各自 Change 完成后逐条销项。

## M9 审查结论

M9 将会话 Candidate、用户承诺、Evolution、知识 Freshness、代码锚点、状态事件和会话缓存刷新组成可解释控制面。读取不改变知识或状态；唯一新增命令只清除 L1 目录缓存，并经过现有本地认证/CSRF 边界。8 个问题全部修复，无未解决风险。

## M9 风险矩阵

| 等级 | 发现 | 风险 | 修复与证据 |
|---|---|---|---|
| 高 | 知识列表和详情只采用治理资格，未采用 Freshness | 已知冲突或缺失投影的代码知识仍在页面显示为“可召回” | 列表/详情共同校验版本、contentHash、project 和 FRESH 状态；缺失/冲突回归视图 |
| 高 | Candidate 页面只展示摘要和数量 | 用户无法审查将写入的正文、承诺证据和演进目标 | 严格 DTO 暴露 checkpoint 正文、断言、承诺、歧义、Evolution 与双向来源链 |
| 高 | `context.refresh` 的幂等键最初未固定回执 | 重试会重复执行并返回不同删除数量，跨会话复用也不报冲突 | 有界回执表固定同键结果，跨会话同键返回 CONFLICT；Sidecar 重放测试 |
| 中 | Candidate/用户原话直接进入有上限 DTO | 合法超长内容会令整个会话详情 Zod 校验失败 | Sidecar 只在 Console 投影中确定性截断，原 checkpoint 不变 |
| 中 | 刷新接口过大请求被通用 catch 映射为 502 | 客户端会误判服务端故障并无意义重试 | 16KiB 硬上限，超限返回 413；Gateway 测试 |
| 中 | 刷新若通过普通 Prompt 触发会污染会话 | 控制动作被沉淀为用户知识并改变模型任务 | 独立 POST 控制命令，只清除 session cache，不写 Codex/Ledger |
| 中 | Freshness 状态存在 SQLite 但没有版本历史视图 | 无法解释知识何时、因何代码 revision 变旧 | 详情展示当前 state、code/graph revision、Anchor 和最多 100 条不可变事件 |
| 低 | 新增 DECIDED/Freshness 状态沿用英文 Badge | 操作员理解成本高且与中文控制台不一致 | 补充中文标签，同时以 title/诊断码保留原枚举 |

## M9 关键维度确认

- **真实性**：页面只组合 Registry、Worker checkpoint、Freshness Store 和 Runtime Audit 的服务端事实，不在浏览器推测任务状态。
- **召回一致性**：IMPLEMENTATION/带 symbol 知识只有匹配当前版本、内容、项目且 FRESH 时显示可召回；非代码知识标记为无需代码保鲜。
- **隐私与边界**：完整内容只经已认证正文接口返回；日志和刷新回执不保存正文，刷新不会创建对话事件。
- **并发与恢复**：知识治理继续使用 expected-version；刷新按 idempotency key 稳定重放，跨会话冲突失败关闭。

## M9 Gate 证据

| Gate | 结果 |
|---|---|
| Workspace dependency/import/direct-test | 通过，65 workspaces |
| ESLint、TypeScript build/test typecheck | 通过 |
| Architecture/Gate tests | 56/56 通过 |
| Vitest unit/integration | 163 files，1397/1397 通过 |
| Coverage | statements 90.16%，branches 85.08%，functions 91.81%，lines 93.69% |
| OpenSpec strict validation | `expose-knowledge-observability` 有效 |
| Diff hygiene | `git diff --check` 通过 |

## M8 审查结论

M8 将 ChangeSet、Anchor 反查、批量 Evidence 复验、Invalidation Plan 和版本化 Freshness 状态连成可重放闭环。状态与知识正文分离，每次真实变化都有不可变事件；冲突只生成修复建议，不越过治理发布门禁。9 个问题全部修复，无未解决风险。

## M8 风险矩阵

| 等级 | 发现 | 风险 | 修复与证据 |
|---|---|---|---|
| 高 | Fingerprint 哈希依赖 JavaScript 对象键顺序 | canonical JSON 落库重排键后，同一 Fingerprint 回读即被误判损坏 | Fingerprint 条目在哈希前按固定字段顺序重建；SQLite 回读复验端到端测试 |
| 高 | 只有不可变 publication projection，没有可变当前 Freshness | 代码变化后 Gate 永远看到发布时 FRESH，无法形成运行闭环 | 新增版本化 CAS state 与不可变 transition event；`get` 合并当前状态但不改原载荷 |
| 高 | 缺失 verifier 结果会进入 `MARK_STALE` 分支并被解释为 CONFLICT | 服务漏返回被误当作代码已反驳，错误触发修复 | 每个请求 assertion 必须恰好返回一次；缺失/重复在写入前整体拒绝 |
| 高 | 跨项目、错误 assertion kind 或不一致观察时间最初只会变成“不支持” | 无效 Evidence 可被误分类为真实冲突 | 批结果校验 project、revision、kind、observedAt 和 Evidence project/time；故障矩阵 |
| 中 | 既有 projection 升级后没有 state row | Worker 无法处理历史知识，Gate 继续使用旧默认 | Schema 初始化用完整性载荷确定性回填 revision 0；重开数据库迁移测试 |
| 中 | 状态更新若不绑定资产版本和 expected revision | 并发复验可覆盖新版或后写覆盖先写 | `(assetId,version)` 主键、事务内 CAS；同观察幂等优先于 stale expected revision |
| 中 | 批验证后取消仍可能继续写状态 | Hook/后台取消失效，产生超出调用生命周期的副作用 | 调用前、批验证后和逐项写入前检查 AbortSignal；取消测试 |
| 中 | SQLite 状态 JSON 和数值字段只靠 TypeScript 类型 | 损坏状态可污染 Gate 或抛出不明确异常 | 读取时验证枚举、版本、revision、时间、revision 文本和数组；事件 previous status 单独验证 |
| 低 | Worker 初始分支覆盖率为 63.63% | 校验矩阵和取消/空集合边界缺少回归保护 | 增加四类 Anchor、8 类坏批次、上下限、空工作、早晚取消；Worker branches 89.61% |

## M8 关键维度确认

- **批一致性**：一次 run 只调用一次 verifier；所有结果绑定同一 project/code/graph revision，校验完成后才开始写。
- **幂等恢复**：相同状态、revision identity、原因和 assertion 集合不增加 state revision/event；部分写入重跑安全。
- **历史边界**：publication projection 与知识正文不变；状态事件按资产版本保留，发布新版本会初始化独立 state。
- **错误语义**：UNKNOWN 必须由显式 UNKNOWN/ERROR Evidence 产生；缺失或损坏输出属于批失败，不能伪装为 CONFLICT。
- **治理边界**：`MARK_STALE` 只是 preserveBody 计划，不直接写 Markdown/Registry 生命周期。

## M8 Gate 证据

| Gate | 结果 |
|---|---|
| Workspace dependency/import/direct-test | 通过，65 workspaces |
| ESLint、TypeScript build/test typecheck | 通过 |
| Architecture/Gate tests | 56/56 通过 |
| Vitest unit/integration | 163 files，1396/1396 通过 |
| Coverage | statements 90.17%，branches 85.18%，functions 91.88%，lines 93.70% |
| Freshness package | statements 90.65%，branches 88.17%，functions 95.23%，lines 94.04% |
| Worker coverage | statements 96.05%，branches 89.61%，functions/lines 100% |
| OpenSpec strict validation | `run-freshness-revalidation` 有效 |
| Diff hygiene | `git diff --check` 通过 |

## M7 审查结论

M7 新增稳定 L1 会话目录缓存，并在 P4 最终候选进入 Context Envelope 前执行版本化 Freshness 门禁。缓存失败只退化为实时召回；无法证明新鲜的代码知识被排除但不阻塞 Codex。10 个问题全部修复，无未解决风险。

## M7 风险矩阵

| 等级 | 发现 | 风险 | 修复与证据 |
|---|---|---|---|
| 高 | 首版 Scope hash 包含 turn/task identity | 同一会话每个 Turn 都生成新键，预热完全无法命中 | Scope identity 收敛为稳定项目边界；跨 Turn 只保留一个条目的集成测试 |
| 高 | Registry revision 在扫描前读取但扫描后不复核 | 并发发布可把新旧混合目录写到旧 revision 键下 | 扫描前后 revision 恒等检查；漂移时放弃缓存并实时召回 |
| 高 | 同步 Registry 全量扫描没有独立预算和完整性上限 | 预热优化可吃满 500ms Hook deadline，反向阻塞主链 | 独立 50ms 预算、逐页时钟检查、10,000 条硬上限；超限 fail-open |
| 高 | Freshness 许可最初只按 asset ID 回传 | 同 ID 的旧/新版本同时出现时可互相借用许可 | 许可键改为 `assetId@version`，同时核对 contentHash/project；跨版本测试 |
| 中 | 过期条目用相同依赖键重建时被视为冲突 | TTL 到期后会永久 miss 并持续报错 | 事务内只允许替换已过期条目；活跃同键异载荷仍失败关闭 |
| 中 | 多进程并发填充同一键时输家直接失败 | 并发首个 Prompt 产生不必要降级 | 冲突后重读胜者；存在即返回 HIT，不存在或其他错误继续抛出 |
| 中 | 超预算的首个高权威条目会 `break` 整个选择 | 后续可容纳的短规则/目录项全部丢失 | 超预算单项改为跳过，只有 item 上限才停止；边界测试 |
| 中 | Loader 重复返回同一资产会重复占预算 | 目录容量和 Token 估算失真 | 在排序前按 `id@version` 确定性去重 |
| 中 | SQLite `put` 信任 TypeScript 对象且损坏 JSON 可触发非领域异常 | 内部错误调用或数据库损坏难以诊断 | 写前和读后共用严格结构/隐私字段校验及内容哈希；损坏测试 |
| 低 | 权威 Scope 新增 worktree/branch 后旧精确对象断言失败 | 合同测试噪声掩盖真实回归 | 更新契约期望并保留 forged boundary 测试 |

## M7 关键维度确认

- **隐私**：缓存只有 ID、版本、Scope、标题、摘要、权威和 `ckl.get` 动作；正文、Symbol、Evidence、Episode 和 CodeGraph 输出不落库。
- **身份**：键覆盖 session/project/worktree/branch/Registry revision/两类 Policy hash/Scope hash，代码 revision 明确不进入稳定目录键。
- **延迟**：预热是 50ms 内的 best effort；任何超时、扫描上限、revision 漂移或存储故障均回到实时 Retrieval。
- **注入**：只对 Eligibility 后的最终候选检查 Freshness；非代码历史知识不受影响，代码类 UNKNOWN/CONFLICT/REVALIDATE 不进入 Envelope。
- **生命周期**：Sidecar 独占 `context-prewarm.sqlite`，支持显式 session refresh，关闭时释放连接。

## M7 Gate 证据

| Gate | 结果 |
|---|---|
| Workspace dependency/import/direct-test | 通过，65 workspaces |
| ESLint、TypeScript build/test typecheck | 通过 |
| Architecture/Gate tests | 56/56 通过 |
| Vitest unit/integration | 162 files，1390/1390 通过 |
| Coverage | statements 90.14%，branches 85.11%，functions 91.81%，lines 93.69% |
| 新包覆盖率 | prewarm branches 96.22%，store branches 94.73% |
| OpenSpec strict validation | `prewarm-and-gate-context` 有效 |
| Diff hygiene | `git diff --check` 通过 |

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
