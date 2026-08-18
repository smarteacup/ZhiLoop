## Context

ZhiLoop 当前有两条已经稳定但彼此断开的链路：P1 将 Codex 会话增量采集到不可变 Ledger；P2 在控制台显式请求后创建 `ExtractionSnapshot`，再通过 `SqliteDurableJobStore` 和 `KnowledgeWorkerRuntime` 生成 Candidate Preview。`P2SidecarRuntime.state()` 仍把 `automaticCompile` 固定报告为 `DISABLED`。

本模块只解决 M1“何时自动编译、如何形成稳定快照并可靠排队”。它不改变候选内容生成算法、不做知识冲突演进，也不自动发布 Markdown/Registry/Index。总体方案以 `docs/design/continuous-knowledge-evolution-tdd.md` 6.1 节为上位设计，并参考 TencentDB Agent Memory 的阈值加空闲触发模式，但使用 ZhiLoop 现有 Ledger、不可变 Snapshot、CAS 检查点和 Durable Job 边界。

## Goals / Non-Goals

**Goals:**

- 自动发现已采集至最新且存在未编译有效事件的会话。
- 支持新增 Turn、空闲、会话结束和最长等待四类触发。
- 同一会话、同一不可变源版本和同一编译流水线最多创建一个 Preview 任务。
- 进程重启、重复扫描和并发扫描后能够从 SQLite 检查点继续。
- 自动链路与手动链路共用快照规划和 Preview 投递逻辑。
- 自动任务默认且强制停在 Candidate Preview。

**Non-Goals:**

- 不自动执行 Policy Commit 或正式知识发布。
- 不修改 `KnowledgeWorkerRuntime` 的候选提取和证据算法。
- 不执行任意测试、命令或外部网络调用。
- 不在本模块实现知识冲突演进、CodeGraph Evidence 或 Freshness Gate。
- 不改变 Ledger 原始事件和现有手动 API 的可见行为。

## Decisions

### 1. 新增独立调度包，应用层只提供端口

新增 `packages/knowledge-compilation-scheduler`，包含触发决策、检查点状态机、SQLite Store、单次扫描 Service 和非重叠 Scheduler。核心包只依赖 `session-catalog` 的只读 DTO，不依赖 Sidecar、控制台或具体 Transcript 文件。

关键端口：

```ts
export interface CompilationDispatchPort {
  dispatchPreview(request: AutomaticPreviewDispatchRequest): Promise<AutomaticPreviewDispatchResult>;
}

export interface CompilationCheckpointPort {
  load(sessionId: string): Promise<KnowledgeCompilationCheckpoint | undefined>;
  compareAndSwap(
    sessionId: string,
    expectedVersion: number | undefined,
    next: KnowledgeCompilationCheckpoint,
  ): Promise<"COMMITTED" | "CONFLICT">;
}
```

`dispatchPreview` 由 Sidecar 适配器实现，内部调用共享的 P2 Preview Coordinator。它负责对当前 Ledger/Codex 源进行二次确认、创建不可变快照并投递现有 Preview Job。

替代方案是把扫描和 Snapshot 创建全部写入 `P2ConsoleRuntime`。该方案会把后台调度生命周期、UI 请求校验和领域决策混在一起，因此不采用。

### 2. 抽取手动与自动共用的 Preview Coordinator

把 `P2ConsoleRuntime.#startPreview` 中与 UI 无关的逻辑抽取为 `P2CandidatePreviewCoordinator`：

1. 校验 Ledger revision 与采集游标是否仍为 current。
2. 读取同会话最近 Snapshot，计算增量 source range。
3. 当 compiler/policy/config 发生变化时，允许对同一不可变范围重新编译。
4. 创建 `ExtractionSnapshot`。
5. 投递 Candidate Preview Durable Job。

手动调用继续校验 UI 的 `expectedRevision` 和 `extract:<sessionId>:<revision>`；自动调用使用调度器产生的 dispatch key。Coordinator 的结果明确区分：

