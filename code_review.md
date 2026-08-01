# ZhiLoop Code Review

## 统计概览

### 当前 CR 情况

| 指标 | 数值 |
|---|---:|
| CR 标识 | CKL-205 / Candidate Repository |
| CR 耗时 | 620s |
| 高风险 | 5 个 |
| 中风险 | 7 个 |
| 低风险 | 0 个 |
| 修复程度 | 已修复 12/12（100%） |

### 累计情况

| 指标 | 累计值 |
|---|---:|
| 总 CR 次数 | 16 次 |
| 总耗时 | 6480s |
| 高风险累计 | 31 个 |
| 中风险累计 | 60 个 |
| 低风险累计 | 0 个 |
| 平均修复程度 | 100% |

## 改动说明

本次新增 `@zhiloop/candidate-repository` SQLite Adapter。它在编译前按 CKL-202 extractionKey 原子 claim，在编译后保存完整 Runner 结果；支持租约、续租、generation fencing、RETRYABLE 重领、Compiler/Prompt 历史批次和 Candidate 完整性校验。

新包可与 Event Ledger 共用 SQLite 文件，但使用独立 Migration 元数据，不修改 Ledger 的 user_version。没有新增模型、检索、发布、远程网络、凭证或用户目录写入。

## 风险矩阵

| 增/删 | 风险 | 代码定位 | 问题描述 | 影响范围 | 修复结果 |
|---|---|---|---|---|---|
| 增 | 高 | `candidate-repository/repository.ts` / claim | 仅在模型返回后 INSERT OR IGNORE，两个 Worker 仍会重复调用模型。 | 成本翻倍、并发批次不一致 | 编译前 `BEGIN IMMEDIATE` 原子 claim；有效租约返回 IN_PROGRESS，成功批次返回 ALREADY_SUCCEEDED。 |
| 增 | 高 | `repository.ts` / lease takeover | 租约接管后旧 Worker 仍可能回写并覆盖新 generation。 | 新结果被陈旧结果污染 | 每代生成绑定 extractionKey/runCount/entropy 的 fencing token；save/renew 必须匹配当前 RUNNING token。 |
| 增 | 高 | `repository.ts` / batch save | Candidate 逐条提交会在中途冲突时留下部分批次。 | 不完整知识被审计或消费 | 全批预校验并在单事务插入；冲突回滚后批次仍 RUNNING、Candidate 为 0。 |
| 增 | 高 | `repository.ts` / visibility | 普通 Repository 查询若默认返回 PROPOSED，会绕过 Evidence/Policy 进入正式召回。 | 未确认知识污染上下文 | 表约束只允许 PROPOSED；`listCandidates()` 默认 SQL 排除 PROPOSED，管理读取必须显式开启。 |
| 增 | 高 | `repository.ts` / untrusted result | JavaScript 调用方可伪造 status/reason/diagnostics，或让失败结果携带 Candidate。 | 状态机和持久化契约破坏 | 运行时验证三种结果状态、原因、attempts、diagnostics 及成功/失败互斥字段。 |
| 增 | 中 | `repository.ts` / token entropy | 注入的随机源若重复返回同一 token，generation fencing 失效。 | 旧 Worker token 与新 Worker相同 | 随机文本只作为熵；最终 token 加入 extractionKey 和单调 runCount 后 SHA-256。 |
| 增 | 中 | `repository.ts` / long run | 默认租约短于 Runner 多次超时总时长会触发无必要接管。 | 重复模型执行 | 默认租约改为 5 分钟，提供 renewClaim；最大可配置 1 小时。 |
| 增 | 中 | `repository.ts` / identity | 只按 episodeId/compilerVersion 去重会混淆 Builder/Input/Prompt 变更。 | 错误复用旧 Candidate | 复用 extractionKey，并对六字段身份加唯一约束和结果一致性复核。 |
| 增 | 中 | `repository.ts` / integrity | 只校验 payload hash、不核对冗余索引列，外部修改 compiler/subject 列可影响过滤。 | 查询结果被错误隐藏或归类 | 读取时同时核对 Candidate Schema、hash、ID 和六个索引字段；损坏 fail closed。 |
| 增 | 中 | `repository.ts` / migrations | 使用 PRAGMA user_version 会与 CKL-103 Ledger Migration 争用同一版本号。 | 共库启动失败或跳过 Migration | Candidate Repository 使用组件命名的 meta 表；真实共库 Gate 通过，未来版本拒绝降级打开。 |
| 增 | 中 | `vitest.config.ts` / coverage | 新测试能执行但新 workspace 未加入 coverage include，形成假绿。 | 未覆盖生产分支无法被 Gate 发现 | 将 candidate-repository 加入全仓覆盖清单；Repository Lines 95.16%、Branches 92.46%。 |
| 增 | 中 | `repository.ts` / resource bounds | 无 Candidate 数量、JSON 总量、查询和租约上限会造成后台内存/锁时间膨胀。 | 本地 DoS、SQLite 长事务 | 10,000 Candidate、16M JSON、1,000 查询、1 小时租约硬上限，并在序列化过程中提前失败。 |

