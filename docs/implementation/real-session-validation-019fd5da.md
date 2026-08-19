# 真实会话链路验证：019fd5da-9272-7261-9467-66e07ce46bbd

## 验证结论

2026-08-19 使用本机 Codex 会话 `019fd5da-9272-7261-9467-66e07ce46bbd` 完成了从 Ledger、不可变快照、候选编译、代码证据验证到 Candidate Preview 的真实链路验证。运行版本为 `0.4.15`，模式为 `SHADOW + PREVIEW_ONLY`。

链路最终状态为 `AWAITING_COMMIT`，共生成 5 条候选。系统没有自动发布：2 条候选存在被代码证据否定的断言，3 条候选证据不足。这是证据门禁的预期结果，不应通过人工提交绕过。

## 真实数据标识

- Session：`019fd5da-9272-7261-9467-66e07ce46bbd`
- Snapshot：`snapshot_1601ad8f2bdadca21373edd7cde392e009ce6b1da1cf4519`
- Candidate Preview Job：`job_3d0704bc-f3a6-495c-bd0b-c8ab1b02fb15`
- Ledger：202 个事件、19 个 Turn，游标 1019 行 / 5,734,503 bytes
- 项目：`/Users/workspace/java/black-hole`
- Project ID：`31d273b99065cb52e0ad1a076f01e6c99bcf88813403b7ed17a25e44b5d7ffa2`
- Remote：`git.xiaojukeji.com/Empyrean-Service/black-hole`
- Branch：`master`

## 本次统一修复的问题

| 问题 | 根因 | 修复与回归 |
|---|---|---|
| 大型 Codex transcript 无法稳定采集 | 单行上限和游标持久化不足 | 支持 4 MiB 单行、持久化 byte offset，并覆盖大型会话与增量采集 |
| Ledger 自增 ID 存在间隙时读取不完整 | 把行数当作连续 sequence | 读取逻辑以真实 sequence/cursor 为准，并覆盖 AUTOINCREMENT 间隙 |
| 手动提取遇到已有快照时没有提升任务优先级 | coordinator 在 `CURRENT` 分支提前返回 | `CURRENT` 快照仍执行幂等 enqueue；真实任务优先级从 0 提升到 20 |
| 自动任务挤占人工任务 | 任务没有持久化优先级和全局容量约束 | 增加 BACKGROUND/NORMAL/INTERACTIVE 优先级、数据库迁移、索引和公平调度 |
| 会话内代码项目归属错误 | 使用会话级默认目录，没有读取结构化工具上下文 | 从 `projectPath/workdir/cwd` 解析 Episode 项目，使用规范 Project Identity |
| CodeGraph 更新导致代码版本假漂移 | Git dirty fingerprint 包含 `.codegraph`/`.zhiloop` 生成物 | Git pathspec 排除 ZhiLoop/CodeGraph 生成目录，并用真实 Git 仓库回归 |
| 证据验证频繁超时 | 总验证窗口与 CodeGraph 单查询窗口过小 | 验证下限提高到 5 秒，CodeGraph 默认单查询窗口调整为 2 秒 |
| 重试时报验证请求 ID 冲突 | 请求 ID 未绑定实际观测到的代码/图版本 | verification identity v2 纳入 code revision、capability 和 graph signature |
| 升级误判服务无法停止 | 等待窗口贴近 launchd 的 5 秒退出边界 | bootout 最多等待约 10 秒，并覆盖延迟停止回归 |
| 升级误判服务未就绪 | 默认 readiness 仅 15 秒 | readiness 有界窗口扩展到 30 秒，并覆盖第 70 次探测才就绪的回归 |
| 页面仍出现英文证据/策略枚举 | 通用 StatusBadge 和 P2 reason map 不完整 | `CONTRADICTS`、`INCONCLUSIVE` 及真实策略原因统一中文化，原始码保留在 title/诊断信息中 |

## 候选结果

1. `Add extra as a nullable file-level field without special null suppression`：存在被代码证据否定的断言。
2. `master_ibg common-add writes t_video_file shards`：存在被代码证据否定的断言。
3. `common-add expects a nested camelCase request`：自动发布所需断言不完整，证据验证结果不确定。
4. `file_size is measured in bytes`：自动发布所需断言不完整，证据验证结果不确定。
5. `Roll out the extra column before application and caller changes`：仅有模型结论，证据验证结果不确定。

以上候选均保留为 `PROPOSED`，不进入召回。控制台可查看候选正文、可执行断言、用户承诺、演进决策和双向追溯。

## 验证证据

- 60 个脚本级 Gate 通过。
- 202 个 Vitest 文件、1,711 项测试通过。
- 覆盖率：Statements 90.01%、Branches 85.03%、Functions 92.24%、Lines 93.88%。
- 本机 `zhiloop doctor` 六项检查通过，版本 `0.4.15`、模式 `SHADOW`。
- 真实任务最终为 `SUCCEEDED`，checkpoint 为 `AWAITING_COMMIT / PREVIEW_ONLY`。
- 控制台真实验收确认：候选阶段成功；证据结论显示为“存在矛盾”或“证据不足”；策略原因全部中文显示。

## 安全边界

本次验证没有执行“明确提交策略并发布”。原因是当前候选没有满足发布证据门禁。后续应先修正被反证的候选或补齐可执行证据，再重新生成/验证；不应为了跑通演示而把不可靠候选写入知识库。