```ts
type AutomaticPreviewDispatchResult =
  | { status: "ENQUEUED" | "EXISTING"; snapshotId: string; jobId: string; compiledThroughSequence: number }
  | { status: "CURRENT"; compiledThroughSequence: number }
  | { status: "STALE"; reasonCode: "CAPTURE_NOT_CURRENT" | "SOURCE_CHANGED" | "LEDGER_CHANGED" }
  | { status: "INELIGIBLE"; reasonCode: "NO_EXTRACTABLE_EVENTS" | "UNSUPPORTED_SOURCE" };
```

这样手动和自动链路不会产生两套范围计算或不同的幂等规则。

### 3. 使用目录扫描加会话检查点，不依赖 P1 回调

单次扫描通过 `SessionCatalogQueryPort.list()` 分页读取会话，默认只处理：

- `sourceStatus === "AVAILABLE"`
- `captureStatus === "CAPTURED_CURRENT"`
- 当前 Ledger revision 大于检查点的 `lastCompiledLedgerSequence`

不直接依赖 P1 `onIngestionReport`，因为当前报告只包含计数，没有稳定的会话 ID 列表；强耦合回调也会让 P1 故障恢复和 P2 编译互相影响。目录轮询延迟可控，并天然覆盖重启期间遗漏的会话。

### 4. 触发条件使用确定性 OR 规则

默认配置：

```ts
interface KnowledgeCompilationConfiguration {
  enabled: boolean;                 // true
  scanIntervalMs: number;           // 30_000
  minimumNewTurns: number;          // 3
  minimumNewEvents: number;         // 2
  idleAfterMs: number;              // 120_000
  maximumWaitMs: number;            // 1_800_000
  pageSize: number;                 // 100
  maxSessionsPerRun: number;        // 1_000
  maxDispatchesPerRun: number;      // 25
  checkpointConflictRetries: number;// 3
}
```

会话必须先满足“存在至少 `minimumNewEvents` 个未编译事件”，再满足以下任一条件：

- 新增有效 Turn 数达到 `minimumNewTurns`；
- 当前时间距离 `lastActivityAt` 达到 `idleAfterMs`；
- 最新 Ledger 事件为 `session.ended`；
- 当前时间距离首次观察到未编译 revision 达到 `maximumWaitMs`。

Catalog 的 `turnCount/eventCount` 只用于廉价筛选；真正 dispatch 前 Coordinator 必须基于 Ledger 范围复核，避免源计数与已脱敏 Ledger 数量不一致。

### 5. 每个会话使用 CAS 检查点状态机

```ts
interface KnowledgeCompilationCheckpoint {
  schemaVersion: 1;
  sessionId: string;
  version: number;
  lastObservedLedgerSequence: number;
  lastObservedEventCount: number;
  lastObservedTurnCount: number;
  lastCompiledLedgerSequence: number;
  lastCompiledEventCount: number;
  lastCompiledTurnCount: number;
  firstPendingObservedAt?: string;
  lastActivityAt: string;
  sourceVersion?: string;
  lastCompiledPipelineHash?: string;
  pendingSnapshotId?: string;
  pendingJobId?: string;
  nextEligibleAt?: string;
  status:
    | "OBSERVING"
    | "WAITING_IDLE"
    | "QUEUED"
    | "RETRY_WAIT"
    | "CURRENT"
    | "FAILED";
  lastReasonCode: string;
  updatedAt: string;
}
```

SQLite 表以 `session_id` 为主键，`version` 为 CAS 条件，并对 `(status, next_eligible_at, session_id)` 建索引。状态更新规则：

- 尚未满足触发条件：`WAITING_IDLE`，保留 `firstPendingObservedAt`。
- dispatch 成功或返回已有任务：`QUEUED`，同时记录 snapshot/job 和已覆盖 sequence。
- 没有新事件：`CURRENT`。
- 可恢复的 source/revision 竞争：`RETRY_WAIT`。
- 输入永久不支持或状态数据损坏：`FAILED`。

CAS 冲突最多重读并重算三次；不能通过最后写入覆盖胜者状态。

### 6. 幂等身份绑定不可变源和流水线版本

