# P1 Gate 验收报告

**验收日期**：2026-08-01  
**运行基线**：Node.js 24.18.0  
**结论**：通过

## 1. 验收范围

P1 验证从 Codex Hook 输入到标准事件、失败 Spool、SQLite Ledger 和 Session/Turn 归一化的完整确定性链路。测试使用仓库内脱敏录制 Fixture `fixtures/p1/codex-hook-session.jsonl`，不读取真实 Codex transcript，不安装 Hook，不启动后台 Daemon，也不修改 `~/.ckl`、`~/.codex` 或 `~/.ccm`。

Fixture 包含 5 次 Hook 调用：UserPrompt、PostToolUse、两次内容相同但 observedAt 不同的 Stop，以及 SessionEnd。两次 Stop 具有同一幂等身份，因此预期 Ledger 唯一事件数为 4。

## 2. Gate 结果

| Gate | 验证方法 | 结果 |
|---|---|---|
| Fixture 重放三次行数不变 | 同一组标准事件连续 `appendBatch` 三次，每次检查 count | 4 → 4 → 4，通过 |
| Hook 全故障不影响 Codex 流程 | Sink 每次抛出 Daemon outage，逐条执行 Hook command | 5/5 返回 exitCode 0，通过 |
| Spool 可恢复且幂等 | 失败事件写入原子 Spool，再 drain 到空 Ledger | delivered 4、remaining 0、Ledger 4 行，通过 |
| 敏感正文不落库 | Fixture 工具结果含合成 Bearer/authorization | 原值不存在，`[REDACTED]` 存在，通过 |
| source/session 可追踪 | 检查每条 Ledger record | 4/4 source=`codex-hook`、session=`p1-session`，通过 |
| Turn/Session 边界可追踪 | Normalizer 后检查 eventId 引用集合 | 4/4 归属唯一 Turn 或 Session boundary，通过 |
| 重复 Stop 不重复 Turn | 两次 Stop 经 eventId 去重和归一化 | 1 Session、1 Turn，通过 |

## 3. Gate 发现与修复

首次故障回放发现 Spool 与 Ledger 的重复判断不一致：事件确定性 ID 不包含 observedAt，Ledger 允许重复观察时间变化，但 Spool 曾比较完整信封并报冲突。这会使第二次 Stop 在 Daemon 故障时无法进入 Spool。

修复后，二者统一使用以下幂等身份：

```text
eventId + source + sourceItemId + eventType + sessionId + turnId
+ contentHash + correlationId + redacted payload
```

`occurredAt`、cwd、projectHint 和 sourceVersion 是观察/上下文元数据，不参与同一事件的冲突判断，首次成功记录保持权威。同时 Ledger 加强了 identity metadata 碰撞检测；相同 eventId 但 source/session/turn/type/sourceItem/correlation 不同会抛出冲突，而不是静默当作 duplicate。

## 4. 全仓质量证据

在 Node.js 24.18.0 执行：

```text
npm run check
npm audit --registry=https://registry.npmjs.org --audit-level=low
```

结果：

| 指标 | 结果 |
|---|---:|
| Workspace | 9 个，依赖方向与循环检查通过 |
| 架构/Gate 测试 | 14/14 |
| 模块测试 | 189/189，17 个 Test Files |
| 整体 Lines | 97.81% |
| 整体 Branches | 90.54% |
| 整体 Functions | 98.89% |
| npm audit | 0 vulnerabilities |

## 5. 进入 P2 的条件

P1 已具备稳定的事件捕获、增量 transcript 读取、幂等账本、失败 Spool 和 Session/Turn 重建能力。P2 可以从 CKL-201 Episode Builder 开始，但仍保持以下部署边界：

- 真实 Hook/Daemon 尚未安装；本地 IPC 协议和安装/卸载回滚在部署阶段单独验收。
- `.corrupt-*` Spool 证据的保留/容量策略仍待 Daemon Worker 实现。
- Session context 暂用 projectHint/cwd，标准 projectId 等待 Project Resolver。
