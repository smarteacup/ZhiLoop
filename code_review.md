# ZhiLoop 0.3.9 Final Code Review

## 结论

本次 review 覆盖 Console P0-P4 的最终组合、真实部署修复和文档状态。已按正确性、并发、性能、隐私、安全、兼容性和模块边界检查增量代码；8 个实际发现均已修复并有自动化或真实环境证据。当前没有未解决的高风险 finding。

## 变更范围

- Production Worker terminal retry 与 snapshot pipeline identity。
- P1/P2 durable job 的统一 cancel/retry 路由。
- 启动期配置的 `requiresRestart` 语义。
- Gateway、Web 与 Sidecar 的 Codex query deadline 协调。
- release 构建版本一致性、升级配置继承与 LaunchAgent READY 等待。
- ZhiLoop `0.3.9` 文档、OpenSpec 任务和真实验收记录。

## 风险矩阵

| 等级 | 发现 | 风险 | 修复与证据 |
|---|---|---|---|
| 高 | terminal worker failure 丢失原始 retryable 语义 | 外部能力恢复后仍无法人工重试，知识链永久卡死 | 保留 cause classification；显式 retry 只给失败阶段一个新 attempt，不重放成功阶段；runtime/P2 tests |
| 高 | 相同 source range 无条件复用旧 snapshot | compiler、policy 或配置变化后仍使用旧产物 | pipeline identity 变化时创建新 immutable snapshot，历史保留；P2 Console E2E |
| 高 | 浏览器问答固定 10 秒、Gateway 固定短 timeout | 检索成功但模型回答总是 fallback | search/simulation 保持短门禁，Ask 端到端上限 120 秒；Gateway/Web tests 与真实 44 秒成功回答 |
| 高 | upgrade 未传参数会移除 `codexQuery` | 升级后能力静默退化为 NOT_CONFIGURED | 从 bounded regular managed config 继承并重新校验 executable；异常 shape fail closed；installer tests 与真实无参数升级 |
| 中 | release manifest 与 stale dist 版本可能不一致 | 安装器接受错误版本内容或 READY 校验失败 | release 前动态读取 built metadata 并与目标版本精确比较；release acceptance |
| 中 | future 启动期字段标记为热生效 | UI 显示已生效但实际组件仍持有旧值 | injection/compiler/query timeout/concurrency 均标记 restart；configuration tests |
| 中 | 统一任务操作只路由 P1 store | P2 job 可见但无法 retry/cancel | 按 job 所有权路由到 P2 或 P1，并投影新状态；P2 runtime tests |
| 中 | LaunchAgent READY 默认只等 5 秒 | 冷启动偶发误判失败并触发回滚 | 有界扩展至 15 秒；仍 fail closed 并保留 journaled rollback；真实升级验证 |

## 维度审查

### 正确性与一致性

- Worker checkpoint 仍是阶段进度权威源；retry 只重置单个 retryable failed stage。
- Snapshot 身份同时绑定 source range、compiler、policy 和 configuration hash，不修改旧 snapshot。
- P2 job 记录不会被运行时删除，因此 `hasJob` 后执行 revision-bound command 不存在所有权漂移；并发冲突由 expected revision 拒绝。
- release version 在构建、package metadata、health 和 manifest 中一致为 `0.3.9`。

### 并发与性能

- job cancel/retry 继续经过 durable store 的 revision/idempotency/lease 边界。
- Codex query concurrency 由 bounded semaphore 控制，Gateway/Web 延长 deadline 不增加并发上限。
- 普通检索仍为 10/15 秒级短链路；只有模型辅助 Ask 使用最多 120 秒。
- READY 等待为 60 × 250ms 的固定上界，不存在零延迟或无限循环。

### 隐私与安全

- Query adapter 保持 read-only、ephemeral、no MCP、safe cwd、bounded output 和最小环境；模型事实必须引用 eligible knowledge version。
- 升级继承只读取 manifest 证明归属的 bounded regular config，拒绝 symlink、超限、非法 executable 和不支持 shape。
- Gateway 仍为 loopback only，复用 bootstrap/session/CSRF/Origin/Host/CSP 与 response size/rate limit。
- 日志、diagnostic 和审计不写 prompt、知识正文、凭证或完整环境变量。
- SHADOW 结果没有投递证据时不能显示为 `INJECTED`。

### 兼容性与模块边界

- Domain/port 层没有新增 Node、UI 或 Sidecar 反向依赖；59 个 workspace 依赖检查通过。
- 新参数均为向后兼容可选项；无模型配置时保持明确 `NOT_CONFIGURED/FALLBACK_SEARCH`。
- 部署失败仍由 transaction journal 逆序恢复 current、manifest、config、Hook 和 service。
- `~/.ccm/config.json` 未被安装器管理或修改。

## Gate 证据

| Gate | 结果 |
|---|---|
| Workspace dependency/import/direct-test | 通过，59 workspaces |
| ESLint | 通过 |
| TypeScript build + test typecheck | 通过 |
| Architecture/Gate tests | 56/56 通过 |
| Vitest unit/integration | 143 files，1273/1273 通过 |
| Coverage | statements 90.24%，branches 85.00%，functions 92.05%，lines 93.76% |
| Local release acceptance | install/capture/CCM preservation/uninstall 通过 |
| Real browser | session → extraction → knowledge → search → Ask `SUCCEEDED`，citation/evidence/trace 完整 |
| Real deployment | `0.3.9` journal COMMITTED，doctor 全 PASS，无参数升级保留 Codex binding |
| Diff hygiene | `git diff --check` 通过 |

## 非阻塞限制

跨语言 lexical recall 仍依赖 alias 或 vector 能力：英文知识标题用纯中文同义句查询可能没有上下文。系统会如实返回 `NO_CONTEXT`，不会让模型在无召回证据时生成事实。这属于后续召回质量增强，不是当前安全或正确性 blocker。
