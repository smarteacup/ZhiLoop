## Why

现有 `KnowledgeWorkerRuntime` 用布尔参数 `stopAfterCandidatePolicy` 区分预览和发布，未表达调用方的执行意图，也没有要求发布授权。默认不传参数会直接执行 Markdown、Registry 和 Index 写入，容易让新增后台调用误越过人工门禁。

## What Changes

- 新增 `PREVIEW_ONLY`、`POLICY_EVALUATION`、`SAFE_AUTO_PUBLICATION` 三种显式执行模式。
- 默认模式改为 `PREVIEW_ONLY`，预览和策略评估均停在持久化候选/策略边界。
- `SAFE_AUTO_PUBLICATION` 必须携带稳定、可审计的显式提交或安全策略授权。
- 检查点记录最近执行模式和发布授权；同一 work 可从预览安全续跑到发布，不能更换授权后重放部分发布。
- P2 Preview 与 Commit Job 显式映射到对应模式，不新增第二套任务队列。

## Capabilities

### New Capabilities

- `knowledge-execution-modes`: 对知识 Worker 的阶段上限、发布授权、续跑和审计语义进行标准化。

### Modified Capabilities

- `automatic-knowledge-compilation`: 自动编译继续被硬限制在 `PREVIEW_ONLY`。

## Impact

- 影响 `knowledge-worker-runtime` 的公共运行选项和检查点 DTO。
- 影响 Sidecar P2 Preview/Commit Worker 的调用参数及测试夹具。
- 旧 checkpoint 无新增字段时可继续读取；下一次运行会补写模式信息。
- 不修改现有 Durable Job Store、Snapshot、Ledger、Markdown 或 Registry Schema。
