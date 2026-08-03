# ZhiLoop（知环）

> 让对话沉淀为知识，让知识回到任务。

ZhiLoop 是一个面向 AI 编程代理的动态知识层。其核心架构 Codex Knowledge Layer（CKL）首先接入 Codex，负责将对话中的需求、方案、决策、实现和经验转化为分层、可追溯的知识，并根据任务动态控制注入复杂度；任务结束前可通过有限闭环校验边界和完成门禁。

ZhiLoop 不绑定单一模型或客户端，也不是单纯的 RAG 或 Task Contract。知识注入、任务契约和闭环验证都是可组合能力：默认向 AI 编程代理提供少量边界、门禁、已有能力和知识指针，运行中再按需展开。

当前 P0-P7 源码实施基线已经完成：覆盖 Codex/App Server 对话沉淀、默认只读 `codex exec` 抽取、证据驱动知识生命周期、Markdown/SQLite、混合召回、可控注入、MCP 展开、有限闭环、历史回填、Codex/CCM 插件包装与 Daemon 应用编排。系统仍保持未部署状态，不会自行安装 Hook、启动后台进程或修改 `~/.codex`、`~/.ccm`、`~/.ckl` 和业务仓库。

## 文档入口

- [技术设计](docs/design/codex-knowledge-layer-tdd.md)
- [实施计划](docs/implementation/implementation-plan.md)
- [实施进度与验证记录](docs/implementation/progress.md)
- [MVP 最终验收报告](docs/implementation/mvp-final-acceptance-report.md)
- [实施计划完成审计](docs/implementation/completion-audit.md)
- [版本兼容矩阵](docs/implementation/version-compatibility-matrix.md)
- [ADR-0001：模块化单体](docs/adr/0001-modular-monolith.md)
- [ADR-0002：Markdown 与 SQLite](docs/adr/0002-markdown-sqlite-storage.md)
- [ADR-0003：Codex 接入](docs/adr/0003-codex-integration.md)
- [ADR-0004：可控复杂度知识注入与闭环验证](docs/adr/0004-context-orchestration-and-closure.md)

## 当前状态

- 系统设计：MVP Implementation Baseline
- P0-P7：全部完成并通过 Gate
- 自动化验证：630 项模块测试、51 项架构/Gate 测试
- 运行模式：未启用，保持纯本地源码与测试状态

## 本地验证

```bash
npm ci
npm run clean
npm run check
```

源码完成不等于已授权部署。真实启用还需要发行包提供 `zhiloop-sidecar` 进程 transport，并明确选择安装目录、服务管理方式和回滚窗口。