调度 dispatch key 使用规范 JSON 的 SHA-256：

```text
knowledge-compile:v1:<sha256({
  sessionId,
  expectedLedgerSequence,
  sourceVersion,
  compilerVersion,
  promptVersion,
  policyHash,
  configurationHash,
  executionMode: "PREVIEW_ONLY"
})>
```

Coordinator 仍使用现有 Snapshot identity 和 Preview idempotency key 写入 P2 Store。外层 dispatch key 防止调度重复，内层 key 防止 Snapshot/Job 重复；二者都不使用时间戳。

### 7. 自动链路硬门禁为 PREVIEW_ONLY

M1 不给调度器暴露 `enqueuePolicyCommit`。Sidecar Adapter 只实现 `dispatchPreview`；P2 Preview Handler 继续以 `stopAfterCandidatePolicy: true` 执行。即使配置误写，也没有从 M1 直接调用发布链路的接口。

### 8. 非重叠、完成后计时的运行生命周期

Scheduler 复用 `AutomaticIngestionScheduler` 的模式：同一时刻最多一个扫描 Promise；每轮完成后再等待 `scanIntervalMs`；`stop()` 取消下一次定时但不强杀正在进行的数据库事务。Sidecar 启动顺序为 P1/P2 Store 初始化 → P2 Job Worker → Compilation Scheduler；关闭顺序相反。

配置热更新先构造并验证候选 Service/Store，再原子替换 Scheduler。失败时继续运行旧配置。

### 9. 运行状态和诊断保持有界

P2 状态把 `automaticCompile` 扩展为 `READY | STOPPED | DEGRADED | DISABLED`。单次报告只保留计数、有限 reason code 和最近时间，不包含对话正文：

```ts
interface KnowledgeCompilationRunReport {
  startedAt: string;
  completedAt: string;
  scannedSessions: number;
  eligibleSessions: number;
  queuedSessions: number;
  currentSessions: number;
  deferredSessions: number;
  retrySessions: number;
  failedSessions: number;
  bounded: boolean;
  diagnosticCodes: readonly string[];
}
```

## Risks / Trade-offs

- [目录扫描会重复读取较多会话] → 使用分页、`maxSessionsPerRun` 和完成后计时；后续可增加变更 feed，但不作为 M1 前置条件。
- [Catalog 计数与 Ledger 有偏差] → Catalog 只做初筛，Coordinator 在 dispatch 前以 Ledger revision/range 二次确认。
- [手动和自动提取并发] → 共用 Snapshot/Preview 幂等键，检查点 CAS 冲突后重读；重复请求返回 `EXISTING`。
- [持续活跃会话长期不满足 idle] → 使用 Turn 阈值和 `maximumWaitMs` 上限。
- [模型任务积压] → 每轮有界、Durable Job 自带租约/重试；调度器不等待模型完成。
- [错误配置意外发布知识] → M1 端口只允许 Preview，类型和集成测试同时验证不存在自动 Commit。
- [SQLite 文件或检查点损坏] → 单会话标记 `FAILED` 并报告诊断，不能影响 Codex 主流程和其他会话。

## Migration Plan

1. 增加新包、SQLite Store 和纯决策测试，默认不接入生产生命周期。
2. 抽取 P2 Preview Coordinator，并用现有手动链路回归测试证明行为不变。
3. 在 Sidecar 接入 Scheduler，但先以 `enabled: false` 验证状态和迁移。
4. 默认启用 `PREVIEW_ONLY`；观察任务量、失败率和重复任务数。
5. 回滚时停止 Scheduler 并将配置设为 disabled；已有 Snapshot/Candidate/Job 保留，SQLite 检查点可继续用于下一次启用。

数据库迁移只新增 `automatic-knowledge-compilation.sqlite`，不修改已有 Ledger、P2 Job、Extraction 或 Knowledge 数据库，因此回滚不需要降级旧表。

## Open Questions

无阻塞问题。自动正式发布、冲突演进和 CodeGraph Evidence 均由后续独立模块决定，M1 不预留绕过 Preview 门禁的兼容开关。
