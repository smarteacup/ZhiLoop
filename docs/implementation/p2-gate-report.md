# P2 Gate 验证报告

## 1. Gate 范围

P2 Gate 验证 CKL-201 至 CKL-205 的组合行为，不重复证明单模块内部实现。退出条件为：

1. 版本化对话 Fixture 能生成五种 MVP 知识；
2. 每个 Candidate 能追溯到 Episode 和具体 Turn；
3. 模型失败不丢 Event/Episode，持久化重试后可成功；
4. PROPOSED Candidate 不因端到端串联进入默认召回。

Gate 使用本地假模型验证结构化契约和故障恢复，不发起远程模型请求，不把其结果解释为真实模型语义质量。

## 2. Golden Fixture

Fixture 位于：

```text
fixtures/p2/v1/codex-hook-knowledge-session.jsonl
fixtures/p2/v1/expected.json
```

`expected.json` 固定 `fixtureVersion=p2-golden-v1`、9 行 Hook、9 个标准 Event、1 个 Session、3 个 Turn、1 个 `episode-builder-v2` Episode，以及五类知识的精确顺序。

对话包含：

- 主目标：设计并实现可追溯的五类知识编译流程；
- 方案回复和用户“按这个做”；
- 文件写入、测试命令与成功结果；
- 用户纠正：PROPOSED 只能显式审计，不能进入正式召回；
- Session 结束。

Fixture 从 Codex Hook 原始形态开始，经 Adapter 生成标准 Event，不直接伪造 Episode 或 Candidate。

## 3. 成功链路

Gate 真实执行：

```text
Codex Hook Fixture
  -> adaptCodexHook
  -> SqliteEventLedger
  -> normalizeConversations
  -> buildEpisodes (v2)
  -> toKnowledgeExtractionInput
  -> MvpKnowledgeCompiler / Runner
  -> SqliteCandidateRepository claim + save
```

假模型只读取 `StructuredGenerationRequest.input`，不闭包读取完整 Episode 或 expected 文件。它为 Requirement、Design、Decision、Implementation、Experience 分别选择 goal、correction、action 或 outcome 中真实存在的 sourceRef。Runner 继续执行五类限制、Schema、Grounding、ID 和 PROPOSED 落印。

最终 Repository 保存 5 个 Candidate，再次 claim 返回 `ALREADY_SUCCEEDED`；普通 `listCandidates()` 返回空数组，证明 PROPOSED 默认不可召回。

## 4. Episode 与 Turn 追溯

Gate 不只检查 `sourceRef ∈ episode.evidenceRefs`，还从 Normalizer 输出建立：

```text
eventId -> normalized turnId
```

每个 Candidate 的每条 Evidence hint 必须同时满足：

- sourceRef 存在于 Normalized Turn；
- 该 turnId 存在于 Candidate 来源 Episode 的 `turnIds`；
- sourceRef 存在于 Episode 的 `evidenceRefs`；
- `sourceEpisodes=[episodeId]`。

这避免 SessionEnd 等只有 Session 归属、没有 Turn 归属的 Event 被错误宣称为“Turn 可追溯”。

## 5. 承诺与歧义闭环

Gate 发现五类批次通常同时包含 Requirement、Design 和 Decision，因此“按这个做”不能再依赖“只有一个 proposal-like Candidate”的降级规则。

CKL-204 补充：若只有一个 Candidate 明确以当前承诺 statementRef 为 Evidence/Assertion 来源，可优先定位；若多个 Candidate 引用同一 statementRef，仍返回 ambiguity。Golden Compiler 的最小输入不包含普通 continuation 原话，因此本 Fixture 中“按这个做”保持多目标歧义，Gate 明确断言不会自动确认。

Correction signal 保留 `p2-turn-3`、原/新 statement 和引用，证明纠错链路在五类编译后仍可审计。

## 6. 模型失败与恢复

第二条 Gate 在同一已落账对话上执行：

1. Repository 第一次 claim；
2. 模型抛出模拟 outage，Runner 以 `RETRYABLE/ADAPTER_UNAVAILABLE` 返回零 Candidate；
3. Repository 原子保存 RETRYABLE 批次；
4. 重新从 Ledger 读取 records，重建 Normalized Session 和 Episode；
5. 重建 Episode 与失败前 JSON 字节一致，Ledger Event 数不变；
6. 第二次 claim 获得新 generation，成功生成并保存 5 个 Candidate；
7. 最终 `runCount=2`，Event 数仍不变。

失败没有清理 Event、覆盖 Episode 或写入部分 Candidate，恢复也没有要求用户重新输入对话。

## 7. Gate 结果

| 验收项 | 证据 | 结论 |
|---|---|---|
| 五类知识生成 | Golden 精确得到 REQUIREMENT/DESIGN/DECISION/IMPLEMENTATION/EXPERIENCE | 通过 |
| Candidate → Episode | 每条 `sourceEpisodes` 等于 Golden episodeId | 通过 |
| Candidate → Turn | 每条 Evidence hint 经 eventId 映射到 Episode Turn | 通过 |
| 承诺安全门禁 | 多目标“按这个做”产生 ambiguity，不自动确认 | 通过 |
| 默认不召回 | Repository 普通查询不返回 PROPOSED | 通过 |
| 模型失败不丢事件 | 失败前后 Event 数和重建 Episode 一致 | 通过 |
| 可持久化重试 | RETRYABLE → 第 2 次 claim → SUCCEEDED，runCount=2 | 通过 |
| 全仓模块测试 | 276/276，24 Test Files | 通过 |
| 架构/Gate 测试 | 25/25 | 通过 |
| 覆盖率 | Lines 96.69%、Branches 89.91%、Functions 97.61% | 通过 |
| 供应链 | npm 官方 registry 0 vulnerabilities | 通过 |

本地最新单次执行中，成功 Golden 主链约 23.45ms，失败后恢复链约 4.90ms；这是内存 SQLite + 假模型的回归耗时，只用于发现数量级退化，不代表远程模型延迟。

## 8. 结论与后续边界

P2 Gate 通过，Episode、五类知识编译、用户承诺门禁和 Candidate 持久化已经形成可重放闭环。P3 可以开始实现 Project Identity 和 Evidence Engine。

仍保留以下边界：

- Golden 假模型证明结构化通路，不衡量真实模型分类准确率；接入真实 Adapter 后需要独立离线评估集。
- 多 Candidate 的隐式代词/承诺若没有唯一 sourceRef 或主题，继续进入 ambiguity；交互式消歧尚未实现。
- Daemon Worker 尚未装配自动 claim/renew/retry 循环。
- Candidate 全部保持 PROPOSED；代码、测试和用户 Assertion 的 Evidence 验证属于 P3。
- 未安装 Hook、未启动 Daemon，也未读写 `~/.ckl`、`~/.codex` 或 `~/.ccm`。
