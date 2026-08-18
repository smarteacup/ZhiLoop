## Context

Commitment Detector 只接受 CLOSED/ABANDONED Episode，验证 statement/correction 均在 Episode evidenceRefs 内，并通过 source reference、主题唯一匹配或单一 proposal 判断目标。多目标结果只生成 ambiguity。`applyUserCommitments` 只添加 `USER_ACCEPTED`/`USER_REJECTED` assertion，Candidate 仍保持 `PROPOSED`，最终状态由 Evidence Policy 决定。

## Goals / Non-Goals

**Goals:**

- 生产 Worker 使用已有检测器，不复制自然语言规则。
- 承诺阶段可 checkpoint、可重放、无模型调用。
- 接受不能直接升级到 IMPLEMENTED/VERIFIED；否定不物理删除 Candidate。
- 纠正、歧义和编译身份完整保留，供 M4/控制台处理。

**Non-Goals:**

- 不根据纠正文案自动生成新的知识正文。
- 不在本模块决定 SUPERSEDES/CONTRADICTS 的最终关系。
- 不自动解决多候选歧义。

## Decisions

### 1. 新增 USER_COMMITMENT checkpoint stage

阶段顺序为 `COMPILE → USER_COMMITMENT → CANDIDATE_POLICY`。执行时对排序后的 Episode 分别调用 `detectUserCommitments(episode, candidates)`，按稳定 signalId 聚合，再调用一次 `applyUserCommitments`。成功后同时保存原始检测结果、纠正草稿和 enrich 后 Candidate。

历史未完成 checkpoint 的 `stages.USER_COMMITMENT` 缺失时按 PENDING 处理；已经 `COMPLETED` 的历史 work 直接返回，避免发布重放。

### 2. 歧义 fail closed

`ambiguities` 只进入 checkpoint，不添加 assertion。目标无法唯一解析的接受/否定不能改变 Candidate Policy。后续控制台可以用 statementRef、turnId 和 candidateIds 让人处理。

### 3. 纠正形成关系草稿，不推断正文

```ts
interface CandidateCorrectionDraft {
  draftId: string;
  signalId: string;
  candidateId: string;
  relationHint: "CONTRADICTS";
  originalRef: string;
  originalStatement: string;
  correctedRef: string;
  correctedStatement: string;
  occurredAt: string;
}
```

一个已解析目标生成一个 deterministic draft。M4 使用它决定 CONTRADICT、SUPERSEDE 或人工确认。不能在没有新 Candidate 正文和 Evidence 的情况下伪造版本。

### 4. Candidate provenance 绑定四类版本

Worker 从 `runKnowledgeExtraction` 的成功结果保存 `extractionKey/inputHash/episodeId/builderVersion/compilerVersion/promptVersion`，并附加 request 的 `policyHash`。`policyHash` 加入 immutable work identity；P2 使用 Snapshot policyHash。相同 candidateId 若对应不同 provenance，Worker fail closed。

### 5. 错误分类

Detector 输入或聚合冲突作为不可重试 `USER_COMMITMENT_INVALID` 保存到该阶段。它不会使 Ledger、Episode 或已编译 Candidate 丢失；修复源代码/数据后需要新 Snapshot 或 operator repair。

## Risks / Trade-offs

- Detector 使用保守词法规则，可能漏掉隐式承诺；漏掉只保持 PROPOSED，比错误确认安全。
- 新阶段改变 stages shape；运行时对缺失 stage 使用 PENDING，Store 继续兼容旧 JSON。
- 纠正暂不生成正文；关系草稿确保信息不丢，M4 再做受证据约束的演进决定。

## Migration Plan

1. 增加 DTO、policyHash identity 和 legacy stage 兼容。
2. 接入检测/应用阶段和 provenance 聚合。
3. 更新 P2 composition 与真实 Worker 测试。
4. 全量 Gate 后默认生效，无数据库 migration。

## Open Questions

无阻塞问题。纠正草稿的最终关系和版本发布由紧接的 M4 实现。
