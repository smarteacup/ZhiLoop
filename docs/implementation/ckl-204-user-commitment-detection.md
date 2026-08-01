# CKL-204 用户承诺与纠正检测

## 1. 目标与边界

CKL-204 在 `@zhiloop/knowledge-compiler` 中新增确定性的用户承诺检测。它读取终态 Episode 和该 Episode 产生的 Candidate，输出三类可追溯信号：

```text
USER_ACCEPTED | USER_REJECTED | CORRECTION
```

该模块不调用模型、不读取代码、不持久化数据，也不推进 Candidate 生命周期。它只把用户明确表达和纠错关系转换为审计信号，并把可唯一定位的接受/拒绝写成 Assertion；Candidate 仍为 `PROPOSED`，后续由 Evidence Engine 判定状态。

## 2. Episode v2 原话保真

旧 Episode 只保留 goal、subgoal 和 correction，像“按这个做”“不要使用 Redis”这类普通 continuation/subgoal 没有独立正文记录，后续只能看到 eventId，无法审计承诺检测。

Episode 现在增加：

```ts
interface EpisodeUserStatement {
  turnId: string;
  sourceEventId: string;
  kind: "GOAL" | "CONTINUATION" | "SUBGOAL" | "CORRECTION";
  statement: string;
  occurredAt: string;
}
```

Builder 为每一条 `user.prompted` 生成一项 `userStatements`，保留分类、Turn、Event、原文和时间。由于输出契约发生语义变化，默认 `builderVersion` 从 `episode-builder-v1` 升为 `episode-builder-v2`，使相同 Ledger 在新旧规则下不会共享 Episode 身份。

这些原话不进入 CKL-202 的通用模型输入投影，避免重复扩大模型上下文；CKL-204 在本地读取完整 Episode。模型仍只接收 goal、subgoal、correction、action、artifact、outcome 和相关 evidence refs。

## 3. 检测与定位规则

公开接口分为检测和应用两步：

```ts
detectUserCommitments(episode, candidates): UserCommitmentDetectionResult
applyUserCommitments(candidates, detection): readonly KnowledgeCandidate[]
```

目标解析按以下优先级执行：

1. Correction 的 `originalRef` 精确匹配 Candidate 的 Evidence/Assertion 来源；
2. 普通接受/拒绝的 statementRef 只被一个 Candidate 明确引用时，关联该 Candidate；若多个 Candidate 引用仍视为歧义；
3. 用户原话中的明确主题唯一匹配 Candidate title、subjectKey 或 summary 中的有效词；
4. 没有引用/主题匹配且 Episode 只有一个 `REQUIREMENT/DESIGN/DECISION` 方案时，允许关联该方案；
5. 多个方案均可能命中时不生成接受/拒绝信号，而是返回 `ambiguities`。

首版只识别位于用户陈述开头的明确承诺/否定表达，例如“按这个做”“采用 Redis 方案”“不是这个意思”“不要使用 Redis”。文档、测试或讨论中仅引用这些词不会被当成承诺。普通“好的”没有足够语义，不会单独触发确认。

“按这个做”之后若有 Action，会附加 `FOLLOWED_BY_IMPLEMENTATION` 原因码，但后续动作不能突破多候选歧义门禁。主题词和 Candidate profile 每次检测只预计算一次，避免每条陈述重复分词。

## 4. Correction 与歧义证据

每条 Episode Correction 都生成 `CORRECTION` signal，完整保留：

- `turnId`、`statementRef`、statement 和 occurredAt；
- `originalRef + originalStatement`；
- `correctedRef + correctedStatement`；
- 关联 Candidate IDs 和原因码。

如果纠错正文明确否定旧结论，且旧目标可定位，还会额外生成 `USER_REJECTED`。即使目标无法定位，Correction signal 仍以 `TARGET_UNRESOLVED` 保留，不会丢弃用户纠错；若存在多个可能目标，返回包含 statement 和候选 ID 的歧义项，供后续交互式确认。

检测拒绝 OPEN Episode、重复陈述/纠错引用、缺失 evidence ref、无效时间和相互冲突的 Correction/UserStatement。来自其他 Episode 的 Candidate 不参与目标选择。

## 5. Assertion 落印与生命周期

只有已唯一定位的 `USER_ACCEPTED` / `USER_REJECTED` signal 会转换为 KnowledgeAssertion：

```text
assertionId = SHA256("user-commitment-assertion-v1", candidateId, kind, statementRef)
```

断言时间使用原始用户陈述时间，`parameters.statementRef` 指向原始 Event。重放相同检测不会重复增加断言；输入 Candidate 不会被修改，返回对象会深冻结。外部伪造的 signal kind、时间、重复/未知 Candidate target 会 fail closed。

写入 Assertion 不等于验证 Assertion。Candidate 状态继续保持 `PROPOSED`，避免一句自然语言直接绕过 Evidence/Policy 门禁变为正式知识。

## 6. 验证与性能

- 14 条 CKL-204 专项测试覆盖单方案确认、实施佐证、多方案歧义、主题定位、否定、Correction 双向保真、跨 Episode 隔离、引用短语误报、输入门禁、确定性去重和篡改拒绝。
- Episode Builder 增加全部 UserPrompt 原话保真和 v2 边界验证。
- Node 架构/Gate 增加 `Episode → detection → Assertion` 端到端验证；模块仍无模型 SDK、数据库、文件系统或子进程依赖。
- 全仓 259 条模块测试、21 条架构/Gate 测试通过。
- `commitment-detector.ts` Lines 95.58%、Branches 88.33%、Functions 95%。
- Node.js 25.8.1，100 Candidate × 100 UserStatement、50 次计时样本：中位 1.83ms、P95 2.03ms。
- npm 官方 registry 审计：0 vulnerabilities。

## 7. 已知边界

- 首版使用保守的中英文显式规则和词项匹配，不宣称理解隐含同意、反讽、代词链或复杂否定；这些场景进入无信号/歧义路径。
- 检测复杂度仍为 O(UserStatement × Candidate)，但 Candidate profile 只构建一次；单 Episode 候选预计是小批量。若未来允许数千 Candidate 联合解析，应增加 subject/topic 倒排索引。
- Action 只作为“确认后发生操作”的佐证，不证明实现与某个具体 Candidate 的代码一致；CKL-302 之后由代码/测试 Verifier 产生可验证 Evidence。
- `ambiguities` 目前只返回数据契约，交互式确认 UI/CLI 属于后续 Task Interaction 模块。
- 本模块未安装 Hook、未启动 Daemon，也未读写 `~/.ckl`、`~/.codex` 或 `~/.ccm`。
