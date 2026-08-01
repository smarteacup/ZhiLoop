# ZhiLoop Code Review

## 统计概览

### 当前 CR 情况

| 指标 | 数值 |
|---|---:|
| CR 标识 | P2 Gate / Episode 与知识编译集成验收 |
| CR 耗时 | 360s |
| 高风险 | 4 个 |
| 中风险 | 5 个 |
| 低风险 | 0 个 |
| 修复程度 | 已修复 9/9（100%） |

### 累计情况

| 指标 | 累计值 |
|---|---:|
| 总 CR 次数 | 17 次 |
| 总耗时 | 6840s |
| 高风险累计 | 35 个 |
| 中风险累计 | 65 个 |
| 低风险累计 | 0 个 |
| 平均修复程度 | 100% |

## 改动说明

本次新增版本化 P2 Golden Codex Hook Fixture 和两条端到端 Gate，覆盖标准事件落账、Session/Turn、Episode v2、五类 MVP Compiler、承诺/纠错检测、Candidate Repository，以及模型失败后的持久化重试恢复。

Gate 只使用本地假模型，且假模型只读取公开的 StructuredGenerationRequest input；没有远程模型、凭证、Hook 安装、Daemon 或用户目录写入。

## 风险矩阵

| 增/删 | 风险 | 代码定位 | 问题描述 | 影响范围 | 修复结果 |
|---|---|---|---|---|---|
| 增 | 高 | `scripts/p2-gate.test.mjs` / traceability | 只断言 sourceRef 在 Episode evidence 中，可能把只有 Session 归属的 Event 误称为 Turn 可追溯。 | Candidate 无法定位原始对话轮次 | 从 Normalizer 建立 eventId→turnId，逐条验证 Turn 属于来源 Episode。 |
| 增 | 高 | `p2-gate.test.mjs` / failure recovery | 失败后复用内存 Episode 不能证明 Ledger 未丢失或可重建。 | 模型故障导致对话事实不可恢复 | 失败后重新 read Ledger、normalize、build，并与原 Episode JSON 字节比较。 |
| 增 | 高 | `commitment-detector.ts` / multi-kind batch | 五类批次含多个 proposal-like Candidate，“按这个做”无法用单候选降级规则定位。 | 错误自动确认或永远无法利用明确 grounding | 唯一 statementRef 来源可定位；多个来源仍 ambiguity；Golden 多目标显式断言不自动确认。 |
| 增 | 高 | `p2-gate.test.mjs` / fake model | 假模型若闭包读取完整 Episode/expected，可绕过真实 Compiler 最小输入边界让 Gate 假通过。 | 集成测试不能代表实际端口 | Golden model 只读取 generationRequest.input，并从其 correction/action/outcome 选择 sourceRef。 |
| 增 | 中 | `fixtures/p2` / drift | 未版本化 Fixture 或只有 JSONL 没有期望契约，后续修改会静默改变验收。 | 回归基准不可比较 | `p2/v1` 路径 + `fixtureVersion=p2-golden-v1` + expected counts/kinds/goal。 |
| 增 | 中 | `p2-gate.test.mjs` / five kinds | 仅检查 Candidate 数量 5 不能防止类型重复或漏类。 | MVP 类型能力退化 | 精确比较五类有序列表。 |
| 增 | 中 | `p2-gate.test.mjs` / retry persistence | 只重试 Runner、不保存 RETRYABLE，无法验证后台崩溃后的恢复状态。 | 重启后重复/丢失编译任务 | 第一次失败保存 Repository，第二次 claim 验证 runCount=2 后成功。 |
| 增 | 中 | `p2-gate.test.mjs` / lifecycle | 端到端成功可能让 PROPOSED Candidate 被普通查询返回。 | 未验证知识进入上下文 | Gate 同时断言 Candidate status 和 Repository 默认查询为空。 |
| 增 | 中 | `commitment-detector.test.ts` / source ambiguity | 多 Candidate 同时引用承诺 statementRef 时，新增来源优先级可能一次确认多个。 | 无明确指代时越权确认 | 增加唯一来源正例与多来源 ambiguity 反例，保持“不猜”门禁。 |

## 删除与兼容性检查

- 没有删除 P2 API、Fixture、Schema、数据库表或既有 Gate。
- Commitment Detector 只在既有目标解析前增加唯一 sourceRef 分支；多匹配继续返回 ambiguity，Candidate 仍为 PROPOSED。
- Golden Fixture 是新增 v1 目录，不修改 P1 Fixture 或 Adapter 行为。
- P2 Gate 使用公开包入口，能够发现导出、构建和 package 边界问题。

## 配置检查

本次没有新增环境变量、运行时开关、模型配置或部署路径。expected.json 仅为测试契约，不参与生产配置。

## Gate 证据

| 检查项 | 结果 | 结论 |
|---|---|---|
| P2 Golden 成功链 | 1/1，五类、持久化、Turn 追溯 | 通过 |
| P2 失败恢复链 | 1/1，RETRYABLE → 第 2 次成功 | 通过 |
| Commitment Detector 专项 | 16/16 | 通过 |
| 架构/Gate | 25/25 | 通过 |
| 全仓模块 | 276/276，24 Test Files | 通过 |
| 覆盖率 | Lines 96.69%、Branches 89.91%、Functions 97.61% | 通过 |
| 供应链 | npm 官方 registry 0 vulnerabilities | 通过 |

## 性能与瓶颈复盘

- 最新本地单次 Golden 成功链约 23.45ms，失败恢复链约 4.90ms；均为内存 SQLite 和假模型，不包含网络延迟。
- Gate 每次重新建 Ledger/Repository，避免依赖测试顺序；Fixture 只有 9 Event，不是吞吐基准。
- 实际运行瓶颈仍是远程模型；Candidate claim 和 Event 写入在 P1/P2 模块基准中均为毫秒级。

## 已知边界

- Golden 假模型不衡量语义分类准确率、幻觉率或 Prompt 泛化，真实 Adapter 需要独立离线数据集。
- 多目标隐式指代继续进入 ambiguity；交互式消歧未实现。
- Daemon 尚未装配自动 Worker/续租/重试循环。
- CodeGraph 尚未初始化；影响范围通过公开入口的全链集成、全量 TypeScript、依赖边界和全仓测试验证。

## Review 结论

P2 Gate 未发现未修复风险，三项原始 Gate 条件及补充的生命周期门禁全部通过。可以进入 P3/CKL-301 Project Identity Resolver。
