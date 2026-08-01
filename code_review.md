# ZhiLoop Code Review

## 📊 统计概览

### 当前 CR 情况

| 指标 | 数值 |
|---|---:|
| **CR 标识** | CKL-102 / Versioned Transcript Adapter |
| **CR 耗时** | 420s |
| **🔴 高风险** | 1 个 |
| **🟡 中风险** | 4 个 |
| **🟢 低风险** | 0 个 |
| **修复程度** | 已修复 5/5（100%） |

### 累计情况

| 指标 | 累计值 |
|---|---:|
| **总 CR 次数** | 7 次 |
| **总耗时** | 2020s |
| **🔴 高风险累计** | 5 个 |
| **🟡 中风险累计** | 17 个 |
| **🟢 低风险累计** | 0 个 |
| **平均修复程度** | 100% |

## 改动说明

本次变更完成 CKL-102，在 `@zhiloop/ingestion-codex` 中新增版本化 Codex rollout JSONL 增量读取器。游标记录 byte offset、line number、文件身份、尾部 anchor hash、格式/CLI 版本、session 和 active turn；重复读取不产生事件，追加只解析增量，未完成的末行保留到下次读取。

适配器只投影 `session_meta`、公开 `user_message` 和 `task_complete.last_agent_message`，明确忽略 reasoning、内部上下文、工具细节和 compacted 结构。新增独立 `codex-transcript` EventSource，避免把 transcript 冒充 Hook/App Server。当前 121 个模块测试、9 个架构测试全部通过；transcript adapter 行覆盖率 94.73%、分支覆盖率 85.20%。

## 风险矩阵

| 增/删 | 风险 | 代码定位 | 问题描述 | 影响范围 | 修复结果 |
|---|---|---|---|---|---|
| 增 | 🔴 高 | `packages/ingestion-codex/src/transcript-adapter.ts:203` | 直接把 rollout record 作为事件会保存 encrypted reasoning、base instructions、world state 和完整工具结果，违反“不保存隐藏推理”和最小化采集原则。 | 隐私、上下文泄露、知识污染 | 已改为三种公开白名单投影；真实 rollout 的 2,050 条内部记录全部只计数忽略，测试确认隐藏 sentinel 和 base instructions 不出现在事件中。 |
| 增 | 🟡 中 | `packages/ingestion-codex/src/transcript-adapter.ts:283` | 只保存 byte offset 无法识别文件截断、替换或原地改写，可能从错误位置读取并造成事件丢失或重复。 | Ledger 幂等、重启恢复、对话完整性 | 已绑定绝对路径 hash + dev/ino，并校验 size 和最后 4 KiB anchor；截断、替换、原地修改均有独立诊断测试。 |
| 增 | 🟡 中 | `packages/ingestion-codex/src/transcript-adapter.ts:339` | 分块读取若在 UTF-8/JSONL 行中间结束，推进游标会丢数据；若 read limit 等于 line limit，换行落在下一字节还会永久不前进。 | 增量捕获、长消息、CPU 空转 | 只推进到最后完整换行，残行下次重读；强制 read limit 大于 line limit，并用 512-byte 分块回放验证事件 ID 与一次读取完全一致。 |
| 增 | 🟡 中 | `packages/ingestion-codex/src/transcript-adapter.ts:176` | Codex 官方声明 transcript 不是稳定接口；仅看 JSONL 可解析就继续会把未来结构误判为当前版本。 | 升级兼容、字段误读 | 以 session_meta 结构和 CLI major 0 识别 v1；未知首记录或 CLI major 返回不可恢复 `UNSUPPORTED_TRANSCRIPT_FORMAT`，不猜测映射。 |
| 增 | 🟡 中 | `packages/ingestion-codex/src/transcript-adapter.ts:69` | 持久化游标可能损坏或被错误反序列化，负 offset、越界 anchor 会触发异常读或错误诊断。 | Daemon 重启、Ledger 游标恢复 | 读取文件前校验所有数值、hash、anchor 范围和格式/session 一致性，损坏游标单独诊断。 |

## 配置与兼容性检查

| 检查项 | 结果 | 结论 |
|---|---|---|
| 官方边界 | 遵循“transcript format is not a stable interface”并实施版本降级 | 通过 |
| EventSource | Domain、JSON Schema、TDD 同步增加 `codex-transcript` | 通过 |
| 隐藏内容 | reasoning / base instructions / world state / tool raw output 均不投影 | 通过 |
| 增量游标 | 重复、追加、残行、分块、截断、替换、anchor、损坏游标均覆盖 | 通过 |
| 原始协议隔离 | 下游只接收三种 TranscriptEventPayload，不接收 rollout record | 通过 |
| 供应链 | 仅使用 Node fs/path/crypto，无新增第三方依赖 | 通过 |

## 性能与瓶颈复盘

- 在本机真实 Codex rollout 上只读扫描 5,805,282 bytes、2,087 条记录耗时约 19.61ms，约 279.98 MiB/s。
- 该样本产出 37 条公开标准事件，忽略 2,050 条内部记录；基准只输出数量和时延，没有输出对话正文。
- 每批最多读取 8 MiB、单行最多 1 MiB，内存上界明确；增量验证只重读最后 4 KiB anchor，不对历史全文重复 hash。
- 单个超大 compacted/replacement_history 行会被拒绝，即使该记录最终会忽略；这是有意的内存门禁。若真实数据命中，应改为流式跳过已知内部类型，而不是盲目提高全局行上限。

## 已知边界

- v1 当前只支持 CLI `0.x` 且必须有 `session_meta`。官方发布 1.x 时必须先增加脱敏 Fixture 和契约测试，再允许新版本。
- 只保存最终可见 assistant message，不保存中间 reasoning；普通 assistant 增量消息暂不创建独立事件，Episode Builder 以 `turn.stopped` 为准。
- Anchor 用于快速检测 cursor 附近变化，不是整文件完整性证明；inode 变化、截断和常见原地替换已覆盖，Ledger 仍需依靠 eventId 去重。

## Review 结论

CKL-102 未发现未修复风险。增量一致性、版本降级、隐私投影、游标恢复、异常诊断和真实文件性能达到验收条件，可以提交并进入 CKL-103。
