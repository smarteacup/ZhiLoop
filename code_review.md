# ZhiLoop Code Review

## 📊 统计概览

### 当前 CR 情况

| 指标 | 数值 |
|---|---:|
| **CR 标识** | CKL-101 / Codex Hook Adapter |
| **CR 耗时** | 330s |
| **🔴 高风险** | 1 个 |
| **🟡 中风险** | 3 个 |
| **🟢 低风险** | 0 个 |
| **修复程度** | 已修复 4/4（100%） |

### 累计情况

| 指标 | 累计值 |
|---|---:|
| **总 CR 次数** | 6 次 |
| **总耗时** | 1600s |
| **🔴 高风险累计** | 4 个 |
| **🟡 中风险累计** | 13 个 |
| **🟢 低风险累计** | 0 个 |
| **平均修复程度** | 100% |

## 改动说明

本次变更完成 CKL-101，新建独立 `@zhiloop/ingestion-codex` 包，将官方当前 `UserPromptSubmit`、`PostToolUse`、`Stop`、`SessionEnd` 线协议投影为 Domain `EventEnvelope`。适配器不安装 Hook、不读取 transcript、不写 Ledger，只进行同步校验、规范化、哈希和 Schema 契约验证。

四类脱敏 Fixture 均来自官方 Hook 字段形态。未知原始字段不进入 Domain；缺少可选 `turn_id`/`transcript_path` 仍可转换；同一语义输入跨观测时间生成相同 `eventId`。当前 105 个模块测试、9 个架构测试全部通过；ingestion-codex 行覆盖率 97.45%、分支覆盖率 90.72%。

## 风险矩阵

| 增/删 | 风险 | 代码定位 | 问题描述 | 影响范围 | 修复结果 |
|---|---|---|---|---|---|
| 增 | 🔴 高 | `packages/ingestion-codex/src/canonical-json.ts:31` | 初版规范化对象键使用 `localeCompare`，不同系统 Locale 可能产生不同排序，使同一 Hook 在不同机器生成不同 contentHash/eventId，破坏 Ledger 幂等。 | 重复事件、重放一致性、跨环境迁移 | 已改为明确的字符串码点比较；eventId 使用字段数组的规范 JSON + SHA-256，未知字段和 occurredAt 不参与身份计算，并增加稳定性测试。 |
| 增 | 🟡 中 | `packages/ingestion-codex/src/adapter.ts:103` | 直接传播 Hook 原始对象会把 `transcript_path` 和未来私有字段泄漏到领域层，也会让 Codex 协议变化扩散到 Ledger。 | 隐私边界、协议兼容、下游耦合 | 已按四种事件显式白名单投影 payload；transcript 路径和未知字段不输出，未来事件返回独立 `UNSUPPORTED_HOOK_EVENT`。 |
| 增 | 🟡 中 | `packages/ingestion-codex/src/canonical-json.ts:5` | 非 JSON 对象、循环引用、极深结构或超大工具输出可能静默丢字段、耗尽栈/内存，拖慢 Hook 快路径。 | Hook 稳定性、拒绝服务、内容完整性 | 已限制纯 JSON、最大深度 32、规范化 payload 4 MiB 上限，并为循环、Date、NaN、深度和大小增加拒绝测试。 |
| 增 | 🟡 中 | `packages/ingestion-codex/src/adapter.ts:232` | Hook 本身没有发生时间字段；若调用方提供非法或溢出的时间，构造出的标准事件可能在后续 Schema 环节失败，诊断也会混淆为内部错误。 | 事件排序、诊断准确性、重放 | 已注入 clock/observedAt，校验完整 ISO date-time、月日和时区范围；输出再次通过 Event Schema，并深度冻结。 |

## 配置与兼容性检查

| 检查项 | 结果 | 结论 |
|---|---|---|
| 官方协议依据 | 当前 Codex Hooks release behavior：四类字段和可选项已核对 | 通过 |
| Workspace 依赖 | 仅依赖 Domain、Schemas 和 `node:crypto` | 通过 |
| 原始字段隔离 | transcript path/unknown fields 不进入 EventEnvelope | 通过 |
| 幂等身份 | source + session + turn + type + sourceItemId + contentHash | 通过 |
| 供应链 | 无新增第三方依赖，npm 官方 registry 0 vulnerabilities | 通过 |

## 性能与瓶颈复盘

- 100,000 次 `PostToolUse` 规范化、两次 SHA-256 和 Event Schema 校验约 1624.78ms，即约 61,547 events/s。
- 单次小型 Fixture 平均约 0.016ms，远低于捕获类 Hook P95 100ms 目标；真实命令入口、进程启动和 IPC 将在 CKL-104 单独基准。
- 算法复杂度为 O(n log k)：n 是 payload 字节/节点数，k 是单个对象键数；典型工具对象的 k 很小。
- 4 MiB 上限避免极端输出进入热路径。后续 Spool/Ledger 必须接收结构化诊断，不能通过提高上限掩盖大输出问题。

## 已知边界

- 本模块没有落盘，因此尚未执行敏感信息替换；“入库前脱敏”属于 CKL-103，并已在计划中保留强制 Fixture。
- `transcript_path` 只属于未来 CKL-102 的适配器内部输入，不进入标准事件 payload。
- Codex 官方说明 transcript 格式不是稳定接口；CKL-102 必须使用版本检测和未知版本降级，不能复用本模块对 Hook 的稳定性假设。

## Review 结论

CKL-101 未发现未修复风险。四类 Hook 的字段投影、幂等 ID、非法输入诊断、资源上限、Schema 契约和性能均达到验收条件，可以提交并进入 CKL-102。