## 删除与兼容性检查

- 没有删除或修改 Event Ledger 表、PRAGMA user_version、Knowledge Compiler API 或 Candidate Schema。
- 根 Project References、lockfile 和 coverage include 新增第 12 个 workspace；依赖图无环，package 只依赖 Domain、Schemas、Knowledge Compiler 和 Node 内置模块。
- Candidate Repository 表为新增表；同一 SQLite 文件与现有 Ledger 同时打开、追加和读取已通过 Gate。
- 当前 Migration version 为 1；遇到更高版本直接关闭并报错，不尝试降级写入。

## 配置检查

本次没有新增环境变量、pre/prod/inner 配置、API Key 或默认用户路径。数据库 filename、clock、tokenFactory 和 lease 由装配层显式注入；未装配时只使用安全默认租约和系统随机 UUID。

## Gate 证据

| 检查项 | 结果 | 结论 |
|---|---|---|
| Candidate Repository 专项 | 15/15 | 通过 |
| 架构/Gate | 23/23 | 通过 |
| 全仓模块 | 274/274，24 Test Files | 通过 |
| 覆盖率 | Repository Lines 95.16%、Branches 92.46%、Functions 100%；整体高于全仓阈值 | 通过 |
| 共库端到端 | Event Ledger + claim + Compiler Runner + atomic save | 通过 |
| 性能 | 100 Candidate 写 P95 2.18ms；管理读 P95 1.37ms | 通过 |
| 供应链 | npm 官方 registry 0 vulnerabilities | 通过 |

## 性能与瓶颈复盘

- 100 Candidate 的 Schema/JSON/hash/SQLite 原子写中位 1.87ms、P95 2.18ms；当前远低于模型耗时。
- 管理读取会逐条校验 JSON hash、Schema 和索引列，100 Candidate P95 1.37ms。默认 limit=100、最大 1,000，避免单次无界读取。
- Claim 使用短写事务协调跨进程竞争；编译和模型调用完全在事务外执行，不长期持有 SQLite 锁。
- 超大批次仍会增加预校验内存和写锁时间；16M 总量是安全门禁，不是建议目标，Compiler 应保持小批知识。

## 已知边界

- Daemon 尚未装配 claim/renew/run/save 循环；调用方必须在长任务中按租约续期。
- 没有终态失败人工重置、批次删除、备份/恢复或导出 CLI；这些是后续运维能力。
- Candidate Repository 不是正式召回源；Evidence/Asset Repository 尚未实现。
- SQLite 文件权限为 0600，但应用层加密和磁盘密钥不在本模块范围。
- CodeGraph 尚未初始化；影响范围通过全量 TypeScript、依赖边界、跨连接/共库集成和全仓测试验证。

## Review 结论

CKL-205 未发现未修复风险，三项验收条件全部满足。P2 功能模块已齐备，可以进入 P2 Gate。
