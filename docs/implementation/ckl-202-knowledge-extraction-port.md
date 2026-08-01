# CKL-202 Knowledge Extraction Port

## 1. 目标与边界

`@zhiloop/knowledge-compiler` 在 CKL-202 阶段只提供模型无关的提取端口和执行边界，不包含具体 Prompt、模型 SDK、候选持久化或发布策略。CKL-203 将在该端口后实现 MVP 提取适配器，CKL-205 再持久化编译批次和重试状态。

核心流程：

```text
Episode
  -> toKnowledgeExtractionInput（最小语义投影）
  -> KnowledgeExtractionPort.extract（供应商无关 unknown 输出）
  -> KnowledgeExtractionOutput JSON Schema（整批校验）
  -> 来源/项目 Grounding 门禁
  -> 确定性 Candidate/Assertion 元数据落印
  -> SUCCEEDED | RETRYABLE | FAILED
```

模块生产代码只依赖 Domain、Schemas 和 `node:crypto`。它不读取 Ledger/SQLite/文件系统，不启动子进程，也不直接依赖 OpenAI、Anthropic 或其他模型 SDK。

## 2. 最小模型输入

`toKnowledgeExtractionInput` 只投影知识提取需要的字段：

- Episode 身份、Builder version、projectId/remote/branch/portable；
- 主目标和明确的 `goalRef`；
- 子目标、纠错前后内容和双方引用；
- 动作、产物、可观察结果；
- 上述语义实际引用的 eventId 集合。

以下内容不会进入模型输入：`sessionIds`、`turnIds`、Episode 状态/时间、派生项内部 ID、Session start/end 等无语义边界引用，以及本地 `repositoryRoot`。这既降低上下文体积，也避免把本机绝对路径无必要地发送给模型适配器。

每个语义引用必须存在于 Episode 的完整 `evidenceRefs`；无来源 Action/Outcome 或缺失 `goalRef` 会在调用模型前失败。输入被深冻结，并在每次执行开始时复制为不可变快照，适配器和调用方不能在重试期间改变身份或 Grounding 结果。

## 3. 结构化草稿 Schema

适配器返回 `unknown`，唯一接受格式是版本化 `KnowledgeExtractionOutput`：

```ts
interface KnowledgeExtractionOutput {
  schemaVersion: 1;
  candidates: KnowledgeCandidateDraft[];
}
```

草稿只包含模型负责的语义字段：`subjectKey`、类型、Scope hint、标题、摘要、正文、置信度、Assertion draft 和 Evidence hint draft。模型不能指定 candidateId、assertionId、compilerVersion、sourceEpisodes、createdAt 或 correlationId。

JSON Schema 约束包括：

- 顶层和全部嵌套结构拒绝未知字段；
- 每批最多 100 个 Candidate，每个 Candidate 最多 100 个 Assertion 和 100 个 Evidence hint；
- 标题 500、摘要 4,000、正文 32,000 字符上限；
- Assertion 参数按 kind 使用互斥结构和长度门禁；
- 每个 Candidate 至少包含一个 Assertion 或 Evidence hint。

Schema 对整批输出一次验证。任意一个草稿非法时，结果为 `INVALID_OUTPUT` 且 `candidates=[]`，不会返回通过校验的“部分 Candidate”。未知 schemaVersion 同样拒绝，并返回不含模型正文的 JSON Path 诊断。

## 4. Grounding 与元数据落印

Schema 通过后仍需执行确定性 Grounding：

- Evidence hint 的 `sourceRef` 必须属于精简输入中的 evidenceRefs；
- `USER_ACCEPTED/USER_REJECTED.statementRef` 必须指向输入证据；
- Scope hint、`SYMBOL_EXISTS` 和 Evidence hint 的 projectId 不能指向其他项目；
- repositoryRemote 若存在必须与 Episode 项目上下文一致。

整批 Grounding 任一失败也返回零 Candidate。成功后 Runner 统一写入：

- `candidateId`、`assertionId`：由版本身份和规范化草稿内容确定性计算；
- `status="PROPOSED"`：模型不能指定或提升 Candidate 生命周期；
- `compilerVersion`、`sourceEpisodes=[episodeId]`；
- 请求给定的 `requestedAt` 和 `correlationId`；
- Evidence hint correlationId 和 Assertion candidateId。

