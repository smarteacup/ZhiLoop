# ZhiLoop Code Review

## 统计概览

| 指标 | 当前 | 累计 |
|---|---:|---:|
| CR 标识/次数 | CKL-702 | 45 次 |
| 耗时 | 720s | 22230s |
| 高风险 | 9 | 220 |
| 中风险 | 11 | 304 |
| 低风险 | 0 | 0 |
| 修复程度 | 20/20（100%） | 100% |

## 风险矩阵

| 风险 | 问题 | 修复结果 |
|---|---|---|
| 高 | 默认执行直接写入历史数据 | `dryRun` 默认 true；live 缺 Checkpoint/EventSink 直接拒绝。 |
| 高 | PROJECT 回填混入其他仓库 Thread | 强制 projectId+cwd，客户端过滤后再次做 cwd 边界复核。 |
| 高 | 页内崩溃后推进 Cursor 导致 Thread 永久遗漏 | 仅全页终态完成后 CAS 推进 Cursor。 |
| 高 | 部分事件已写后恢复造成重复知识 | PROCESSING 重放，确定性 Event + Ledger duplicate 收敛。 |
| 高 | 循环/倒退 Cursor 先写入断点导致永久卡死 | 在 advance 前检测 current/seen Cursor。 |
| 高 | 活跃 Thread 被当成完整历史编译 | 任一 inProgress Turn 强制 ACTIVE_SESSION 跳过。 |
| 高 | 敏感会话正文进入 dry-run 报告 | 报告只含 ID/cwd/count/bytes/decision，不含 preview/body。 |
| 高 | 单 Thread 或全量扫描无界占用内存 | 分页、maxThreads pause、16 MiB 默认单 Thread 门禁和 64 MiB 硬上限。 |
| 高 | Unix-only 路径逻辑在 Windows 越 Scope | POSIX/drive/UNC 绝对路径与目录边界统一处理。 |
| 中 | `/project` 前缀误匹配 `/project-other` | exact-or-separator path boundary。 |
| 中 | dry-run 为估算偷偷建立 SQLite 状态 | dry-run 不创建 Run，不需要 Checkpoint，不调用 EventSink。 |
| 中 | 已编译历史再次消耗模型 | ProcessedThreadPort 在 read 前跳过；恢复 Run 复用终态 Thread。 |
| 中 | 短会话产生低价值 Candidate | `minTurns` 默认 2，可配置且有界。 |
| 中 | App Server 跨页重复 Thread 重复计数 | 当前扫描维护 seen Thread，输出 DUPLICATE_LISTING。 |
| 中 | opaque cursor 被解析或自行拼接 | Cursor 原样保存/传回，仅做空值与循环检查。 |
| 中 | 不同策略错误恢复同一 Run | requestHash 覆盖 Scope、source、pageSize、大小与全部策略。 |
| 中 | 两个并发执行者静默覆盖 Cursor | SQLite partial unique active Run + cursor revision fencing。 |
| 中 | Thread read 与 list 身份不一致 | 强制 id/cwd/turns 一致后才投影。 |
| 中 | 历史映射复制 CKL-701 领域实现 | 生成标准 completed 通知并复用同一 Adapter。 |
| 中 | 包装层被回填模块反向依赖 | Backfill 只依赖 History/Event/Processed Ports，不依赖 transport 或 app。 |

## Gate 证据

| 检查项 | 结果 |
|---|---|
| Backfill 专项 | 9/9；Lines 96.42%、Branches 88.07%、Functions 100% |
| Ledger 边界 | 1/1；dry-run 0 写入，live 5 条事件入库 |
| 性能 | 1,000 Thread dry-run 7.692ms；约 129,999 threads/s（不含 RPC） |
| 全仓 | 584/584 模块；46/46 架构/Gate |
| 整体覆盖率 | Lines 97.01%、Branches 90.10%、Functions 98.44% |
| Workspace / 供应链 | 35 个依赖边界通过；0 vulnerabilities |

## Review 结论

CKL-702 三项验收满足，20 项风险全部修复，无遗留 actionable finding。默认 dry-run、中断恢复、策略跳过和 Scope 隔离成立；真实 App Server transport 仍未装配。可以进入 CKL-703。
