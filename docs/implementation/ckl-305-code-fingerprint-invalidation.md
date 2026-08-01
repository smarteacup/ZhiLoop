# CKL-305 代码指纹与失效检测

## 1. 目标与边界

`@zhiloop/invalidation-engine` 从 Candidate 的 FILE/SYMBOL/CONFIG/DEPENDENCY Assertion 派生精确 target，以可信 Adapter 的 digest/source/time 构造确定性 `KnowledgeFingerprint`。ChangeSet 只命中相同 path、symbol、config key 或 dependency name；不相关变更保持原状态。

模块不读取源码、不监听文件、不执行 Verifier、不修改正文或存储。Adapter 负责产生 digest 和结构化 ChangeSet，本模块负责相关性、Fingerprint 完整性和合法 STALE 决策。

## 2. 决策规则

- Fingerprint entry 包含 assertionId、kind、key、可选 path、digest、sourceRef、observedAt；整体 identity 覆盖 Candidate、Project 和有序 entries。
- 传入 Fingerprint 会用 Candidate/entries 重新计算，伪造、缺失、重复、跨项目或 unsafe path 失败关闭，不误标 STALE。
- 无 target 命中：`UNCHANGED + NO_RELEVANT_CHANGE`。
- 有命中且所有受影响 Assertion 重新得到同项目/同 Candidate 的 SUPPORTS Evidence：`REFRESH_FINGERPRINT`。
- IMPLEMENTED/VERIFIED 有命中但缺少、UNKNOWN、ERROR、REFUTED 或伪造复验：沿 Domain 状态机 `MARK_STALE`。
- PROPOSED/ACCEPTED 不允许非法进入 STALE，只输出 `REVALIDATE`。
- 所有输出固定 `preserveBody: true`；正文、旧 Evidence 和版本历史不删除。

Symbol 无 path 时依赖 Code Adapter 输出 `changedSymbols`；Config/Dependency 同时响应 key/name 和可选配置/manifest path。ChangeSet 必须列出规范相对文件路径，拒绝 absolute、drive、反斜杠和 traversal。

## 3. 验证

- 12 条专项测试覆盖四类 target、确定性 fingerprint、缺失/重复/伪造观察、不相关文件、四类相关变化、完整复验、非法状态迁移和跨项目 SUPPORT 防伪。
- 2 条架构/Gate 测试验证模块无模型/I/O/存储/进程能力，并确认相关变化令 VERIFIED→STALE 且正文保持。
- 模块 Lines 98.41%、Branches 94.62%、Functions 100%；全仓 342 模块测试、35 架构/Gate 测试，整体 Lines 96.97%、Branches 90.36%。
- 10,000 次决策中位 16.916ms、P95 19.199ms；npm 官方审计 0 vulnerabilities。

## 4. 已知边界

- 文件监听、Git diff→changedSymbols 解析和实际 digest 计算属于 Daemon Adapter。
- REFRESH_FINGERPRINT 只表示可安全生成新 snapshot；原子持久化由后续 Registry 完成。
- 当前未安装 Hook、未启动 Daemon，也未读写用户配置目录。
