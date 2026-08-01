# CKL-105 Session/Turn 归一化

## 1. 目标与边界

`@zhiloop/conversation-normalizer` 把 SQLite Event Ledger 的不可变事件记录重建为确定性的 `NormalizedSession` 与 `NormalizedTurn`。它是纯投影：不修改 Ledger，不持有游标，不读取 transcript，也不依赖 SQLite 运行时。

调用方必须显式传入 `asOf`；因此同一批 Ledger 记录和同一组选项始终得到相同输出，适合崩溃重建、回放测试和后续 Episode Builder。

## 2. 稳定排序

所有事件使用以下全序：

```text
(occurredAt timestamp, Ledger sequence/sourceOrder, eventId)
```

- `occurredAt` 反映来源时间，能修复晚到的工具事件；
- Ledger `sequence` 是同时间戳下的来源/入账顺序；
- `eventId` 只作为非法重复 sequence 下的确定性兜底，并产生 `DUPLICATE_SEQUENCE` 诊断。

输出只保留 `NormalizedEventRef`，正文继续由 Ledger 权威保存，避免投影复制 prompt/工具返回。

## 3. Turn 规则

1. 显式 `turnId` 相同的事件只生成一个 Turn；重复 Stop 只增加 `stopEventCount`。
2. 无 `turnId` 的 UserPrompt 创建基于 `sessionId + eventId` 的确定性合成 ID；后续无 ID 事件归入活动 Turn。
3. 如果合成 Turn 的后续工具/Stop 首次给出显式 ID，原 Turn 被提升为显式 ID，不拆成两个 Turn。
4. 只有 Turn 的最后一个事件为 Stop 时才以 `STOP_EVENT` 关闭；Stop 后继续出现工具事件表示 Turn 仍在继续。
5. 未 Stop 的 Turn 在下一个“开始时间晚于本 Turn 最后事件”的非重叠 Turn 处关闭；交错 Turn 不会生成倒序结束时间。
6. 最后一个活动 Turn 随 Session 关闭，原因记为 `SESSION_CLOSED`。

## 4. Session 规则

关闭优先级固定为：

1. `SOURCE_END`：存在 SessionEnd。若之后仍有事件，产生 `EVENT_AFTER_SESSION_END`，关闭时间扩展到最后活动时间，保证边界不倒退。
2. `NEXT_SESSION`：没有 SessionEnd，且同一 `projectHint`（优先）或 `cwd` 中存在开始于本 Session 最后事件之后的非重叠 Session。
3. `INACTIVITY_TIMEOUT`：截至显式 `asOf`，最后活动时间达到 inactivity timeout；关闭时间为 `lastActivityAt + timeout`，不是调用时刻。

缺少项目上下文时不会仅凭“出现新 sessionId”推断关闭；重叠 Session 也不会互相关闭，避免并行 Codex 任务串扰。后继 Session 通过按上下文分组后的二分查找计算，复杂度为 O(S log S)，不是逐 Session 全表扫描。

## 5. 诊断

| Code | 含义 | 投影行为 |
|---|---|---|
| `DUPLICATE_SEQUENCE` | 输入包含重复 Ledger sequence | 用 eventId 稳定排序，保留两条引用 |
| `MULTIPLE_SESSION_END` | 同 Session 有多个结束事件 | 仍只生成一个 Session，并保留所有结束引用 |
| `EVENT_AFTER_SESSION_END` | 结束事件之后还有非结束事件 | 保留事件，关闭时间不早于最后活动 |

所有结果、Session、Turn、事件引用和诊断均被冻结，后续编译器不能原地修改重建事实。

## 6. 性能与验证

- 23 条专项测试覆盖重复 Stop、Stop 后续跑、合成 ID 提升、缺失 SessionEnd、同时间戳 source order、并行 Session、交错 Turn、timeout、非法时间和真实 SQLite Ledger 集成。
- Conversation Normalizer 覆盖率：Lines 99.38%，Branches 95.77%，Functions 100%。
- Node.js 24.18.0，10,000 个乱序事件/1,000 个 Session，10 次样本：中位 8.48 ms，P95 16.67 ms，约 1,178,857 events/s。
- 全仓 187 个模块测试和 12 个架构测试通过；模块生产代码只以 `import type` 依赖 Ledger，不加载 `node:sqlite`。

## 7. 已知边界

- 当前投影通过全量 `LedgerEventRecord[]` 重建；增量物化和投影表将在 Episode/Worker 阶段按实际数据量决定。
- `contextKey` 先使用 `projectHint`，否则使用 cwd 原文；标准 projectId 和仓库路径归一化由后续 Project Resolver 提供。
- inactivity timeout 当前为 normalizer 调用选项，默认 30 分钟、最大 365 天；接入统一配置策略留给 Daemon 装配阶段。