生成后的完整 Candidate 再经过既有 `knowledge-candidate` Schema 二次验证并深冻结。Runner 会复制嵌套 Scope/Assertion 参数，不会冻结或修改适配器持有的原始输出对象。

## 5. 幂等与版本

```text
inputHash = sha256("knowledge-extraction-input-v1" + canonical(minimalInput))

extractionKey = sha256(
  "knowledge-extraction-v1" +
  episodeId + builderVersion + inputHash + compilerVersion + promptVersion
)
```

`inputHash` 防止开放 Episode 在增加 Turn 后仍沿用旧幂等身份；相同内容、Builder/Compiler/Prompt 版本会稳定得到同一 extractionKey。改变 Episode 内容或任一版本都会产生新 Key。Result 同时记录 `episodeId`、`builderVersion`、`inputHash`、`compilerVersion` 和 `promptVersion`，供 CKL-205 原子去重和历史批次保留。

规范化输入设 4,000,000 字符硬上限，避免异常 Episode 使哈希和模型上下文无界增长。具体 Token Budget 和分片策略由 CKL-203 适配器进一步收紧。

## 6. 超时、重试和失败语义

默认策略：单次 30 秒、最多 3 次、重试间隔 250ms。门禁范围为：

| 参数 | 默认 | 允许范围 |
|---|---:|---:|
| `perAttemptTimeoutMs` | 30,000 | 1–300,000 |
| `maxAttempts` | 3 | 1–10 |
| `retryDelayMs` | 250 | 0–60,000 |

| 结果/原因 | 是否继续本次重试 | 最终语义 |
|---|---|---|
| `TIMEOUT` | 是 | 耗尽后 `RETRYABLE` |
| 通用异常、`UNAVAILABLE`、`RATE_LIMITED` | 是 | 耗尽后 `RETRYABLE` |
| `INVALID_OUTPUT` | 是 | 允许模型下一次修复结构；耗尽后 `RETRYABLE` |
| 明确不可重试 `REJECTED` | 否 | `FAILED` |
| 父任务取消 | 否 | `FAILED/ABORTED` |
| 重试 Scheduler 自身失败 | 否 | `RETRYABLE/RETRY_SCHEDULER_FAILED` |

所有失败结果都固定 `candidates=[]`，并保留 extractionKey、版本和 episodeId；因此 Worker 可以保留 Episode 后续重试，不会因模型不可用丢失原始对话。错误消息和模型正文不会进入结果或日志诊断。

Timeout 会向适配器传递 AbortSignal。适配器必须遵守取消信号；若供应商 SDK 不支持真正取消，旧请求可能继续占用其网络资源，但晚到输出不会进入本次结果。

## 7. 验证与性能

- 23 条端口专项测试覆盖最小输入、深冻结、原子失败、Grounding、确定性身份、输入变化、重试、超时、父取消、Scheduler 失败、Schema/参数/体积门禁和输出所有权。
- 新增 Extraction Schema 契约测试；3 条 Node 架构/集成测试验证无模型/存储耦合、成功落印和模型全故障可重试。
- 全仓 235 条模块测试、19 条架构/Gate 测试通过。
- Knowledge Compiler：Lines 92.89%、Branches 89.44%、Functions 90.69%；整体 Lines 96.91%、Branches 89.68%。
- Node.js 25.8.1，单批 100 Candidate，预热后 50 次：中位 1.71ms、P95 2.11ms，约 58,423 candidates/s；不含模型网络时间。
- npm 官方 registry 审计：0 vulnerabilities。

## 8. 已知边界

- CKL-202 没有具体模型适配器，不会自动生成五类 MVP 知识；该能力属于 CKL-203。
- Runner 返回重试身份但不持久化 attempt；崩溃恢复、并发 claim 和 exactly-once 批次写入属于 CKL-205。
- 当前采用固定间隔重试；生产 Adapter 可在 CKL-203/Daemon 装配时引入受上限约束的 Retry-After 或抖动策略。
- 本模块未安装 Hook、未启动 Daemon，也未读写 `~/.ckl`、`~/.codex` 或 `~/.ccm`。
