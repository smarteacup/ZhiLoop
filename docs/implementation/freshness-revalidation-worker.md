# M8 Freshness ChangeSet 复验 Worker

该 Worker 把“代码可能变化”转换为可审计的 Freshness 状态，而不是直接改写知识正文。

```text
ChangeSet -> Anchor lookup -> one revision batch verify
-> invalidation plan -> CAS freshness state + immutable event
```

REFUTED 只产生 `CONFLICT + MARK_STALE` 修复建议；真正的新知识生命周期版本仍需治理/发布门禁。

存储分为三层：不可变 publication projection、每个资产版本一条 CAS current state、不可变 transition events。升级时会为既有 projection 确定性补出 revision 0 的 FRESH 状态。

Verifier 一次接收所有受影响资产和 assertion ID，必须返回相同 `projectId + codeRevision + graphRevision`。缺失、重复、未请求、Assertion 类型错误、Evidence 跨项目或观察时间不一致都会在第一条状态写入前失败。

Worker 自身不执行测试、不改知识正文、不自动发布 STALE 版本。它输出 body-preserving repair plan，供后续调度器、控制台或治理服务消费。
