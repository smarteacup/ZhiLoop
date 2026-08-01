# ZhiLoop Code Review

## 统计概览

### 当前 CR 情况

| 指标 | 数值 |
|---|---:|
| CR 标识 | CKL-204 / 用户承诺与纠正检测 |
| CR 耗时 | 540s |
| 高风险 | 4 个 |
| 中风险 | 6 个 |
| 低风险 | 0 个 |
| 修复程度 | 已修复 10/10（100%） |

### 累计情况

| 指标 | 累计值 |
|---|---:|
| 总 CR 次数 | 15 次 |
| 总耗时 | 5860s |
| 高风险累计 | 26 个 |
| 中风险累计 | 53 个 |
| 低风险累计 | 0 个 |
| 平均修复程度 | 100% |

## 改动说明

本次为 Episode 增加全部 UserPrompt 的结构化原话投影，并在 Knowledge Compiler 内新增供应商无关、纯本地的承诺检测器。检测器生成 `USER_ACCEPTED`、`USER_REJECTED`、`CORRECTION` signal；只有唯一关联的接受/拒绝会落为确定性 Assertion，Candidate 仍保持 `PROPOSED`。

没有新增模型 SDK、数据库、远程调用、凭证、运行配置或用户目录写入。检测和应用拆为两步，便于后续 Candidate Repository 原子保存原始 signal、歧义和富化后的 Candidate。

## 风险矩阵

| 增/删 | 风险 | 代码定位 | 问题描述 | 影响范围 | 修复结果 |
|---|---|---|---|---|---|
| 增 | 高 | `domain/episode.ts`、`episode-builder/builder.ts` | 旧 Episode 不保留普通 continuation/subgoal 原话，检测只能看到 eventId，无法审计“按这个做”“不要使用 X”。 | 承诺漏检、Turn 追溯断裂 | 增加 `EpisodeUserStatement`，每条 UserPrompt 保存 Turn/Event/分类/正文/时间，并冻结输出。 |
| 增 | 高 | `episode-builder/builder.ts` / builder version | Episode 输出语义改变但仍用 v1，会让相同 Ledger 的不同契约共享版本身份。 | 缓存污染、错误重放和错误幂等 | 默认版本升为 `episode-builder-v2`；边界测试固定验证版本和投影。 |
| 增 | 高 | `commitment-detector.ts` / target resolution | 泛化“按这个做”若直接覆盖多 Candidate，会把未指代方案错误标成用户接受。 | 错误知识进入 Evidence/Policy 流程 | 来源引用 > 唯一主题 > 单一方案三级解析；多方案返回 ambiguity，不生成承诺 signal。 |
| 增 | 高 | `commitment-detector.ts` / assertion materialization | 外部篡改 signal kind、时间或 Candidate ID 可构造无效/越权 Assertion。 | Candidate 契约破坏、后续状态误判 | apply 边界校验 kind、时间、目标唯一性和存在性；非法 signal fail closed。 |
| 增 | 中 | `commitment-detector.ts` / phrase detection | 在文档或测试中引用“按这个做”“不要使用 X”可能被误识别为真实承诺。 | 假阳性确认/拒绝 | 仅识别陈述开头的显式表达，并增加引用短语反例测试；普通“好的”不触发。 |
| 增 | 中 | `commitment-detector.ts` / correction | Correction signal 若只保留 correctedRef，会再次丢失被纠正结论和关联依据。 | 审计和交互确认信息不足 | signal 同时保存 original/corrected ref 与 statement、Turn、时间、目标和原因码。 |
| 增 | 中 | `commitment-detector.ts` / replay | Worker 重放同一 Episode 时可能重复追加 USER Assertion。 | Assertion 膨胀、证据重复计权 | Assertion ID 由 candidate/kind/statementRef 确定性哈希；应用前按同一语义去重。 |
| 增 | 中 | `commitment-detector.ts` / Episode isolation | 全局传入的其他 Episode Candidate 可能参与“单一方案”判断。 | 跨任务错误关联 | 只处理 `sourceEpisodes` 包含当前 episodeId 的 Candidate，并覆盖隔离测试。 |
| 增 | 中 | `commitment-detector.ts` / mutable input | OPEN Episode 后续仍会追加对话，提前检测会生成抖动 signal。 | 重复确认、时间竞态 | 拒绝 OPEN Episode；同时校验重复/缺失引用、时间和 Correction 一致性。 |
| 增 | 中 | `commitment-detector.ts` / lexical matching | 每条 statement 为每个 Candidate 重复规范化和分词，100×100 已达到约 50ms。 | 大 Episode 后台编译吞吐下降 | 每次检测预计算 Candidate profile；相同基准降至中位 1.83ms、P95 2.03ms。 |

## 删除与兼容性检查

- 没有删除既有 Episode 字段、Knowledge kind、Compiler port 或 Runner 行为。
- `Episode.userStatements` 是新增必填字段，仓库内所有生产构造方和 Fixture 已同步；默认 Builder version 主动升为 v2，避免伪装向后兼容。
- CKL-202 模型最小输入未加入全部 userStatements，因此 compiler inputHash 语义保持其既有范围；承诺检测明确读取完整终态 Episode。
- `applyUserCommitments` 返回新对象且不修改输入；无 signal 时也保持 Candidate 语义和状态。

## 配置检查

本次没有新增环境变量、功能开关、模型配置、pre/prod/inner 配置或数据库 Migration，不存在配置遗漏。

## Gate 证据

| 检查项 | 结果 | 结论 |
|---|---|---|
| CKL-204 专项 | 14/14 | 通过 |
| Episode/承诺相关专项 | 28/28 | 通过 |
| 架构/Gate | 21/21 | 通过 |
| 全仓模块 | 259/259，23 Test Files | 通过 |
| 覆盖率 | Detector Lines 95.58%、Branches 88.33%；整体 Lines 96%+、Branches 89%+ | 通过 |
| 性能 | 100 Candidate × 100 Statement：中位 1.83ms、P95 2.03ms | 通过 |
| 供应链 | npm 官方 registry 0 vulnerabilities | 通过 |

## 性能与瓶颈复盘

- Candidate profile 在单次检测内只规范化/分词一次；Statement 仍需与 Candidate profile 做 O(S×C) 比较。MVP 每 Episode 为小批 Candidate，当前 10,000 对比较 P95 2.03ms。
- `applyUserCommitments` 为保证输入不变和深冻结会克隆 Candidate；这属于后台路径，且当前批量远小于模型生成延迟。
- 若未来跨 Episode 联合数千 Candidate 检测，应增加 subject/topic 倒排索引，不能直接扩大当前线性扫描范围。

## 已知边界

- 显式规则不处理隐含同意、反讽和复杂指代；宁可不产生 signal，也不自动确认多个目标。
- `FOLLOWED_BY_IMPLEMENTATION` 只证明后续发生 Action，不证明代码实现与设计完全一致；代码事实由后续 Verifier 判断。
- Correction 无可定位目标时仍保留 signal 并标记 unresolved；交互式消歧尚未实现。
- CodeGraph 尚未初始化；影响范围通过全量 TypeScript、依赖边界、端到端架构测试和全仓测试验证。

## Review 结论

CKL-204 未发现未修复风险，四项验收条件全部满足。可以进入 CKL-205 Candidate Repository。
