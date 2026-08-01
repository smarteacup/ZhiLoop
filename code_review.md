# ZhiLoop Code Review

## 📊 统计概览

### 当前 CR 情况

| 指标 | 数值 |
|---|---:|
| **CR 标识** | CKL-104 / Hook Handler 与本地 Spool |
| **CR 耗时** | 680s |
| **🔴 高风险** | 3 个 |
| **🟡 中风险** | 5 个 |
| **🟢 低风险** | 0 个 |
| **修复程度** | 已修复 8/8（100%） |

### 累计情况

| 指标 | 累计值 |
|---|---:|
| **总 CR 次数** | 9 次 |
| **总耗时** | 3220s |
| **🔴 高风险累计** | 11 个 |
| **🟡 中风险累计** | 25 个 |
| **🟢 低风险累计** | 0 个 |
| **平均修复程度** | 100% |

## 改动说明

本次新增独立 `@zhiloop/hook-runtime` 包：有界 stdin、Codex Hook 适配、完整事件信封脱敏、100ms 内入队、失败开放、本地原子 Spool、损坏隔离和幂等恢复。Hook 与 Daemon 通过 `HookEventSink` 端口隔离，不直接打开 SQLite。新增两条架构测试，禁止 Hook Runtime 加载 SQLite 聚合入口、模型、代码扫描和子进程能力。

当前 Node.js 24.18.0 全仓 164 个模块测试、11 个架构测试全部通过；Hook Runtime Lines 98.00%、Branches 92.30%、Functions 100%。测试只使用内存 SQLite 与系统临时目录，没有安装 Hook 或写入用户配置。

## 风险矩阵

| 增/删 | 风险 | 代码定位 | 问题描述 | 影响范围 | 修复结果 |
|---|---|---|---|---|---|
| 增 | 🔴 高 | `packages/hook-runtime/src/redaction.ts` | 初版只脱敏 payload；恶意或异常上游可把凭证放入 turnId、sourceItemId 或 cwd，随后进入 Daemon/Spool。 | 本地凭证泄露、审计数据污染 | 入队和落盘前改为脱敏完整事件信封；保留 eventId/contentHash 身份，增加元数据泄密 Fixture。 |
| 增 | 🔴 高 | `packages/hook-runtime/src/spool.ts` | 普通覆盖写无法同时保证多 Hook 进程竞争、崩溃一致性与 eventId 冲突检测。 | 事件丢失、部分 JSON、静默覆盖 | 使用 0600 临时文件、文件 fsync、原子硬链接和目录 fsync；确定性文件名去重，冲突信封拒绝覆盖，并发测试只留下一个完整文件。 |
| 增 | 🔴 高 | `packages/hook-runtime/src/spool.ts` | 跟随符号链接或不校验临时文件名会把敏感事件写到 Spool 目录外。 | 任意路径写入、权限边界破坏 | 最终 Spool 目录必须是实体目录，记录读取使用 O_NOFOLLOW，随机文件名只允许安全字符，目录/文件权限固定为 0700/0600。 |
| 增 | 🟡 中 | `packages/hook-runtime/src/handler.ts` | 限时 Promise 使用 unref timer 时，独立 Hook 进程可能在超时触发与 Spool 写入前自然退出。 | Daemon 超时事件丢失 | timeout timer 保持引用，最多 100ms；向 Sink 发送 AbortSignal，迟到写入由 Ledger eventId 幂等吸收。 |
| 增 | 🟡 中 | `packages/hook-runtime/src/redaction.ts` | 从 Ledger 根入口导入脱敏函数会连带求值 `node:sqlite`，使轻量 Hook 初始化 SQLite 模块。 | 启动成本、职责越界、实验警告 | Ledger 增加 `./redaction` 子路径；Hook 只导入该叶子模块，并以架构测试禁止根入口和 node:sqlite。 |
| 增 | 🟡 中 | `packages/conversation-ledger/src/redaction.ts` | Hook 适配器允许 32 层 JSON，信封/工具 payload 包装后可能超过脱敏器原 32 层限制，合法事件会在入队前被丢弃。 | 深层工具结果丢失 | 脱敏安全深度提高到 64，并保留 66 层拒绝 Fixture；覆盖适配器最大深度及信封包装余量。 |
| 增 | 🟡 中 | `packages/hook-runtime/src/spool.ts` | 损坏文件若永久留在活动扩展名中，会反复占用扫描窗口并使后续有效事件饥饿。 | 恢复停滞、Daemon 重试热点 | 损坏/超限/文件名不匹配记录原子改名为 `.corrupt-<uuid>` 保留取证，有效记录继续恢复。 |
| 增 | 🟡 中 | `packages/hook-runtime/src/spool.ts` | 一次性 readdir 并读取整个 backlog 会随事件数线性膨胀内存和首条恢复延迟。 | 大 backlog 内存峰值、恢复延迟 | 改为流式目录迭代，单轮默认最多读取 100 个活动文件；返回 scanTruncated/remaining 供 Daemon 分批调度。 |

## 配置与兼容性检查

| 检查项 | 结果 | 结论 |
|---|---|---|
| Hook 退出语义 | 运行时输入、Sink/Spool 故障均返回 `exitCode: 0` | 通过 |
| 入队门禁 | 默认 50ms，配置上限 100ms，超时发送 AbortSignal | 通过 |
| Spool 原子性 | temp + fsync + link + directory fsync，跨进程冲突测试 | 通过 |
| 隐私 | 完整信封脱敏；诊断只暴露 code/errorName | 通过 |
| 路径权限 | 0700 目录、0600 文件、O_NOFOLLOW、文件名校验 | 通过 |
| 恢复语义 | Ack 后删除；删除失败保留；Ledger 重放两次仍为一行 | 通过 |
| 轻量边界 | 不加载 SQLite 根入口、模型、代码扫描或子进程 | 通过 |
| 供应链 | 新模块无第三方运行时依赖；npm audit 0 vulnerabilities | 通过 |

## 性能与瓶颈复盘

- Node 24.18.0、内存 Sink、2,000 次样本：P50 0.0288ms、P95 0.0407ms、P99 0.0795ms、最大 0.5865ms，显著低于 100ms Gate。
- P95 只代表成功捕获入队路径；真实 IPC 延迟将在 Daemon 传输装配后重新测量。严格的 100ms 门禁已独立覆盖 hung Sink。
- Spool 对每个降级事件执行文件与目录同步，优先保证崩溃一致性；磁盘故障路径比内存入队慢，但不影响正常捕获路径。
- 恢复每轮最多扫描 100 个正文文件；超大 backlog 需要 Daemon 连续调度，避免单轮长时间占用事件循环。

## 已知边界

- 当前只定义 `HookEventSink` 端口，尚未选择 Unix Socket/其他本地 IPC 协议；真实 Hook 安装和 Daemon 装配在 P1 Gate 后进行。
- 文件系统调用没有可移植的强制取消能力，安装时必须同时配置 Codex Hook 外部 timeout 作为进程级硬上限。
- `.corrupt-*` 文件保留用于诊断，后续需要单独的容量/保留策略；本模块不会静默删除损坏证据。

## Review 结论

CKL-104 未发现未修复风险。失败开放、隐私、原子落盘、跨进程幂等、损坏恢复、内存边界、模块隔离和性能达到验收条件，可以提交并进入 CKL-105。
