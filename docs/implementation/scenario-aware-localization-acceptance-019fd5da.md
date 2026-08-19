# 场景化知识定位与维护验收报告

**日期**：2026-08-20  
**会话**：`019fd5da-9272-7261-9467-66e07ce46bbd`  
**运行版本**：ZhiLoop `0.5.1`，`SHADOW + PREVIEW_ONLY`  
**快照**：`snapshot_6fc5e9798b8602d966aa19ba5da0b61ec2eff5b85fa65e13`，`mvp-compiler-v5`

## 1. 验收结论

真实会话已从 Ledger 生成不可变快照并完成新版知识提取、权威项目定位、证据校验和 Candidate Preview。新版共生成 4 条候选；4 条均保持 `PROPOSED`，没有写入可召回知识，也没有绕过显式提交门禁。

每条 v2 Candidate 均包含：

- 项目 ID、仓库 remote、观测分支、Git commit 和 dirty 状态；
- claim mode；
- 场景 ID/key、标题、摘要、任务意图和入口；
- 适用与不适用边界、模块路径和符号；
- 每条 Assertion 的验证状态、原因码及可用的 CodeGraph Artifact。

候选页 API 和界面已补齐以上信息。旧版 Candidate 没有定位时会明确显示为“旧版候选缺少定位”，不会伪造项目或 revision。

## 2. 权威定位

本次 4 条候选均由系统从会话项目根目录解析相同的权威坐标，而不是接受模型生成的 Git 信息：

| 字段 | 值 |
|---|---|
| projectId | `31d273b99065cb52e0ad1a076f01e6c99bcf88813403b7ed17a25e44b5d7ffa2` |
| repositoryRemote | `git.xiaojukeji.com/Empyrean-Service/black-hole` |
| observedBranch | `master` |
| observedCommit | `d1bbeb1b3f57d63311ed0b6768e863dbe1b327d0` |
| dirty | `false` |

## 3. 候选与证据门禁

| 候选 | 模式 / 场景 | 证据结果 | 策略结论 |
|---|---|---|---|
| extra 采用可空列直接透传的最小改造 | `USER_DECISION` / `file-ingestion.extend-extra-field` | 目标文件不存在；这是未来实现尚未落地，不用于反驳用户决策 | `PENDING_IMPLEMENTATION`，保持候选 |
| common-add 的固定与条件 PublicLog | `CURRENT_STATE` / `file-ingestion.audit-publiclog` | 两个文件字面量均未找到 | `ASSERTION_REFUTED`，禁止发布 |
| 当前主线 common-add 写入 t_file_detail 分表 | `CURRENT_STATE` / `file-ingestion.trace-persistence` | Mapper 字面量支持；调用链在有界 CodeGraph 搜索内无法证明 | `VERIFICATION_UNKNOWN`，禁止发布 |
| master_ibg common-add 写入 t_video_file 分表 | `CURRENT_STATE` / `file-ingestion.inspect-legacy-branch` | 调用链无法证明，目标文件不存在 | `ASSERTION_REFUTED`，禁止发布 |

第四条描述历史 `master_ibg`，但当前权威观测分支是 `master`。系统没有把对话文字中的分支名冒充为已验证坐标；该 Candidate 因证据冲突留在 Preview。要让它成为可召回的当前代码事实，必须在 `master_ibg` 对应 worktree/revision 上重新提取或提供可验证的分支证据。

### 门禁思路

1. 模型只负责提出结论、claim mode 和场景提示，不得提供 project/branch/commit。
2. 系统从 Git 解析权威坐标，生成 KnowledgeLocator。
3. `CURRENT_STATE` 必须由当前代码、CodeGraph、配置或测试证据支持。
4. `USER_DECISION/FUTURE_REQUIREMENT` 的代码尚未实现记为 `PENDING_IMPLEMENTATION`，不能错误地推翻已确认需求。
5. `REFUTED/UNKNOWN/INVALID_ASSERTION` 均不发布；只有策略、证据、新鲜度和显式提交同时通过才进入 Registry 与召回。

## 4. 场景维护与腾讯方案映射

参考 TencentDB Agent Memory 的 `L0 Conversation → L1 Atom → L2 Scenario → L3 Persona`，ZhiLoop 使用以下维护动作：

| 新输入与已有内容关系 | 动作 |
|---|---|
| 新 subject / 新场景 | `CREATE / STORE` |
| 同一场景内容变化 | 创建新版本并 `UPDATE_VERSION / SUPERSEDE` |
| 边界兼容的补充内容 | `MERGE_VERSION / SUPPLEMENT` |
| 重复或无持久价值 | `SKIP` |
| 项目、分支、入口或排除边界冲突 | `KEEP_SEPARATE / PENDING` |

场景是可重建的 Markdown + SQLite 投影；Knowledge 和 Ledger 历史不被覆盖。任何高层场景都能向下追溯到知识版本、Episode 与原始对话。

## 5. 召回与注入模拟

本次真实 Candidate 均未通过发布门禁，因此真实检索正确返回“不可召回”，没有为了演示而强制提交。确定性测试覆盖了后续发布后的完整行为：

| 查询条件 | 预期与结果 |
|---|---|
| 同 project + 兼容 branch/commit + 命中 scenario | Candidate 通过硬过滤并进入场景目录 |
| 不同 project | `LOCATOR_PROJECT_FILTERED`，不暴露知识身份 |
| 不兼容 branch/commit 或 dirty 状态 | `BRANCH_FILTERED / COMMIT_FILTERED / DIRTY_REVISION_FILTERED` |
| 未选择场景 | 只保留 L1 指针，不展开正文 |
| 明确选择匹配场景 | 仅该场景允许展开 L2/L3，仍受 token 预算限制 |
| CodeGraph Artifact revision 兼容 | 复用有界 Artifact |
| project/code/graph revision 或依赖变化 | Artifact 转为 `SUSPECT`，重新查询 |

对应回归位于：

- `packages/retrieval-engine/src/engine.test.ts`
- `packages/context-orchestrator/src/orchestrator.test.ts`
- `packages/code-intelligence/src/artifact.test.ts`
- `packages/knowledge-evolution/src/scenario-evolution.test.ts`
- `packages/p3-console-runtime/src/runtime.test.ts`

## 6. 本轮发现并修复的问题

1. Candidate 的 Locator 已保存在 Worker Checkpoint，但会话预览 API 未返回。现已补充严格契约、Sidecar 映射和中文界面。
2. 候选页只有总 Evidence verdict，无法理解具体门禁。现已展示每条 Assertion 的状态、原因码和 CodeGraph Artifact 摘要。
3. 2 秒 CodeGraph 调用链搜索耗尽时被归类为 provider unavailable。现改为 `CODEGRAPH_TRACE_BOUNDED`，准确表达“在安全边界内未证明”，并保持 fail closed。
4. 端到端验证总预算过紧导致真实任务两次 `VERIFICATION_DEADLINE_EXCEEDED` 后才成功。预算改为至少 15 秒，并随单次 CodeGraph 预算扩展、最高 60 秒。

## 7. 安全边界与后续项

- 自动发布仍关闭；本次未提交 4 条有问题的候选。
- 静态 CodeGraph 无法证明动态分派时返回 `UNKNOWN`，不能把“没找到静态路径”当作运行链路不存在。
- 跨分支历史事实应在目标 worktree/revision 上重提取；当前不从自然语言猜测分支权威性。
- 完整 Git ancestry provider 接入前，跨提交扩大适用范围继续 fail closed。

本机 `zhiloop doctor` 六项检查均通过，版本 `0.5.1`，运行模式 `SHADOW`。
