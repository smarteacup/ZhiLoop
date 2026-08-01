# CKL-304 Evidence Policy Engine

## 1. 目标与边界

`@zhiloop/evidence-policy` 消费 Candidate、当前状态、Scope、CKL-303 VerificationResult、版本化 VerificationPolicy 和冲突信号，输出唯一、冻结、可审计的 `EvidencePolicyDecision`。它负责合法状态迁移路径、自动发布意图、GLOBAL 晋升和至多一次 ASK_USER 交互决策。

本模块不验证源码事实、不持久化状态、不写 Markdown/SQLite、不调用模型，也不执行命令。Verifier 负责“事实是否成立”，Policy 负责“这些事实允许知识达到什么状态”，后续 Registry 负责原子保存决策。

## 2. 决策契约

```ts
interface EvidencePolicyDecision {
  action: "APPLY" | "KEEP" | "ASK_USER";
  interaction: "NONE" | "ASK_USER";
  currentStatus: KnowledgeStatus;
  targetStatus: KnowledgeStatus;
  transitionPath: readonly KnowledgeStatus[];
  effectiveScope: KnowledgeScope;
  shouldPublish: boolean;
  evidenceIds: readonly string[];
  reasonCodes: readonly string[];
}
```

`action` 表示状态操作，`interaction` 独立表示是否需要微确认，因此可以在项目 Scope 自动发布，同时只询问是否进一步晋升 GLOBAL。`transitionPath` 由 Domain 状态机做 BFS 生成并逐边复核，例如 PROPOSED 到 VERIFIED 必须经过 `[IMPLEMENTED, VERIFIED]`，不能直接跳级。

`shouldPublish` 只在本次存在合法状态变化且目标为 ACCEPTED/IMPLEMENTED/VERIFIED 时为 true；幂等重算不会重复发布。所有 Evidence ID 去重排序，包含本项目 Verification Evidence 和跨项目 Evidence Ref。

## 3. 自动状态策略

优先级如下：

1. 非法输入失败关闭：KEEP、PROJECT fallback、不发布。
2. REJECTED/SUPERSEDED 终态保持，不反复询问。
3. 已支持的 USER_ACCEPTED 与 USER_REJECTED 冲突，或已有知识冲突：ASK_USER，不迁移。
4. USER_REJECTED 受支持：仅沿 Domain 合法路径进入 REJECTED；已 IMPLEMENTED/VERIFIED 时不能非法回退，改为 ASK_USER。
5. 任一 Assertion REFUTED：PROPOSED 保持；已发布状态进入 ASK_USER，不把 REFUTED、UNKNOWN、ERROR 混为一谈。
6. IMPLEMENTATION 满足配置的全部 required Assertion：最高 IMPLEMENTED，即使同时存在 TEST_PASSED 也不能自动 VERIFIED。
7. EXPERIENCE 满足全部 required Assertion（默认 TEST_PASSED）：可经 IMPLEMENTED 到 VERIFIED。
8. 只有 USER_ACCEPTED：到 ACCEPTED。
9. 无上述 Evidence：MODEL_ONLY_REMAINS_PROPOSED。

配置门禁不能被调用方削弱：IMPLEMENTATION 必须包含 SYMBOL_EXISTS 且 maxStatus 固定 IMPLEMENTED；EXPERIENCE 必须包含 TEST_PASSED 且 maxStatus 固定 VERIFIED；每 Turn 问题上限固定 1，默认 Scope 固定 PROJECT。

ERROR 不生成 Evidence，也不等于否定；UNKNOWN 只表示证据不足。两者会进入 machine-readable reason codes，但不会推进状态。

## 4. GLOBAL 晋升

GLOBAL 决策执行双重约束：

- CKL-302 已把 path/symbol/项目名等特征记录为 `projectSpecificSignals`；
- CKL-304 再调用 Domain `evaluateGlobalPromotion`，执行 RULE/PREFERENCE 显式批准、项目特征、跨项目阈值门禁。

