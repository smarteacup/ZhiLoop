# ZhiLoop 版本兼容矩阵

**矩阵版本**：1  
**更新日期**：2026-08-02

## 1. 当前基线

| 组件 | 当前版本 | 兼容规则 | 不兼容时行为 |
|---|---|---|---|
| ZhiLoop Plugin | 0.1.0 | 与 sidecar 使用同一 Plugin contract 版本 | Hook 失败开放；MCP/doctor 报错 |
| ZhiLoop Sidecar | >=0.1.0、major=0 | 不低于最低版本且 major 相同 | 不自动替换已运行进程 |
| Sidecar Protocol | 1 | 必须精确匹配 | 拒绝连接 |
| Codex CLI | >=0.144.4（已测试下限） | 需要 Plugin v1、Hooks v1、App Server v2 | 启用前 doctor 检查 |
| Codex Hook Schema | `codex-hooks-v1` | 必须精确匹配 | Hook launcher 空输出放行 |
| Codex App Server | `codex-app-server-v2` | 必须精确匹配 | 停止结构化实时采集/回填，不回退伪造事件 |
| Event/Candidate/Asset Schema | 1 | Reader 只接受已注册版本 | 拒绝该记录并返回诊断 |
| Context/Confirmation Schema | 1 | Reader 只接受已注册版本 | 不注入/不写回 |
| Markdown Schema | 1 | `schema_version: 1` | 不索引未知版本 |
| Event Ledger Migration | 1 | 只前向迁移；拒绝更高版本 | 启动失败，不降级写库 |
| Candidate Repository Migration | 1 | 只前向迁移；拒绝更高版本 | 编译暂停，Ledger 保留 |
| Knowledge Registry Migration | 1 | 只前向迁移；拒绝更高版本 | 召回失败开放为空 |
| Governance Store Migration | 1 | 只前向迁移；拒绝更高版本 | 治理写入停止 |
| Node.js | >=24.18.0 <27 | 依赖稳定 `node:sqlite` | 构建/启动前拒绝 |

## 2. 升级规则

1. Hook/App Server/Sidecar protocol 的 breaking change 必须先增加 Adapter 或新 schemaVersion，不能原地改变领域事件。
2. Plugin 与 sidecar major 不同禁止连接；最低 sidecar 版本由插件声明。
3. 数据库只允许显式、可测试的前向 Migration；新版本写入后不承诺旧二进制可读。
4. Markdown、SQLite projection、FTS 和 Vector 的权威顺序不变：Markdown current 是人可读权威，索引可重建。
5. Codex 新版本必须先增加官方协议 Fixture 和 Hook/App Server 对等测试，再提高“已测试下限/上限”。
6. 兼容检查失败不得阻塞 Codex 原任务，也不得静默扩大 Scope、注入旧知识或把失败状态视为成功。

## 3. 机器可读来源

- Plugin 与 sidecar：`plugins/zhiloop/compatibility.json`。
- JSON Schema：`packages/schemas` 注册表。
- 数据库 Migration：各 SQLite Adapter 的 `CURRENT_MIGRATION_VERSION`。
- Node/npm：根目录 `package.json` 的 `engines`。

修改这些来源时必须同步更新本矩阵和兼容性测试。
