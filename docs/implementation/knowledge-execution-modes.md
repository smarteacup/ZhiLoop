# 知识任务执行模式（M2）实施说明

## 1. 实施结果

知识 Worker 已从布尔开关升级为显式能力模式，并把默认行为改为 fail-closed：调用方没有声明模式时，只能生成候选与策略预览，不能写入正式知识。

| 模式 | 当前执行上限 | 是否允许发布 |
|---|---|---|
| `PREVIEW_ONLY` | Ledger、Episode、Candidate、Evidence/Policy Preview | 否 |
| `POLICY_EVALUATION` | 当前与 Preview 相同；为 M3/M4 的演进/策略阶段预留独立语义 | 否 |
| `SAFE_AUTO_PUBLICATION` | 完整 Worker 阶段 | 是，但必须有发布授权 |

## 2. 发布授权

发布模式接受两类结构化授权：

- `EXPLICIT_COMMIT`：控制台人工确认；授权 ID 使用 P2 Commit Durable Job 的稳定 idempotency key。
- `SAFE_POLICY`：供后续自动策略门禁签发；必须同时绑定 `authorizationId` 与 `policyHash`。

授权字段会 trim、限制为 1～512 字符并写入 checkpoint。缺失、类型错误、空值或非发布模式夹带授权都会在 Markdown 写入前失败。发布阶段一旦开始，重试必须使用相同授权；更换授权会返回 `PUBLICATION_AUTHORIZATION_CONFLICT`。

## 3. 续跑语义

- 执行模式不进入 immutable work identity，因此同一 Snapshot 可以先 Preview，再由 Commit Job 续跑。
- 每次调用只获得本次模式的能力，不继承 checkpoint 曾经使用过的高权限模式。
- 成功阶段继续由现有 checkpoint 跳过；Preview→Commit 不会重新调用模型、重建 Episode 或重复 Evidence。
- 低权限 `retryFailed` 不能重置失败的 Markdown、Registry 或 Index 阶段。
- checkpoint 记录 `lastExecutionMode` 与已接受的 `publicationAuthorization`，便于任务详情审计。

## 4. P2 映射

```text
CANDIDATE_PREVIEW
  -> PREVIEW_ONLY
  -> AWAITING_COMMIT

CANDIDATE_POLICY_COMMIT
  -> SAFE_AUTO_PUBLICATION
  -> EXPLICIT_COMMIT(context.idempotencyKey)
  -> COMPLETED
```

M1 自动调度只能投递 `CANDIDATE_PREVIEW`，其 Adapter 没有构造 Commit Job 或发布授权的端口。因此即使 Evidence Policy 返回 `shouldPublish = true`，自动任务仍停在 `AWAITING_COMMIT`。

## 5. 兼容与存储

- SQLite 表结构未变化；新增元数据仍在 schemaVersion 1 的 JSON payload 中。
- 历史 checkpoint 没有模式/授权字段时可正常读取；下一次未完成任务运行时惰性补写。
- 已完成的历史 checkpoint 仍会检查 immutable Ledger 摘要，但不会因缺少新字段而增加 revision 或重复副作用。
- Store 对新元数据做写入和读取双向校验；损坏的模式或授权会被拒绝。

## 6. 失败原因

| Reason code | 含义 | 操作建议 |
|---|---|---|
| `INVALID_EXECUTION_MODE` | 未知执行模式 | 修正调用方版本或配置 |
| `PUBLICATION_AUTHORIZATION_REQUIRED` | 发布模式没有授权 | 从 Commit/Policy Gate 重新提交 |
| `UNEXPECTED_PUBLICATION_AUTHORIZATION` | 非发布模式夹带授权 | 移除授权或使用正确模式 |
| `INVALID_PUBLICATION_AUTHORIZATION` | 授权为空、超限或 shape 错误 | 重新生成有界稳定授权 |
| `PUBLICATION_AUTHORIZATION_CONFLICT` | 部分发布后更换授权 | 使用原授权继续，或人工治理该 work |

## 7. 验证证据

- 默认 Preview 与显式 Policy Evaluation 均不产生 Markdown、Registry、Index 写入。
- Preview→显式 Commit 复用同一 checkpoint，并只执行未完成阶段。
- 缺失/非法授权在创建 work 或发布前 fail closed。
- 部分发布后低权限调用不继续 Index，也不能重置 terminal publication stage。
- 部分发布后更换授权被拒绝，原授权可继续恢复。
- `SAFE_POLICY` 授权、旧 awaiting checkpoint 和旧 completed checkpoint 均有回归测试。
- P2 Worker 测试验证 Preview 与 Commit 的真实 mode/authorization 参数。
- 全仓回归在本模块收尾时执行，并受 85% 分支覆盖率门禁保护。

## 8. 已接受限制

`PREVIEW_ONLY` 与 `POLICY_EVALUATION` 当前都在 `CANDIDATE_POLICY` 后暂停，因为现有 Worker 尚未拆出 USER_COMMITMENT、EVOLUTION_MATCH 与 POLICY_DECISION 独立阶段。M3/M4 接入后会移动两个模式的阶段上限，但发布授权门禁和 checkpoint 续跑语义不变。