跨项目输入不是裸 `string[]`，而是：

```ts
interface VerifiedProjectEvidenceRef {
  projectId: string;
  subjectKey: string;
  evidenceId: string;
  sourceRef: string;
  observedAt: string;
}
```

只有 subjectKey 与当前 Candidate 相同、字段合法、项目去重后达到 `minVerifiedProjects` 才计数。显式用户 GLOBAL 批准仍走 Domain 规则；未通过时 effectiveScope 降级 PROJECT，不丢弃已验证项目知识。

为了减少打扰，GLOBAL 不足只在知识已具备 ACCEPTED/IMPLEMENTED/VERIFIED 发布资格时触发 ASK_USER；模型输出仍是 PROPOSED 时静默 PROJECT fallback。

## 5. 输入完整性与故障关闭

Policy 在任何状态计算前验证：

- Candidate 必须保持 PROPOSED，Assertion ID 唯一且 candidateId 一致；
- VerificationResult 不得重复、越出 Candidate 或错报 Assertion kind；
- status 与 Evidence verdict 必须对应，ERROR 不得携带 Evidence；
- Evidence assertionId/type/projectId/correlationId/source/time 必须与当前 Candidate/Project 一致；
- resolvedScope 的项目坐标不得跨越 projectScope；
- conflictId、project signal、跨项目 Evidence Ref 和策略边界合法；
- 运行时 malformed JS 输入也被 catch 为 INVALID_EVIDENCE_POLICY_INPUT，不抛出后台批次。

输入错误统一保留当前状态、关闭发布、回退 PROJECT。策略输出递归冻结。

## 6. 状态保持与交互

- REJECTED/SUPERSEDED 是终态，重算固定 KEEP。
- STALE 只有重新满足 VERIFIED Evidence 才能沿状态机恢复；否则保持 STALE，不靠模型或旧接受信号复活。
- 已有状态高于本轮可证明目标时保持原状态，不做隐式降级。
- adoptionAmbiguous 只在没有确定性 Evidence 可推进时询问，避免代码/测试已闭环仍打扰用户。
- project/global scope 询问与知识冲突共用单一 `interaction=ASK_USER`，上层每 Turn 最多生成一个问题。

## 7. 验证与性能

- 15 条专项测试覆盖 model-only、用户接受/拒绝冲突、IMPLEMENTED 上限、VERIFIED 路径、ERROR/UNKNOWN/REFUTED、终态/STALE、GLOBAL 阈值与显式批准、延迟询问、配置攻击和 malformed Evidence。
- 2 条 Node 架构/Gate 测试串联真实 Project Identity、Scope Resolver、七类 Registry/Verifier 和 Evidence Policy，验证模型、代码、测试、GLOBAL 四条端到端门禁。
- Evidence Policy Lines 97.12%、Branches 92.26%、Functions 100%、Statements 92.17%。
- 全仓 330 条模块测试、33 条架构/Gate 测试通过；整体 Lines 96.93%、Branches 90.20%。
- 20 组、每组 10,000 次 IMPLEMENTATION 决策：中位 14.977ms、P95 17.758ms，约 667,698 decisions/s。
- npm 官方 registry 审计：0 vulnerabilities。

## 8. 已知边界

- 本模块只输出决策；Candidate/Asset/Markdown/SQLite 的原子状态与发布提交由 CKL-401 及 Registry 编排实现。
- `conflictIds` 来自后续 subject/relation 冲突检测器；Policy 只执行“有冲突则询问”的稳定门禁。
- VerifiedProjectEvidenceRef 必须由可信跨项目聚合器生成，不能由模型直接构造。
- CKL-305 才负责代码指纹变化、STALE 触发和重新验证调度。
- 当前未安装 Hook、未启动 Daemon，也未读写 `~/.ckl`、`~/.codex` 或 `~/.ccm`。
