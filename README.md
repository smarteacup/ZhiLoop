# ZhiLoop（知环）

> 让对话沉淀为知识，让知识回到任务。

ZhiLoop 是一个面向 AI 编程代理的动态知识层。其核心架构 Codex Knowledge Layer（CKL）首先接入 Codex，负责将对话中的需求、方案、决策、实现和经验转化为分层、可追溯的知识，并根据任务动态控制注入复杂度；任务结束前可通过有限闭环校验边界和完成门禁。

ZhiLoop 不绑定单一模型或客户端，也不是单纯的 RAG 或 Task Contract。知识注入、任务契约和闭环验证都是可组合能力：默认向 AI 编程代理提供少量边界、门禁、已有能力和知识指针，运行中再按需展开。

当前 P0-P7 源码实施与本地部署基线已经完成：覆盖 Codex/App Server 对话沉淀、默认只读 `codex exec` 抽取、证据驱动知识生命周期、Markdown/SQLite、混合召回、可控注入、MCP 展开、有限闭环、历史回填、Codex/CCM Hook 共存、sidecar 与可回滚部署。当前开发机已安装 `0.1.4`，支持按 session ID 主动采集本地 Codex 主会话，但仍只运行 SHADOW：事件会进入 ledger，不向模型注入内容；ACTIVE 和生产知识编译/注入仍未启用。

## 文档入口

- [技术设计](docs/design/codex-knowledge-layer-tdd.md)
- [实施计划](docs/implementation/implementation-plan.md)
- [实施进度与验证记录](docs/implementation/progress.md)
- [MVP 最终验收报告](docs/implementation/mvp-final-acceptance-report.md)
- [实施计划完成审计](docs/implementation/completion-audit.md)
- [版本兼容矩阵](docs/implementation/version-compatibility-matrix.md)
- [本地部署与回滚](docs/deployment.md)
- [CKL-706：本地 sidecar 与可回滚部署](docs/implementation/ckl-706-local-deployment.md)
- [CKL-707：指定 Codex 会话主动采集](docs/implementation/ckl-707-codex-session-capture.md)
- [ADR-0001：模块化单体](docs/adr/0001-modular-monolith.md)
- [ADR-0002：Markdown 与 SQLite](docs/adr/0002-markdown-sqlite-storage.md)
- [ADR-0003：Codex 接入](docs/adr/0003-codex-integration.md)
- [ADR-0004：可控复杂度知识注入与闭环验证](docs/adr/0004-context-orchestration-and-closure.md)

## 当前状态

- 系统设计：MVP Implementation Baseline
- P0-P7 与本地部署：全部完成并通过 Gate
- 自动化验证：683 项模块测试、52 项架构/Gate 测试
- 运行模式：当前用户 `0.1.4` READY/SHADOW，LaunchAgent `dev.zhiloop.sidecar`
- 真实验收：会话 `019f837a-34d4-7e60-800c-6361f6fb6d49` dry-run 零写入，正式采集 98 条事件，重复采集新增 0 条；spool 无积压、日志无正文、CCM 配置 hash 不变

## 本地验证

```bash
npm ci
npm run clean
npm run check
```

`npm run check` 通过只表示源码与隔离部署门禁通过；真实 HOME 的安装、升级、ACTIVE 切换、知识迁移和 purge 仍是彼此独立的授权动作。当前只完成了本机 SHADOW 安装。
