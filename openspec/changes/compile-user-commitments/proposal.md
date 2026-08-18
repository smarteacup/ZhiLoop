## Why

ZhiLoop 已有确定性的 `detectUserCommitments` 和 `applyUserCommitments`，但生产 `KnowledgeWorkerRuntime` 在模型生成 Candidate 后直接进入 Scope/Evidence Policy。用户在对话中的明确接受、否定和纠正因此没有进入实际候选链路，Candidate 也缺少可直接查询的完整编译 provenance。

## What Changes

- 新增可恢复的 `USER_COMMITMENT` Worker 阶段，位于 Candidate 编译之后、Scope/Evidence 之前。
- 对每个 Episode 检测接受、拒绝、纠正和歧义；只有唯一目标的接受/拒绝才写入 Candidate assertion。
- 纠正不直接改写模型正文，持久化为带 source reference 的演进草稿，交给 M4 决策关系。
- Worker checkpoint 保存承诺检测结果和每个 Candidate 的 compiler/prompt/input/policy provenance。
- Worker request 显式绑定 snapshot policy hash，并纳入 work identity。

## Capabilities

### New Capabilities

- `user-commitment-compilation`: 把对话中的用户承诺安全、可追溯地应用到候选知识。

### Modified Capabilities

- `knowledge-execution-modes`: 三种模式都复用已经成功的 USER_COMMITMENT checkpoint。

## Impact

- 修改 `knowledge-worker-runtime` 的阶段、request 与 payload DTO。
- 修改 P2 Production request composition，复用 Snapshot 的 policy hash。
- 旧 schemaVersion 1 checkpoint 缺少新阶段时惰性执行；已完成 checkpoint 不重放。
- 不修改 Ledger、Snapshot、Markdown、Registry 或 Job Store Schema。
