## Why

ZhiLoop 当前可以从 Codex 对话提取并验证知识，但候选和正式知识缺少足够的项目、分支与场景定位，导致人和模型仅凭正文无法判断适用边界。随着知识增长，自由文本 `applicability` 也无法可靠维护重叠场景；同时，Codex 已通过 CodeGraph 得出的调用链和影响结论没有成为可复用、可失效的知识证据，后续任务仍会重复分析。

## What Changes

- 为代码知识增加结构化定位契约：仓库、项目、采集分支、Git commit、分支适用策略、模块、符号、入口点和稳定场景 ID。
- 把场景从知识上的自由文本提升为可版本化实体，支持场景卡片、父子/重叠关系、适用与排除条件、知识绑定及安全的新增、更新、合并、拆分和废弃。
- 在候选编译和发布门禁中要求定位完整性，并区分当前代码事实、用户决策和未来实施要求，避免用“当前代码不存在”反驳未来方案。
- 把 CodeGraph 查询和结果保存为带 Git/图谱版本的证据 artifact，并将其归纳结论绑定到知识；相关代码未变化时复用，受影响时自动复验或失效。
- 将自动召回改为“硬定位过滤 → 小型场景目录 → 按需展开知识”，不再仅靠文本相似度决定项目代码知识是否注入。
- 在控制台展示知识定位、场景、CodeGraph 来源、新鲜度和演进关系，使抽取结果可理解、可追溯、可维护。
- 增加真实会话验收脚本和结果报告，验证抽取出的内容、定位、证据门禁与召回行为符合预期。

## Capabilities

### New Capabilities

- `located-knowledge`: 定义代码知识的项目、分支、版本、场景、入口点和适用边界，以及发布前的定位门禁。
- `scenario-knowledge-maintenance`: 定义稳定场景注册表、知识绑定、重叠检测、版本化维护和两阶段场景感知召回。
- `codegraph-derived-knowledge`: 定义 CodeGraph 查询 artifact、派生结论、版本匹配、复用和增量失效。

### Modified Capabilities

- `codex-session-console`: 会话提取预览和知识详情需要展示定位、场景及 CodeGraph 证据。
- `knowledge-query-console`: 自然语言召回需要显示场景选择、硬过滤原因和按需展开路径。

## Impact

- Domain：Knowledge Candidate/Asset、Scope、Evidence、QueryContext 和 Evolution 类型。
- Compilation：模型输出契约、候选规范化、定位解析和证据断言生成。
- Storage：Markdown、Registry、SQLite checkpoint/outbox 投影，以及新场景和 CodeGraph artifact 存储。
- Runtime：项目/分支解析、召回过滤、场景目录、渐进披露、反馈和新鲜度复验。
- Console/API：候选预览、知识详情、场景浏览和召回 trace。
- Compatibility：旧知识按 schema v1 继续可读，但未补齐定位前不得作为代码事实跨分支自动注入；迁移以派生投影和增量补全完成，不改写 Ledger 原始事件。
