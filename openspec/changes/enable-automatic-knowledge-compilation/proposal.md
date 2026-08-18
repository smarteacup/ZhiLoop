## Why

ZhiLoop 已经能够自动把 Codex 会话增量采集到 Ledger，也能够在用户手动操作后生成知识候选，但两条链路尚未自动衔接，导致知识沉淀覆盖率依赖人工操作。需要增加一个可靠、幂等且默认不发布正式知识的后台调度能力，让符合条件的会话自动推进到 Candidate Preview。

## What Changes

- 新增自动知识编译调度器，基于有效 Turn 数、会话空闲、会话结束和最长等待时间选择待编译会话。
- 为每个会话持久化编译检查点，并使用 Compare-And-Swap 防止扫描、手动提取和新事件追加之间互相覆盖。
- 为确定的 Ledger 快照生成稳定幂等键，并投递到现有 Durable Job 运行时。
- 自动任务只执行到 Candidate Preview；正式知识发布仍需现有显式提交或后续独立灰度策略。
- 在 Sidecar 生产组合中接通自动调度生命周期、运行状态和安全重配置。
- 增加确定性测试、SQLite 恢复测试、并发冲突测试和生产组合测试。

## Capabilities

### New Capabilities

- `automatic-knowledge-compilation`: 定义会话何时自动形成不可变编译快照、如何幂等排队、如何持久恢复，以及为何必须停在 Candidate Preview。

### Modified Capabilities

无。

## Impact

- 新增 `packages/knowledge-compilation-scheduler` 工作区包。
- 扩展 Sidecar P2 运行时与生产组合，使其可接收自动快照规划并复用现有 Durable Job/Knowledge Worker。
- 增加独立 SQLite 检查点文件；不修改 Ledger 原始事件，也不改变已有手动提取 API 的行为。
- 增加自动编译配置和只读运行状态；默认以 SHADOW/PREVIEW_ONLY 方式启用，不自动发布知识。
