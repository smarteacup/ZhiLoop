# ZhiLoop Code Review

## 📊 统计概览

### 当前 CR 情况

| 指标 | 数值 |
|---|---:|
| **CR 标识** | CKL-202 / Knowledge Extraction Port |
| **CR 耗时** | 480s |
| **🔴 高风险** | 3 个 |
| **🟡 中风险** | 5 个 |
| **🟢 低风险** | 0 个 |
| **修复程度** | 已修复 8/8（100%） |

### 累计情况

| 指标 | 累计值 |
|---|---:|
| **总 CR 次数** | 13 次 |
| **总耗时** | 4960s |
| **🔴 高风险累计** | 19 个 |
| **🟡 中风险累计** | 42 个 |
| **🟢 低风险累计** | 0 个 |
| **平均修复程度** | 100% |

## 改动说明

本次新增模型无关的 Knowledge Extraction Port。Episode 先投影成最小、可追溯且不可变的模型输入；供应商适配器只返回语义草稿，Runner 对整批执行 Schema/Grounding 门禁后统一生成完整 `KnowledgeCandidate`。

对外新增 `KnowledgeExtractionPort`、版本化 request/result、AdapterError 和草稿输出 Schema。失败结果不携带部分 Candidate；模型不可用、超时和格式错误保留 episodeId/extractionKey 供 Worker 重试，具体持久化延后至 CKL-205。

Episode 增加必填 `goalRef`，补齐主目标来源。全量 TypeScript 编译确认唯一生产构造方已同步；无模型 SDK、存储、文件系统、子进程或用户配置变更。

## 风险矩阵

| 增/删 | 风险 | 代码定位 | 问题描述 | 影响范围 | 修复结果 |
|---|---|---|---|---|---|
| 增 | 🔴 高 | `packages/domain/src/episode.ts` / `goalRef` | Episode 只有 goal 文本和全量 evidenceRefs，提取器无法确定主目标来源，只能猜 eventId。 | Candidate 无法追溯用户原始目标、错误证据绑定 | 增加必填 `goalRef`，Builder 绑定 primary event；最小输入与 Grounding 强制使用该引用。 |
| 增 | 🔴 高 | `packages/knowledge-compiler/src/runner.ts` / identity | 仅使用 episodeId + compiler/prompt version 做幂等时，开放 Episode 增加 Turn 后 ID 不变，会错误复用旧编译批次。 | 新对话结论永久漏编译、知识陈旧 | 对规范化最小输入计算 inputHash 并纳入 extractionKey；输入内容变化测试覆盖。 |
| 增 | 🔴 高 | `packages/knowledge-compiler/src/runner.ts` / atomic output | 逐 Candidate 校验或接受模型自报 source/project 会产生部分成功和伪造跨项目证据。 | 错误知识落库、项目知识污染 | 整批 Draft Schema 原子校验；Evidence/User assertion 引用和 project/remote 全量 Grounding，任一点失败 candidates 固定为空。 |
| 增 | 🟡 中 | `packages/knowledge-compiler/src/input.ts` / projection | 直接传 Episode 会注入 Session/Turn、边界 eventId 和本机 repositoryRoot，增加上下文与隐私暴露。 | Token 膨胀、本地路径泄漏 | 明确最小 DTO，只保留实际语义引用；剔除本地根路径及会话元数据，并设置输入硬上限。 |
| 增 | 🟡 中 | `packages/knowledge-compiler/src/runner.ts` / mutable input | 调用方或 Adapter 在异步重试中修改 request，会使 extractionKey、Grounding 和实际模型输入不一致。 | 幂等漂移、竞态错误 | 执行前 structuredClone + deepFreeze；Adapter 每次接收同一不可变快照。 |
| 增 | 🟡 中 | `packages/knowledge-compiler/src/runner.ts` / ownership | Candidate 深冻结若复用 Adapter 输出中的嵌套数组，会意外冻结供应商对象。 | Adapter 缓存/复用异常 | Scope 和 Assertion parameters 先结构化复制；测试确认原输出仍可变。 |
| 增 | 🟡 中 | `packages/knowledge-compiler/src/runner.ts` / abort | 父任务在调用途中取消时 attempts 少记一次，且重试等待失败可能误报为用户取消。 | 重试审计、指标和故障诊断错误 | 区分调用前/调用中取消；Scheduler 独立失败使用 `RETRY_SCHEDULER_FAILED`。 |
| 增 | 🟡 中 | `packages/knowledge-compiler/src/input.ts` / dedup | 用数组 includes 收集相关证据，在大量 Action/Outcome 下退化为 O(n²)。 | 后台编译延迟和 CPU 放大 | 使用 Set 保持稳定顺序并实现 O(1) 去重；100 Candidate 性能基准通过。 |

## 删除与兼容性检查

- 未删除现有事件、Ledger、Normalizer、Episode 构建或 Candidate Schema 行为。
- `Episode.goalRef` 是新增必填字段；仓库内唯一生产构造方 `freezeEpisode` 和全部 Fixture 已同步，235 条测试与全量 typecheck 无旧构造遗漏。
- Domain 新增 Draft/Extraction 类型，不改变现有 KnowledgeCandidate/KnowledgeAsset 字段；CKL-203 可直接实现端口，不依赖具体供应商。
- Schema Registry 新增第四种 Schema name；既有三个 parser 和 Fixture 全部回归通过。

## 配置检查

本次没有新增或修改运行配置、环境开关、凭证或用户目录文件，不存在 pre/prod/inner 配置迁移项。

## Gate 证据

| 检查项 | 结果 | 结论 |
|---|---|---|
| Knowledge Compiler 专项 | 23/23 | 通过 |
| Schema/相关专项 | 57/57 | 通过 |
| 架构/集成 | 新增 3/3；全仓 19/19 | 通过 |
| 全仓模块 | 235/235，21 Test Files | 通过 |
| 覆盖率 | Compiler Lines 92.89%、Branches 89.44%；整体 Lines 96.91%、Branches 89.68% | 通过 |
| 性能 | 100 Candidate 中位 1.71ms、P95 2.11ms | 通过 |
| 供应链 | npm 官方 registry 0 vulnerabilities | 通过 |

## 性能与瓶颈复盘

- 无模型时主要成本是 structuredClone、规范化 JSON 哈希、AJV 批次校验和 Candidate 二次校验；100 Candidate P95 2.11ms，远低于模型网络延迟。
- 输出设置 100 Candidate/100 Assertion/100 Evidence hint 和文本长度硬门禁；输入规范化 JSON 上限 4,000,000 字符，避免异常对象无界放大。
- 超时后 Runner 不接受晚到结果并发起下一次尝试；供应商 Adapter 必须遵守 AbortSignal，否则旧网络请求仍可能占用供应商配额，但不会污染结果。
- CKL-205 必须对 extractionKey 建唯一约束并实现 claim/lease，Runner 本身不解决多 Worker 并发重复调用。

## 已知边界

- 当前没有具体模型 Prompt/Adapter，不验证五类 MVP 知识的提取质量。
- 固定重试间隔尚未消费供应商 Retry-After；装配时需保持总次数和单次超时硬上限。
- Grounding 只验证引用归属和项目一致性，不证明断言为真；真实性由后续 Evidence Engine 验证。
- CodeGraph 尚未初始化；结构影响通过依赖边界、全量 TypeScript 编译、Schema 契约和全仓回归验证。

## Review 结论

CKL-202 未发现未修复风险，四项验收条件全部满足。Knowledge Extraction Port 可以冻结为 CKL-203 的供应商无关执行边界。
