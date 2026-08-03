# CKL-706：本地 sidecar 与可回滚部署

## 1. 结论

CKL-706 实现了从源码基线到可执行部署的缺口：`apps/sidecar` 提供 Unix socket transport、Hook fail-open、健康检查与 worker；`packages/local-deployment` 提供不可变发行、部署事务、Codex/CCM 共存、LaunchAgent、doctor、升级回滚和可恢复卸载。

首个发行只允许 SHADOW。当前组合会将规范化、脱敏后的 Codex Hook 事件写入 SQLite ledger，并始终返回空的模型可见上下文。完整知识编译与 ACTIVE 注入沿用既有领域模块，但不在部署时自动启用。

## 2. 模块边界

| 模块 | 责任 | 明确不负责 |
|---|---|---|
| `apps/sidecar` | CLI、Unix socket、Daemon 组合、ledger/spool、隐私日志 | 主机文件所有权与 launchd 事务 |
| `packages/local-deployment` | release、plan/apply/rollback、Hook receipt、LaunchAgent、doctor/uninstall | 知识抽取、检索与闭环语义 |
| `packages/plugin-runtime` | Hook merge/unmerge 与版本兼容 | 安装路径和服务管理器 |
| `packages/daemon-runtime` | 生命周期、deadline、health、worker 单飞 | macOS、shell 与发行布局 |
| `scripts/build-local-release.mjs` | 同机不可变发行 artifact | 安装或服务启用 |

Linux systemd 与 Windows Service 只需实现 `ServiceController` 与本地 transport 适配器，不改变部署事务和 sidecar CLI 契约。

## 3. 安全与回滚 Review

- 敏感目标只允许 regular file 或明确托管的 `current` symlink；不跟随未知 symlink。
- plan 保存文件 hash，apply 前再次核对，避免覆盖 Codex/CCM 并发写入。
- 每步返回 rollback action，失败时逆序执行；不健康升级会恢复旧发行并重启旧服务。
- release 逐文件校验 SHA-256、清单完整性、权限、Node 路径与实际版本；同版本不同内容拒绝复用。
- Hook receipt 区分精确恢复、managed-unmerge 与 conflict；安装器从不写 `~/.ccm`。
- 正常卸载将 release 先同盘 quarantine，事务提交后再清理，失败可原子恢复。
- purge 必须已经卸载、最近 journal 为 COMMITTED uninstall，并提供精确确认文本。
- 诊断只接受固定字段和安全 token，不记录输入正文；Hook 任意异常保持 fail-open。

## 4. 性能边界

- Hook 默认客户端 deadline 750ms，Daemon 对 UserPromptSubmit 最多 750ms，其余沿用更短事件 deadline。
- Unix socket 单请求单响应，输入最多 5 MiB、响应最多 1 MiB；异常或超限不会重试放大。
- ledger 使用 WAL 与 `busy_timeout`，快路径先直写，失败或超时转本地 spool；worker 单飞 drain。
- release 校验和安装是 O(artifact bytes)，只发生在 plan/apply；运行时不扫描发行目录。
- 日志按 5 MiB、3 个历史文件轮转，写日志失败不会替代 Hook 主结果。

## 5. 验证

专项测试覆盖：

- sidecar READY、真实 Hook 沉淀、SHADOW 空输出、非法/超限输入、socket 缺失/超时、日志轮转；
- release 清单/哈希/Node 版本、同版本复用、篡改/多余文件/symlink/版本碰撞；
- 文件事务逐边界故障注入、并发漂移、symlink 与重复步骤；
- 当前 CCM Hook fixture、重复安装、冲突拒绝、精确恢复与 drift managed-unmerge；
- 不健康升级回滚、失败卸载回滚、doctor、普通卸载保留数据与 purge 门禁；
- 真实构建 artifact 在临时 HOME 安装，启动实际 sidecar，发送合成 Hook，确认 ledger 写入、空输出、日志无正文、CCM 不变并完成卸载。

最终结果：52/52 架构与 Gate 测试、665/665 模块测试通过；整体 Statements 92.69%、Branches 87.86%、Functions 95.49%、Lines 95.63%。当前用户发行 `0.1.2` 的 release integrity、权限、LaunchAgent、socket、兼容性与 SHADOW doctor 全部 PASS。真实合成 Hook 使 ledger 从 1 增至 2，模型可见输出与 stderr 均为 0 字节，诊断日志无合成正文，Codex Hook 去除托管片段后恢复安装前 hash，`.ccm/config.json` hash 不变。

真实升级过程中曾触发三次自动回滚，分别暴露 CLI symlink 主模块判断、launchd bootout/bootstrap/kickstart 收敛竞态和旧 socket 版本误判。最终实现将 CLI wrapper 与逻辑分离，要求 bootout 达到 STOPPED、对 launchd I/O/operation-in-progress 做有界重试，并要求 READY 健康的 sidecar 版本精确匹配目标发行；回滚后的旧发行均恢复 READY。
