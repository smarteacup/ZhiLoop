# CKL-704：Daemon 应用编排核

## 1. 结论

CKL-704 已完成。`apps/daemon` 不再是空占位，而是 ZhiLoop sidecar 的唯一应用编排入口：统一管理组件生命周期、Hook 快路径、MCP 请求、后台 worker 单飞与结构化健康快照。

本模块不复制 Ledger、Compiler、Retrieval、MCP、Closure 等领域逻辑。发行层把相应服务作为端口装配进 `ZhiLoopDaemonRuntime`，再由 `zhiloop-sidecar` 的进程 transport 暴露；进程打包、服务管理器注册和真实用户目录安装仍属于部署动作，本次没有执行。

## 2. 模块边界

| 端口 | Daemon 责任 | 具体模块责任 |
|---|---|---|
| `DaemonLifecycleComponent` | 按声明顺序 start、逆序 stop、汇总 health | 打开/关闭 Ledger、Registry、Watcher、Transport |
| `DaemonHookPort` | 按事件 deadline 调用、任何错误空输出失败开放 | 捕获、注入、Stop 闭环的具体语义 |
| `DaemonMcpPort` | READY 门禁、透传取消、停止时中断 | `ckl.search/get/related/check` |
| `DaemonWorkerPort` | 单飞、结果验证、游标单调和健康记录 | Ledger 消费、Episode、编译、Evidence、发布/索引 |

Daemon 只依赖 `@zhiloop/plugin-runtime` 的兼容契约。应用层可以组合所有 Workspace 包，但包层不能反向依赖应用。

## 3. 生命周期状态机

```text
STOPPED -> STARTING -> READY -> STOPPING -> STOPPED
                    \-> DEGRADED
STARTING 失败 -> 已启动组件逆序回滚 -> DEGRADED
DEGRADED -> 显式 start 重试
```

- 并发 `start` 和 `stop` 在进程内合并为单次操作。
- 停止发生在启动中时，Abort 后等待启动收敛，不能在 shutdown 之后重新进入 READY。
- component start 失败只回滚已经成功启动的组件。
- shutdown 先取消新请求，再有限等待 inflight，最后逆序停止组件。
- stop 失败保留 `DEGRADED` 与脱敏诊断，不伪报 STOPPED。

## 4. 快路径与 worker

默认 Hook deadline：

| Hook | Daemon deadline |
|---|---:|
| `UserPromptSubmit` | 500ms |
| `PostToolUse` | 100ms |
| `Stop` | 3000ms |
| `SessionEnd` | 100ms |
| 未知事件 | 100ms |

端口异常、超时、Daemon 非 READY、NUL 输出或超过 1 MiB 的 Hook 输出全部折叠为空字符串。MCP 与 Hook 不同：Daemon 非 READY 或请求取消时返回错误，防止调用方把缺失知识误当成空搜索结果。

`runWorkerOnce` 不自行创建不可控后台 interval；宿主的服务管理层决定调度频率。多个并发触发复用同一 Promise。每轮必须返回非负 consumed/produced/retryableFailures 与单调 cursor；非法或倒退结果使 health 进入 DEGRADED，成功轮次才能清除 worker 诊断。

## 5. 健康与兼容

健康快照同时包含：

- READY/DEGRADED 与内部 Daemon state。
- Plugin、sidecar、protocol、Hook 和 App Server 版本。
- 每个组件的布尔健康状态与单行、最多 500 字符的诊断。
- 最近成功 worker cycle。
- 生命周期或 worker 的最后诊断。

该快照直接兼容 CKL-703 的 `evaluateSidecarCompatibility`，不会只凭 PID 或 socket 存在就报告 READY。

## 6. Review 与验证

Review 修复了 8 个高风险和 7 个中风险问题：启动/停止竞态、组件部分启动回滚、MCP 未随 shutdown 取消、shutdown deadline 被 `unref`、worker 游标倒退、worker 失败不进入 health、Hook 输出无界、组件健康类型/多行诊断污染，以及 clock/deadline/组件身份输入校验。

```text
npx vitest run apps/daemon/src --coverage ...
node --test scripts/daemon-runtime-boundary.test.mjs
npm run check
npm audit --audit-level=high --registry=https://registry.npmjs.org
```

结果：Daemon 专项 9/9，Lines 100%、Branches 94.11%、Functions 95%；全仓 614/614 模块测试、48/48 架构/Gate 测试；最终整体 Lines 96.92%、Branches 89.97%、Functions 98.15%；0 vulnerabilities。

## 7. 部署边界

- 源码完成并不自动授权安装插件、注册 launchd/systemd/Windows Service 或创建 `~/.ckl`。
- 发行包必须提供把 transport 与现有端口装配进 Runtime 的 `zhiloop-sidecar` 可执行入口。
- Worker 默认只消费当前会话已有证据，不得擅自执行测试或任意项目命令。
- Publisher 默认只写本地知识目录；项目 Git Publisher、中心同步和生产向量服务仍是明确非目标。
