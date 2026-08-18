# 用户承诺编译（M3）实施说明

## 1. 实施结果

生产 Knowledge Worker 已接入现有承诺检测器，新增可恢复的 `USER_COMMITMENT` 阶段：

```text
COMPILE
  → USER_COMMITMENT
  → CANDIDATE_POLICY
  → publication gate
```

模型仍只能产生 `PROPOSED` Candidate。用户接受、否定和纠正必须经过 Episode evidence 与确定性目标解析，才能影响后续策略。

## 2. 安全边界

Worker 会先移除模型生成的 `USER_ACCEPTED` / `USER_REJECTED` assertion，再运行确定性 Detector。这样模型不能通过“声称用户已经同意”把自己生成的结论升级。

- 唯一解析的接受：重新生成带 statementRef 的 `USER_ACCEPTED` assertion。
- 唯一解析的否定：生成 `USER_REJECTED` assertion；Candidate 不删除。
- 多个可能目标：只保存 ambiguity，不添加 assertion。
- 无法解析：保持 PROPOSED，不猜测目标。
- 移除不可信 commitment 后若 Candidate 连 assertion/evidenceHint 都没有：以 `CANDIDATE_GROUNDING_REMOVED` fail closed。

Detector 使用 source reference、明确主题和单一 proposal 三层确定性规则；输入必须来自 CLOSED/ABANDONED Episode，所有 statement/correction reference 必须存在于 Episode evidenceRefs。

## 3. 纠正处理

纠正信息不会被拼接成新的知识正文。每个已解析目标形成关系草稿：

```ts
{
  draftId,
  signalId,
  candidateId,
  relationHint: "CONTRADICTS",
  originalRef,
  originalStatement,
  correctedRef,
  correctedStatement,
  occurredAt
}
```

草稿和原始 correction signal 一起进入 checkpoint。M4 会据此决定 `CONTRADICT`、`SUPERSEDE` 或人工确认；未解析纠正只保留 signal，不自动建立关系。

## 4. Candidate provenance

每个 Candidate 保存一条有界 provenance：

- `candidateId`
- `extractionKey`
- `inputHash`
- `episodeId`
- `builderVersion`
- `compilerVersion`
- `promptVersion`
- `policyHash`

`policyHash` 从 P2 immutable Snapshot 进入 Worker request，并加入 work identity。同一 work 更换 policy hash 会产生 `WORK_IDENTITY_CONFLICT`。provenance 只投影上述 8 个字段，不复制 compiler result、Candidate 正文或 diagnostics，避免 checkpoint 体积成倍增长。

## 5. Checkpoint 与兼容

- 新 work 的 `WORKER_STAGES` 包含 `USER_COMMITMENT`。
- 历史未完成 checkpoint 缺少该 key 时视为 PENDING；使用已保存 Episode/Candidate 补跑。
- 历史 Candidate provenance 可从唯一 source Episode、compiler/prompt 和 policy identity 确定性重建。
- 已完成历史 checkpoint 仍直接回放，不新增阶段、不改 revision、不重复发布。
- 该阶段成功后，后续 Policy/Publication 重试只读取已 enrich Candidate，不重复检测。

## 6. 失败原因

| Reason code | 含义 | 是否重试 |
|---|---|---|
| `INVALID_POLICY_HASH` | Worker request 的 policy identity 非法 | 否 |
| `CANDIDATE_PROVENANCE_COLLISION` | 同一 candidateId 对应不同编译输入/版本 | 否 |
| `CANDIDATE_PROVENANCE_UNRESOLVED` | 旧 Candidate 无法唯一映射到 Episode | 否 |
| `USER_COMMITMENT_COLLISION` | 相同 signalId 内容不一致 | 否 |
| `USER_COMMITMENT_INVALID` | Episode/correction/聚合输入不满足追溯约束 | 否 |
| `CANDIDATE_GROUNDING_REMOVED` | 只剩模型自报承诺且没有其他可信 grounding | 否 |

不可重试失败保留此前 Ledger、Episode、原始 Candidate 和 provenance checkpoint，Codex 主流程不受影响。

## 7. 验证证据

- 唯一接受和唯一否定均在 Policy 前生成可追溯 assertion。
- 两个 proposal 的泛化“按这个做”只形成 ambiguity。
- 模型自报接受、但用户没有接受时，assertion 被移除且不会产生发布 outbox。
- correction 生成 `CORRECTION + USER_REJECTED` signal 和 deterministic `CONTRADICTS` draft。
- 历史缺 stage/provenance checkpoint 可补跑，随后 replay 不增加 attempt/revision。
- policy hash 变化与非法 policy hash fail closed。
- P2 Console 真实 `snapshot → preview → commit → governance → index recovery` 回归通过。
- 针对性测试完成后执行全仓 dependency/lint/build/typecheck/test/coverage Gate。

## 8. 已接受限制

Detector 有意保守，隐式同意可能继续保持 PROPOSED。漏掉承诺可在控制台处理；错误自动确认会污染正式知识，因此不能用宽松模型猜测替代确定性门禁。纠正的最终关系和新版本正文由 M4 演进模块负责。
