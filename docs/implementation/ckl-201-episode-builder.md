# CKL-201 Episode Builder

## 1. 目标与边界

`@zhiloop/episode-builder` 将 `NormalizedSession` / `NormalizedTurn` 聚合为围绕同一目标的 `Episode`。它是确定性纯投影：正文从 Event Ledger 读取，边界由 Conversation Normalizer 提供；不写 SQLite、不调用模型、不修改输入，也不跨 Session 猜测关联。

公开入口为：

```ts
buildEpisodes(
  records: readonly LedgerEventRecord[],
  sessions: readonly NormalizedSession[],
  options?: EpisodeBuilderOptions,
): EpisodeBuildResult
```

`builderVersion` 参与 `episodeId` 计算。规则升级后使用新版本即可并行重建，不会把不同构建语义写进同一身份。

## 2. 事实来源与重建约束

Builder 同时校验两层输入：

- Normalizer 引用决定 Session、Turn 和事件归属；
- Ledger record 提供 prompt、工具调用、文件变化和 assistant stop output 正文。

每个引用必须与 Ledger 的 `eventId`、`sequence`、`source`、`eventType`、`occurredAt` 和 `sessionId` 完全一致。同一事件被多个 Turn/Session 边界重复引用、重复 eventId、缺失引用、引用元数据不一致、不可用 UserPrompt，以及未被 Normalizer 引用的额外 Ledger record 都会拒绝整次构建，不产生看似成功但证据不完整的 Episode。

Episode 内事件使用 `(occurredAt, Ledger sequence, eventId)` 全序；`evidenceRefs` 覆盖其全部 Turn 事件和所属的 Session start/end 边界。因此相同 Ledger、相同 Normalized 输入和相同选项可得到字节一致的结果。

## 3. 目标聚合规则

默认分类器是可替换的确定性规则，不调用模型：

| Prompt 类型 | 默认识别 | Episode 行为 |
|---|---|---|
| `PRIMARY` | Episode 的首条有效 prompt | 建立主目标 |
| `CONTINUATION` | “继续”“好的”“go on”等纯确认 | 保持当前目标，不增加子目标 |
| `SUBGOAL` | “另外”“同时”“还有”等，或无法明确分界的后续请求 | 保留在当前 Episode 的显式 `subgoals` |
| `CORRECTION` | “不对”“纠正”“应该改为”等 | 记录被纠正内容和新内容，不覆盖历史 |
| `NEW_GOAL` | “新任务”“换个问题”“回到…”等明确切换 | 结束当前 Episode，并从当前 Turn 建立新 Episode |

默认策略对歧义采用“不拆分”：普通后续请求成为显式子目标，只有明确的目标切换词才新建 Episode。这样避免轻微措辞变化导致知识被错误切碎。后续可注入更强的分类器，但返回类型、非空 statement 和单 Turn 原子边界仍由 Builder 门禁校验。

首版只在单 Session 内聚合连续 Turn。跨 Session 合并必须等后续具备显式 task/topic reference 后再开放，不能仅靠文本相似度自动串联并行任务。

## 4. 纠错闭环

每条 `Correction` 同时保留：

- `originalRef` 与 `originalStatement`：优先指向上一条可见 assistant 输出；没有输出时指向当前主目标；
- `correctedRef` 与 `correctedStatement`：指向用户本次纠正 prompt；
- `turnId` 与 `occurredAt`：保留发生边界。

这使后续 Knowledge Compiler 能识别“旧结论被否定、新结论被确认”，而不是只看到最终文本或把旧结论继续注入。

## 5. 动作、产物与结果

Builder 当前只做可审计的机械提取：

- `tool.completed` 生成 `TOOL` 或 `COMMAND` Action；
- `file.changed` 生成 `FILE_CHANGE` Action；
- 写入/编辑类工具和文件事件生成去重后的 FILE Artifact；
- 明确 exit code/status 生成 `SUCCESS` / `FAILURE` Outcome；
- assistant stop output 生成 `UNKNOWN` Outcome，语义结论留给后续 Knowledge Compiler。

所有派生项都携带或间接携带来源 eventId。Builder 不根据自然语言伪造成功结论。

## 6. 状态、诊断和限制

- Session 已关闭时，最后 Episode 为 `COMPLETED`；仍含活动 Turn 时为 `OPEN`。
- 明确切换目标时，前一 Episode 的 Turn 全部关闭则为 `COMPLETED`，否则为 `ABANDONED`。
- `TEXT_TRUNCATED` 对同一事件只报告一次；省略号计入 `maxTextChars` 上限。
- 同一 Turn 出现第二个主目标时不能原子拆 Turn，降级为子目标并产生 `MULTIPLE_PRIMARY_PROMPTS`。
- `ProjectContext` 只投影已知字段；无效 projectId、portable 或空的可选字段会被拒绝。

默认可见文本上限为 32,000 字符，硬上限为 262,144。返回的 Episode、数组、诊断和派生记录均被冻结。

## 7. 性能与验证

- 22 条专项测试覆盖多 Turn 合并、目标拆分/子目标、纠错双向保真、Action/Artifact/Outcome、确定性重建、引用完整性、分类器门禁、截断和不可变输出。
- 2 条 Node 架构/集成测试验证生产源码只以 type import 依赖 Ledger，并用真实内存 SQLite Ledger → Normalizer → Episode Builder 完成一致重建。
- Episode Builder 覆盖率：Lines 96.63%、Branches 86.28%、Functions 100%。
- Node.js 25.8.1，10,000 事件/5,000 Turn，预热后 10 次样本：中位 24.20ms，P95 29.67ms，约 413,153 events/s。
- 全仓 211 条模块测试和 16 条架构/Gate 测试通过；整体 Lines 97.61%、Branches 89.71%，官方 npm registry 审计 0 vulnerabilities。

聚合、Turn 去重和 Artifact 去重使用 Set；主要复杂度为事件校验/提取 O(E + T)，加上 Episode 内稳定排序 O(E log E)。当前主要内存成本是一次重建同时持有 Ledger records、Normalized refs 和 Episode 派生数组。

## 8. 已知边界

- 默认目标分类是中英文显式标记规则，不声称理解所有自然语言目标变化；歧义会进入子目标，后续可由交互式确认或二次闭环调整。
- 当前只识别工具输入中的常见命令/路径字段，以及返回中的 exit code/status；更丰富的结果语义属于 CKL-202/203。
- 只有 Session boundary、没有 Turn 活动的会话不生成空 Episode，但边界仍会通过引用完整性校验。
- 本模块未安装 Hook、未启动 Daemon，也未读写 `~/.ckl`、`~/.codex` 或 `~/.ccm`。
