# ZhiLoop（知环）

> 让对话沉淀为知识，让知识回到任务。

ZhiLoop 是一个面向 AI 编程代理的动态知识层。其核心架构 Codex Knowledge Layer（CKL）首先接入 Codex，负责将对话中的需求、方案、决策、实现和经验转化为分层、可追溯的知识，并根据任务动态控制注入复杂度；任务结束前可通过有限闭环校验边界和完成门禁。

ZhiLoop 不绑定单一模型或客户端，也不是单纯的 RAG 或 Task Contract。知识注入、任务契约和闭环验证都是可组合能力：默认向 AI 编程代理提供少量边界、门禁、已有能力和知识指针，运行中再按需展开。

当前已完成 P0 工程与领域骨架，具备可构建的 Domain、JSON Schema 和安全配置模块。系统尚处于本地实现阶段，未安装 Hook、未启动后台进程，也不会修改 `~/.codex`、`~/.ccm` 或业务仓库。

## 文档入口

- [技术设计](docs/design/codex-knowledge-layer-tdd.md)
- [实施计划](docs/implementation/implementation-plan.md)
- [实施进度与验证记录](docs/implementation/progress.md)
- [ADR-0001：模块化单体](docs/adr/0001-modular-monolith.md)
- [ADR-0002：Markdown 与 SQLite](docs/adr/0002-markdown-sqlite-storage.md)
- [ADR-0003：Codex 接入](docs/adr/0003-codex-integration.md)
- [ADR-0004：可控复杂度知识注入与闭环验证](docs/adr/0004-context-orchestration-and-closure.md)

## 当前状态

- 系统设计：Implementation Baseline（0.3）
- P0：已完成并通过 Gate
- P1：待实施（Codex 捕获与 Event Ledger）
- 运行模式：未启用，保持纯本地源码与测试状态
