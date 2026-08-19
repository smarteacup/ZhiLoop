# ZhiLoop 版本兼容矩阵

**矩阵版本**：1  
**更新日期**：2026-08-19

## 1. 当前基线

| 组件 | 当前版本 | 兼容规则 | 不兼容时行为 |
|---|---|---|---|
| ZhiLoop Plugin | 0.1.0 | 与 sidecar 使用同一 Plugin contract 版本 | Hook 失败开放；MCP/doctor 报错 |
| ZhiLoop Sidecar | >=0.1.0、major=0 | 不低于最低版本且 major 相同 | 不自动替换已运行进程 |
| Sidecar Protocol | 1 | 必须精确匹配 | 拒绝连接 |
| Codex CLI | >=0.144.4（已测试下限） | 需要 Plugin v1、Hooks v1、App Server v2 | 启用前 doctor 检查 |
| Codex Exec Extraction | 当前 CLI contract | 需要 `--sandbox read-only`、`--ephemeral`、`--json`、`--output-schema`、`--output-last-message` | 编译批次标记可重试/拒绝，不产生部分 Candidate |
| Codex Hook Schema | `codex-hooks-v1` | 必须精确匹配 | Hook launcher 空输出放行 |
| Codex App Server | `codex-app-server-v2` | 必须精确匹配 | 停止结构化实时采集/回填，不回退伪造事件 |
| Event/Candidate/Asset Schema | 1 | Reader 只接受已注册版本 | 拒绝该记录并返回诊断 |
| Context/Confirmation Schema | 1 | Reader 只接受已注册版本 | 不注入/不写回 |
| Markdown Schema | 1 | `schema_version: 1` | 不索引未知版本 |
| Event Ledger Migration | 1 | 只前向迁移；拒绝更高版本 | 启动失败，不降级写库 |
| Candidate Repository Migration | 1 | 只前向迁移；拒绝更高版本 | 编译暂停，Ledger 保留 |
| Knowledge Registry Migration | 1 | 只前向迁移；拒绝更高版本 | 召回失败开放为空 |
| Governance Store Migration | 1 | 只前向迁移；拒绝更高版本 | 治理写入停止 |
| Verification Store Schema | 1 | STRICT tables；Recipe/Run canonical hash 必须匹配 | 证据验证与保鲜暂停，不使用损坏证明 |
| Evolution Job Store Schema | 1 | Job 类型、输入字段、幂等键、lease/fencing 和 checkpoint 必须严格匹配 | 新任务停止入队；旧任务保留并报告 `DEGRADED` |
| Operational Alert Store Schema | 1 | alert/event identity、canonical payload hash、revision 和 delivery state 必须严格匹配 | 告警写入失败关闭；主知识任务继续，不能误报外部通知成功 |
| Git Change Observation Schema | 1 | sourceRef、base revision、路径页、observation hash 与 acknowledgement effect 必须一致 | baseline 不推进；当前代码知识停止注入 |
| Freshness Affected Snapshot Schema | 1 | 固定 `(assetId, assetVersion)` 集合、target hash 与分页游标必须一致 | 重验证任务失败关闭，不接受部分结果 |
| Evidence Recipe | `evidence-recipe-v1` | 知识 ID、版本与 Assertion hash 必须精确匹配 | 当前版本不参与自动保鲜 |
| CodeGraph CLI/Index | 运行时能力探测 | 必须返回可归一化状态与稳定 index revision | 代码图证据为 `UNKNOWN`，不自动初始化或发布 |
| Node.js | >=24.18.0 <27 | 依赖稳定 `node:sqlite` | 构建/启动前拒绝 |

## 2. 升级规则

1. Hook/App Server/Sidecar protocol 的 breaking change 必须先增加 Adapter 或新 schemaVersion，不能原地改变领域事件。
2. Plugin 与 sidecar major 不同禁止连接；最低 sidecar 版本由插件声明。
3. 数据库只允许显式、可测试的前向 Migration；新版本写入后不承诺旧二进制可读。
4. Markdown、SQLite projection、FTS 和 Vector 的权威顺序不变：Markdown current 是人可读权威，索引可重建。
5. Codex 新版本必须先增加官方协议 Fixture 和 Hook/App Server 对等测试，再提高“已测试下限/上限”。
6. 兼容检查失败不得阻塞 Codex 原任务，也不得静默扩大 Scope、注入旧知识或把失败状态视为成功。

## 3. 0.4.7 持久化演进能力矩阵

| 能力 | 生产状态 | 兼容/安全边界 |
|---|---|---|
| `KNOWLEDGE_COMPILE` 外层作业 | READY | 自动调度只创建/复用 Preview；不会越过显式 Commit |
| `KNOWLEDGE_REVALIDATE` | READY | 固定当前代码 Recipe 集合，逐页 checkpoint，baseline 最后 CAS 推进 |
| `KNOWLEDGE_REPAIR_DRAFT` | READY | `CONFLICT` 自动创建可追溯 `PENDING` 草稿；不改旧知识、不生成无依据正文、不继承发布授权 |
| 语义演进裁决 | READY（默认关闭） | 只在确定性规则未决时调用一次 Codex；最多 5 个摘要目标，越界/错误/不可用保持 `PENDING` |
| 本地运维告警 | READY | 三类生产事件写入 SQLite；按 dedupKey 冷却聚合，无 provider 时明确标记 `LOCAL_ONLY` |
| `CODEGRAPH_INITIALIZE` | READY（项目索引可为 NOT_CONFIGURED） | 读取绝不初始化；仅对 Sidecar 已观察且规范化的项目开放 expiring preview → explicit commit；固定非 shell argv、总输出 5 MiB、超时与 smoke test 门禁 |
| `LEGACY_KNOWLEDGE_MIGRATION` | READY | 操作员显式 dry-run 后，以 revision/idempotency 门禁提交；支持断点恢复、冲突回滚与 `MIGRATION_FAILED` 告警 |
| 演进运维控制台 | READY | 聚合 Compile/Revalidate/Repair/CodeGraph/Freshness/Migration/Alert/Injection 有界摘要；详情按需加载，读取不产生 Job 或状态写入 |
| 告警操作投影 | READY | acknowledgement/suppression 使用独立 operator revision、CAS 与幂等回执；不修改原始告警，CRITICAL 静默后仍可见 |
| 精确 Freshness 门禁 | READY | 代码/图 revision 不一致即排除；非代码知识继续；总预算不超过 200ms |
| 自动知识发布 | NOT_CONFIGURED | Candidate Preview 后仍需显式策略提交 |

## 4. 机器可读来源

- Plugin 与 sidecar：`plugins/zhiloop/compatibility.json`。
- JSON Schema：`packages/schemas` 注册表。
- 数据库 Migration：各 SQLite Adapter 的 `CURRENT_MIGRATION_VERSION`。
- Node/npm：根目录 `package.json` 的 `engines`。

修改这些来源时必须同步更新本矩阵和兼容性测试。
