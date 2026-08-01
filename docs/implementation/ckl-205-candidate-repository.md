# CKL-205 Candidate Repository

## 1. 目标与边界

`@zhiloop/candidate-repository` 为 Knowledge Compiler 提供不可重建的 SQLite 候选批次存储。Repository 在模型执行前原子 claim 编译身份，在 Runner 返回后原子保存整个结果，从而覆盖：

- 相同编译身份不重复调用模型；
- Compiler/Prompt 版本变化产生新批次并保留旧批次；
- `RETRYABLE` 可重新领取，`FAILED` 和 `SUCCEEDED` 默认不重跑；
- Candidate 默认不进入正式召回。

本模块不执行模型、不构建 Episode、不验证代码断言、不发布 Markdown、不建立 FTS/Vector 索引，也不推进 Candidate 状态。

## 2. 编译身份与批次

Repository 复用 CKL-202 的身份：

```text
extractionKey = SHA256(
  episodeId,
  builderVersion,
  inputHash,
  compilerVersion,
  promptVersion
)
```

`candidate_compilations.extraction_key` 是主键，并对 `episodeId + builderVersion + inputHash + compilerVersion + promptVersion` 再加唯一约束。`requestedAt` 和 correlationId 不参与身份，因此同一语义请求以不同运行时间重放仍命中旧批次；改变 Compiler、Prompt、Builder 或终态 Episode 内容会产生独立历史批次。

批次状态为：

```text
RUNNING -> SUCCEEDED
RUNNING -> RETRYABLE -> RUNNING
RUNNING -> FAILED
```

每个批次保留版本、inputHash、runCount、Runner attempts、失败原因、结构化诊断和时间。成功 Candidate 以 ordinal 保持原子批次顺序。

## 3. Claim、租约与 fencing

只在保存结果时去重无法阻止两个 Worker 同时调用模型，因此调用顺序必须是：

```ts
const claim = repository.claim(request);
if (claim.status !== "ACQUIRED") return claim;
const result = await runKnowledgeExtraction(request, compiler);
repository.saveResult(claim.claimToken, result);
```

Claim 在 `BEGIN IMMEDIATE` 事务内读取并更新批次。返回类型：

| 状态 | 行为 |
|---|---|
| `ACQUIRED` | 当前 Worker 获得租约，可以编译 |
| `IN_PROGRESS` | 另一 Worker 的租约仍有效，不重复执行 |
| `ALREADY_SUCCEEDED` | 已有完整批次，直接复用 |
| `TERMINAL_FAILED` | 终态失败，不自动重跑 |

默认租约 5 分钟，最大 1 小时。长任务可调用 `renewClaim`；租约过期后新 Worker 可接管。claim token 不是直接保存随机源，而是绑定 `extractionKey + runCount + entropy` 的 SHA-256 fencing token，即使随机源重复返回相同文本，不同 generation 也得到不同 token。旧 Worker 在接管后回写会被拒绝。

同一 SQLite 文件的多个 Repository 连接通过写事务串行 claim；Candidate Repository 使用独立 `candidate_repository_meta` Migration 版本，不修改 CKL-103 Event Ledger 的 `PRAGMA user_version`，两者可以共用同一数据库。

## 4. 原子保存和完整性

`saveResult` 在事务前完成 Runner 结果和 Candidate Schema 校验，在单个事务中插入全部 Candidate 并推进批次状态。任一 Candidate ID 冲突、Schema 错误或数据库失败都会回滚全部插入，批次保持 RUNNING，不能出现“部分成功”。

运行时门禁额外拒绝：

- 非法 result status、failure reason、attempts 或 diagnostics；
- 失败结果携带 Candidate，或成功结果携带 diagnostics；
- Candidate compilerVersion/sourceEpisodes 与批次不一致；
- 批内重复 candidateId、超过 10,000 条或规范化 JSON 超过 16,000,000 字符；
- 未 claim、过期 generation 或错误 token 的结果。

Candidate JSON 保存 SHA-256；读取时重新执行 Candidate Schema，并核对 candidateId、status、subjectKey、kind、compilerVersion、createdAt 等冗余索引列。JSON、hash 或索引列被外部修改会 fail closed，不返回伪造 Candidate。数据库文件在非 Windows 平台设为 `0600`。

## 5. 默认不召回

Candidate 表当前只允许 `status='PROPOSED'`。`listCandidates()` 默认增加：

```sql
c.status <> 'PROPOSED'
```

因此普通查询返回空数组；只有管理、审计或后续 Evidence 流程显式传入 `includeProposed: true` 才能读取候选。正式 Retrieval 后续只消费 `ACCEPTED/IMPLEMENTED/VERIFIED` Knowledge Asset，不直接消费 Candidate Repository。

## 6. 验证与性能

- 15 条 Repository 专项测试覆盖幂等 claim、版本并存、重试/终态、续租、过期接管、跨连接竞争、重复熵 fencing、原子回滚、身份/结果门禁、持久化重开、权限、损坏检测和新版本 Migration 拒绝。
- 2 条 Node 架构/Gate 测试覆盖无模型/检索/发布依赖，以及 Event Ledger + Repository 共库的 `claim → compile → save` 端到端流程。
- Repository Lines 95.16%、Branches 92.46%、Functions 100%、Statements 92.95%。
- 全仓 274 条模块测试、23 条架构/Gate 测试通过。
- Node.js 25.8.1，100 Candidate、30 次写样本：中位 1.87ms、P95 2.18ms；100 Candidate 管理读取 50 次：中位 1.19ms、P95 1.37ms。
- npm 官方 registry 审计：0 vulnerabilities。

## 7. 已知边界

- Repository 只提供 claim/renew/save 原语；Daemon Worker 的续租定时器和崩溃恢复循环尚未装配。
- 成功批次读取会重新校验 Candidate JSON，保证完整性但增加 CPU；当前 100 Candidate P95 1.37ms。超大管理查询应分页，不能提高 1,000 条硬上限规避分页。
- Candidate 数据按 ADR-0002 是不可重建事实，目前没有备份、导出、保留期或修复 CLI；这些属于后续运维模块。
- 当前没有 Candidate 生命周期更新 API；Evidence Engine 会生成后续状态/Asset，而不是绕过 Schema 修改 PROPOSED payload。
- SQLite 提供文件权限和数据完整性检查，不提供应用层加密；磁盘加密与密钥管理属于部署策略。
- 本模块未安装 Hook、未启动 Daemon，也未读写 `~/.ckl`、`~/.codex` 或 `~/.ccm`。
