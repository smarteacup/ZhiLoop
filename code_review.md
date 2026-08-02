# ZhiLoop Code Review

## 统计概览

| 指标 | 当前 | 累计 |
|---|---:|---:|
| CR 标识/次数 | CKL-604 | 41 次 |
| 耗时 | 900s | 19830s |
| 高风险 | 11 | 190 |
| 中风险 | 12 | 267 |
| 低风险 | 0 | 0 |
| 修复程度 | 23/23（100%） | 100% |

## 风险矩阵

| 风险 | 问题 | 修复结果 |
|---|---|---|
| 高 | 普通“好的”被推断为批准 | 只匹配完整 option/label/ordinal/锚定短语，普通对话 NO_MATCH。 |
| 高 | 多个 Pending 时回复误关联 | 无显式 ID 必须恰好一个 Pending，否则 AMBIGUOUS_PENDING。 |
| 高 | 显式 confirmation ID 跨 session 读取或应用 | Pending 查询和既有 Resolution 返回都复核 session。 |
| 高 | 回复修改 Request 外 Candidate | subject 集合必须与 Request/target/relation 一一相等。 |
| 高 | Request 后资产已更新仍应用旧选择 | 保存 expectedRevision，Effect 的 beforeRevision 必须一致。 |
| 高 | 并发不同回复同时生效 | SQLite `BEGIN IMMEDIATE` 原子 claim，其他 resolution/event/hash 冲突。 |
| 高 | crash 后重复执行 Effect | resolutionId 确定性、claim 可同事件重试、Port 强制幂等契约。 |
| 高 | 沉默与明确拒绝都解释为 KEEP_PROPOSED | 新增独立 `REJECT_CANDIDATE` 与 REJECTS relation。 |
| 高 | 纠正丢失原版本或改错目标 | CORRECTS 一一覆盖 target，保存 before/after revision 和 statement ref。 |
| 高 | Schema 接受 effect/relation 语义错配 | Domain 唯一 effect→relation 映射，Parser 交叉验证。 |
| 高 | Port 超时/错误消息泄露对话或秘密 | Abort deadline；诊断不透传 message，正文不写入本模块 DB。 |
| 中 | “不是很确定”被误判纠正 | 否定后必须出现应该/改为等组合标记。 |
| 中 | “不是这个意思”与纠正混淆 | 明确映射为 OPTION rejection，不创建 correction revision。 |
| 中 | 同 Turn 或乱序事件抢答 | ordinal、Turn ID 和 occurredAt 三重后续门禁。 |
| 中 | 同 ID 不同 Request 覆盖 Pending | canonical JSON + payload/target hash 冲突检查。 |
| 中 | Resolution relation 少项、多项或重复 | Schema 与 Service 双层 exact coverage。 |
| 中 | 非变更 relation 伪造新状态 | effect 对应 relation 固定；非 RETAINS/CONTINUES 必须产生新 revision。 |
| 中 | Effect Port 夹带回复正文进诊断 | 固定诊断文本，仅 response hash/ref 持久化。 |
| 中 | SQLite 文件暴露 | 非内存数据库 chmod 0600，WAL/foreign keys/busy timeout。 |
| 中 | 新版本 DB 被旧程序打开 | migration version 前向拒绝。 |
| 中 | Repository 已关闭仍继续使用 | 每个 public operation 做 open guard，close 幂等。 |
| 中 | 同回复重放被视为新选择 | response event/hash/resolution ID 联合幂等。 |
| 中 | Option label 恶意重复导致随机选择 | Matcher 返回 AMBIGUOUS，不按数组首项猜测。 |

## Gate 证据

| 检查项 | 结果 |
|---|---|
| CKL-604 专项 | 23/23；Statements 94.55%、Branches 89.02%、Lines 97.58% |
| Confirmation Schema 联合 | safe option/effect/relation/correction/subject coverage 全通过 |
| 全仓 | 550/550 模块；43/43 架构/Gate |
| 整体覆盖率 | Lines 97.01%、Branches 90.12%、Functions 98.58% |
| Workspace | 33 个，依赖/import policy 通过 |
| 供应链 | 0 vulnerabilities |

## Review 结论

CKL-604 两项验收满足，23 项风险全部修复，无遗留 actionable finding。Effect Port 的生产实现必须按 resolutionId 幂等并遵守 AbortSignal；该约束已进入技术文档和 CKL-703 装配边界，可以进入 CKL-605。
