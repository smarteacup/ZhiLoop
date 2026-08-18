## Context

P2 当前复用一个分阶段 `KnowledgeWorkerRuntime` 完成 Ledger 读取、候选生成、Evidence Policy、Markdown 发布、Registry 投影和索引。Candidate Preview 通过 `stopAfterCandidatePolicy: true` 暂停，Policy Commit 再用默认参数续跑。该模型已经具备 checkpoint、阶段幂等和故障恢复，但“默认即发布”和布尔开关不足以作为自动化安全边界。

## Goals / Non-Goals

**Goals:**

- 任何未显式声明模式的调用只能生成 Preview。
- 同一 immutable work 可从 Preview 续跑至 Publication，不重复成功阶段。
- 发布必须有稳定授权身份，重试不能偷偷切换授权。
- 现有 P2 Durable Job、人工提交和自动 M1 Preview 保持一套队列与 Worker。

**Non-Goals:**

- 本模块不实现演进匹配、用户承诺或自动发布策略决策。
- 不把 Preview Job 自动转换为 Commit Job。
- 不改变 Evidence Policy 的结论算法。

## Decisions

### 1. 模式是每次执行的能力上限，不进入 work identity

```ts
type KnowledgeExecutionMode =
  | "PREVIEW_ONLY"
  | "POLICY_EVALUATION"
  | "SAFE_AUTO_PUBLICATION";
```

模式放入 `KnowledgeWorkerRunOptions`，默认 `PREVIEW_ONLY`。它不进入 immutable work identity，因为 Preview 和后续 Commit 必须续跑同一个 checkpoint。每次调用只按本次模式决定能否进入发布阶段；checkpoint 中记录 `lastExecutionMode` 用于观测，不把历史高权限模式自动继承给低权限调用。

当前 Worker 的 `CANDIDATE_POLICY` 同时完成 Evidence 与 Policy，因此 `PREVIEW_ONLY` 和 `POLICY_EVALUATION` 暂时都停在该阶段。M3/M4 拆分阶段后，`PREVIEW_ONLY` 可前移到候选/Evidence Preview，`POLICY_EVALUATION` 停在演进和策略建议；这不改变本模块的发布边界。

### 2. 发布需要结构化授权

```ts
type KnowledgePublicationAuthorization =
  | { kind: "EXPLICIT_COMMIT"; authorizationId: string }
  | { kind: "SAFE_POLICY"; authorizationId: string; policyHash: string };
```

`SAFE_AUTO_PUBLICATION` 没有授权时，在任何 Markdown 写入前以 `PUBLICATION_AUTHORIZATION_REQUIRED` fail closed。授权 ID 必须非空且有界；`SAFE_POLICY` 还必须绑定 policy hash。

首次获得发布授权时写入 checkpoint。只要发布阶段已经开始，后续重试必须提供完全相同的授权；更换授权返回 `PUBLICATION_AUTHORIZATION_CONFLICT`。在发布尚未开始时允许新的显式提交替换旧的未使用授权，避免过期控制台请求永久锁死 work。

### 3. 旧 checkpoint 惰性迁移

新增字段保持可选以读取历史 schemaVersion 1 数据：

```ts
lastExecutionMode?: KnowledgeExecutionMode;
publicationAuthorization?: KnowledgePublicationAuthorization;
```

下一次运行若模式或授权需要变化，通过现有 CAS `save` 补写，不修改 SQLite 表。已经完成的旧 checkpoint 直接返回，不被重新发布。

### 4. P2 Job 映射

- `CANDIDATE_PREVIEW` → `PREVIEW_ONLY`。
- `CANDIDATE_POLICY_COMMIT` → `SAFE_AUTO_PUBLICATION` + `EXPLICIT_COMMIT`，授权 ID 使用 durable commit job 的稳定 idempotency key。
- 后续自动策略发布只能由独立的 policy gate 生成 `SAFE_POLICY` 授权；M1 Adapter 没有该能力。

### 5. 故障与重试

模式/授权校验在 Ledger 检查和发布阶段前执行。成功阶段沿用当前 checkpoint，不重复调用模型或写入。Operator retry 只恢复一个 terminal retryable stage；授权错误不可重试，必须修正调用。

## Risks / Trade-offs

- 两个非发布模式目前行为相同：用清晰的前向兼容契约换取 M3/M4 分阶段演进，测试固定“不发布”这一核心语义。
- 模式不在 work identity：这是 Preview→Commit 续跑所必需；通过每次调用的能力上限和持久化授权防止权限继承。
- 旧 checkpoint 没有授权：已经发布完成的记录直接返回；未完成发布必须由新的显式授权续跑。

## Migration Plan

1. 增加类型、校验和运行时默认门禁。
2. 更新 P2 Preview/Commit 显式传参并补充集成测试。
3. 更新所有直接 Worker 测试，让需要发布的场景显式授权。
4. 全量 Gate 通过后保留旧 checkpoint 惰性兼容。

## Open Questions

无阻塞问题。`SAFE_POLICY` 的签发者和演进策略由 M4/M7 实现，本模块只定义不可绕过的消费门禁。
