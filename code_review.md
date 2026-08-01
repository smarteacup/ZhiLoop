# ZhiLoop Code Review

## 📊 统计概览

### 当前 CR 情况

| 指标 | 数值 |
|---|---:|
| **CR 标识** | CKL-103 / SQLite Event Ledger |
| **CR 耗时** | 520s |
| **🔴 高风险** | 3 个 |
| **🟡 中风险** | 3 个 |
| **🟢 低风险** | 0 个 |
| **修复程度** | 已修复 6/6（100%） |

### 累计情况

| 指标 | 累计值 |
|---|---:|
| **总 CR 次数** | 8 次 |
| **总耗时** | 2540s |
| **🔴 高风险累计** | 8 个 |
| **🟡 中风险累计** | 20 个 |
| **🟢 低风险累计** | 0 个 |
| **平均修复程度** | 100% |

## 改动说明

本次变更完成 CKL-103，新建独立 `@zhiloop/conversation-ledger` 包，使用 Node 24 内置 SQLite 实现 Migration、事务批量追加、幂等冲突检测、序列读取、单调消费游标、崩溃重放和分批保留清理。所有数据库测试只使用 `:memory:` 或系统临时目录，未创建 `~/.ckl`。

事件 payload 在事务前执行递归 JSON 校验和敏感字段/常见密钥模式替换。账本同时保留来源 `contentHash` 与脱敏后 `storedPayloadHash`；读取时验证存储 hash。Raw Event 到期后只把已消费 payload 改成 `null` 并设置 tombstone，不删除 eventId 元数据。当前 137 个模块测试、9 个架构测试全部通过；conversation-ledger 行覆盖率 98.69%、分支覆盖率 88.28%。

## 风险矩阵

| 增/删 | 风险 | 代码定位 | 问题描述 | 影响范围 | 修复结果 |
|---|---|---|---|---|---|
| 增 | 🔴 高 | `packages/conversation-ledger/src/event-ledger.ts:315` | 初版保留策略直接 DELETE 过期事件，eventId 幂等记录随之消失；旧 Hook/Spool 重放会被赋予新 sequence 并重复编译。 | 知识重复、重放一致性、审计追踪 | 已改为只清除 payload 并写 `payload_purged` tombstone，保留 eventId/sequence/contentHash；清理后重放仍返回原 sequence 的 duplicate。 |
| 增 | 🔴 高 | `packages/conversation-ledger/src/event-ledger.ts:239` | `INSERT OR IGNORE` 会把“相同 eventId、不同内容”误报为正常 duplicate，掩盖上游哈希冲突或适配器缺陷。 | 事件丢失、错误内容静默覆盖 | duplicate 现在同时比较原始 contentHash 和未清理时的 storedPayloadHash；冲突抛错并回滚整个批次。 |
| 增 | 🔴 高 | `packages/conversation-ledger/src/redaction.ts:3` | 原始 prompt/工具输出可能包含密码、Bearer、API Key、GitHub/AWS 凭证或私钥；数据库权限若依赖 umask 还可能对其他本机用户可读。 | 凭证泄露、本地隐私 | 入库前按敏感键和密钥模式替换，测试确认原文不落盘；Unix 数据库显式 chmod 0600，WAL 无 group/other 权限。 |
| 增 | 🟡 中 | `packages/conversation-ledger/src/event-ledger.ts:286` | 游标“读取旧值→写新值”和 retention “取最慢游标→清理”若不在同一事务，多进程 Worker 可能发生回退或越过新消费者。 | At-least-once 消费、保留安全 | 两条路径均使用 `BEGIN IMMEDIATE`；游标只允许单调推进，可用 sequence 0 显式注册等待中的消费者。 |
| 增 | 🟡 中 | `packages/conversation-ledger/src/event-ledger.ts:91` | 数据库中的 payload_json 被意外修改后仍能通过 Event Schema，损坏内容会进入 Episode Builder。 | 存储完整性、知识可信度 | 每行存储脱敏 payload SHA-256，读取前强制复算；篡改 Fixture 被拒绝。 |
| 增 | 🟡 中 | `package.json:9` | 工程原声明 Node >=22，但当前内置 `node:sqlite` API 只在固定 Node 24.18 基线验证，较旧 Node 22 可能安装成功后运行失败。 | 部署兼容、CI/本地差异 | engines 与实施决策下限统一到 Node 24.18.0；Node 24 完整 Gate 复验。 |

## 配置与兼容性检查

| 检查项 | 结果 | 结论 |
|---|---|---|
| SQLite 模式 | WAL、foreign_keys、busy_timeout 5000ms、synchronous NORMAL | 通过 |
| Migration | `user_version=1`，拒绝更高未知版本，初始化使用排他事务 | 通过 |
| 幂等追加 | eventId unique + 内容冲突检测 + 批次回滚 | 通过 |
| 消费语义 | sequence 单调，崩溃未 commit 时重启重放 | 通过 |
| 保留策略 | 只清 payload；不越过最慢消费者；每批最多 1000 条 | 通过 |
| 隐私 | 递归脱敏、0600 DB、WAL 权限、日志不输出正文 | 通过 |
| 供应链 | 无第三方 SQLite/native addon；仅 Node 内置模块 | 通过 |

## 性能与瓶颈复盘

- Node 24、临时文件 WAL 模式下，1000 条事务批量写约 11.60ms，即约 86,238 events/s。
- 1000 条读取、JSON 解析、Schema 和 stored hash 复验约 7.17ms，即约 139,558 events/s。
- `DatabaseSync` 会阻塞所在事件循环，因此必须由后台 Daemon 的单写者执行；CKL-104 Hook Handler 只能做 IPC/Spool，禁止直接写 SQLite。
- WAL 仍是单写者模型。批量写可降低 fsync 成本；payload retention 每次最多更新 1000 行并返回 `hasMore`，避免长写锁。
- 脱敏和 JSON hash 为 O(payload bytes)，超大工具输出已在 CKL-101 的 4 MiB 门禁前置阻断。

## 已知边界

- 当前 Migration 只包含 Event Ledger 和 consumer cursors；Episode/Candidate 等表由后续模块以新 migration 增加。
- payload tombstone 保留元数据但无法供晚注册消费者重新构建正文，因此所有生产消费者必须在 retention 开启前以 sequence 0 注册。
- 当前密钥规则覆盖常见格式，不等同于通用 DLP；后续新增 Provider 时必须补相应脱敏 Fixture。

## Review 结论

CKL-103 未发现未修复风险。幂等、事务、崩溃重放、游标、保留 tombstone、隐私、文件权限、完整性和性能达到验收条件，可以提交并进入 CKL-104。
