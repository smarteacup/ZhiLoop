# ZhiLoop Code Review

## 📊 统计概览

### 当前 CR 情况

| 指标 | 数值 |
|---|---:|
| **CR 标识** | CKL-105 / Session/Turn 归一化 |
| **CR 耗时** | 540s |
| **🔴 高风险** | 2 个 |
| **🟡 中风险** | 5 个 |
| **🟢 低风险** | 0 个 |
| **修复程度** | 已修复 7/7（100%） |

### 累计情况

| 指标 | 累计值 |
|---|---:|
| **总 CR 次数** | 10 次 |
| **总耗时** | 3760s |
| **🔴 高风险累计** | 13 个 |
| **🟡 中风险累计** | 30 个 |
| **🟢 低风险累计** | 0 个 |
| **平均修复程度** | 100% |

## 改动说明

本次新增 Domain 层 `NormalizedSession`、`NormalizedTurn`、稳定事件引用和关闭原因，并新建独立 `@zhiloop/conversation-normalizer` 包。Normalizer 从 `LedgerEventRecord` 纯函数重建会话：按 source timestamp、Ledger sequence 和 eventId 全序排序，折叠重复 Stop，补齐/提升缺失 turnId，并通过 SessionEnd、后续非重叠 Session 或 inactivity timeout 确定边界。

Node.js 24.18.0 全仓 187 个模块测试和 12 个架构测试通过；Normalizer Lines 99.38%、Branches 95.77%、Functions 100%。真实 `SqliteEventLedger` 集成 Fixture 验证 Hook/Transcript 双 Stop 只产生一个 Turn。

## 风险矩阵

| 增/删 | 风险 | 代码定位 | 问题描述 | 影响范围 | 修复结果 |
|---|---|---|---|---|---|
| 增 | 🔴 高 | `packages/conversation-normalizer/src/normalizer.ts` / `sessionSuccessors` | 初版每个 Session 都线性扫描全部 Session 查找后继，Session 数量增大时退化为 O(S²)。 | Daemon 重建延迟、CPU 峰值 | 按 contextKey 分组并用稳定开始元组二分查找，降为 O(S log S)；10,000 事件/1,000 Session 中位 8.48ms。 |
| 增 | 🔴 高 | `packages/conversation-normalizer/src/normalizer.ts` / `nextNonOverlappingTurn` | 仅用相邻 Turn 开始时间关闭前 Turn；显式 turnId 交错时可能得到 endedAt 早于该 Turn 最后事件。 | Episode 边界错误、证据归属错误 | 改为二分查找第一个开始于当前 Turn 最后事件之后的非重叠 Turn；交错 Fixture 确认边界单调。 |
| 增 | 🟡 中 | `packages/conversation-normalizer/src/normalizer.ts` / Turn 聚合 | UserPrompt 无 turnId、后续工具才提供显式 ID 时会拆成一个 synthetic Turn 和一个 real Turn。 | 重复 Turn、知识片段化 | 活动 synthetic Turn 在首次显式 ID 出现时原地提升，保留全部事件并改为 `syntheticId=false`。 |
| 增 | 🟡 中 | `packages/conversation-normalizer/src/normalizer.ts` / Stop 规则 | 第一个 Stop 直接关闭 Turn 会把 Stop continuation 后的工具事件排除在 Turn 之外。 | 闭环续跑记录丢失 | 只有 Turn 最后事件为 Stop 才用 `STOP_EVENT` 关闭；多个 Stop 计数但只生成一个 Turn。 |
| 增 | 🟡 中 | `packages/conversation-normalizer/src/normalizer.ts` / Session 关闭 | SessionEnd 后出现晚到事件时，直接使用结束时间会造成 Session/Turn 结束早于最后活动。 | 时间线倒序、Episode 构建异常 | 产生 `EVENT_AFTER_SESSION_END` 诊断，SOURCE_END 关闭时间扩展到最后活动，保留可追溯事件。 |
| 增 | 🟡 中 | `packages/conversation-normalizer/src/normalizer.ts` / options | Date.parse 会接受 2 月 30 日等被自动归一化的日期，超大 timeout 还可能导致 Date 溢出。 | 非确定性 timeout、运行时 RangeError | 显式校验 ISO 字段、月日/时分秒/offset；timeout 限定 1ms 到 365 天，`asOf` 必须由调用方传入。 |
| 增 | 🟡 中 | `packages/conversation-normalizer/src/normalizer.ts:3` | 引用 Ledger 类型若变为普通 import，会在纯投影进程加载 `node:sqlite`。 | 模块耦合、启动成本 | 生产代码使用 `import type`，编译 JS 无 Ledger import；新增架构测试固定该边界。 |

## 配置与兼容性检查

| 检查项 | 结果 | 结论 |
|---|---|---|
| 稳定排序 | `(occurredAt, sequence, eventId)` | 通过 |
| 重复 Stop | 同 turnId/no-ID 活动 Turn 均折叠，保留 stopEventCount | 通过 |
| 缺失 turnId | 确定性 synthetic ID，可被后续显式 ID 提升 | 通过 |
| Session 关闭 | SOURCE_END > NEXT_SESSION > INACTIVITY_TIMEOUT | 通过 |
| 并发隔离 | 无 context 不推断；重叠 Session 不互关 | 通过 |
| 时间安全 | 严格 ISO、显式 asOf、timeout 有界 | 通过 |
| 不可变性 | 结果、数组、Session、Turn、引用和诊断冻结 | 通过 |
| 运行时依赖 | Ledger 仅类型依赖，不加载 SQLite | 通过 |

## 性能与瓶颈复盘

- Node 24.18.0，10,000 个逆序事件、1,000 个 Session、10 次全量重建：中位 8.48ms，P95 16.67ms，约 1,178,857 events/s。
- 主排序为 O(N log N)，Session 后继为 O(S log S)，每个 Session 内 Turn 后继为 O(T log T)；空间复杂度 O(N)。
- 当前基准是内存 `LedgerEventRecord[]`，不包含 SQLite 分页读取。后续 Worker 应分离“读 Ledger”与“投影计算”指标。
- 输出只复制事件引用，不复制 payload，降低 Episode 构建前的内存放大和敏感正文扩散。

## 已知边界

- 当前是全量纯投影，没有持久化 Normalized Session/Turn 表或增量游标；P2 Episode Builder 可先复用全量重建，再根据真实规模决定物化。
- contextKey 尚未使用规范化 projectId；相同仓库的软链接/路径别名可能无法互认，等待 Project Resolver。
- SessionEnd 后事件采用“保留并扩展关闭时间”策略；诊断消费与告警阈值由 Daemon Worker 后续实现。

## Review 结论

CKL-105 未发现未修复风险。重复 Stop、乱序事件、缺失边界、并发隔离、确定性、复杂度和 SQLite 集成达到验收条件，可以提交并执行 P1 Gate。
