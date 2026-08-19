# ZhiLoop（知环）

> 让对话沉淀为知识，让知识回到任务。

ZhiLoop 是一个面向 AI 编程代理的动态知识层。其核心架构 Codex Knowledge Layer（CKL）首先接入 Codex，负责将对话中的需求、边界、方案原因、决策和经验转化为分层、可追溯的语义知识，并根据任务动态控制注入复杂度；任务结束前可通过有限闭环校验边界和完成门禁。符号、调用链和影响范围等可重建代码事实不应复制为长期知识，目标架构通过 CodeGraph Adapter 实时获取。

ZhiLoop 不绑定单一模型或客户端，也不是单纯的 RAG 或 Task Contract。知识注入、任务契约和闭环验证都是可组合能力：默认向 AI 编程代理提供少量边界、门禁、已有能力和知识指针，运行中再按需展开。

当前 P0-P7 与持续知识演进 M1-M10 已完成：覆盖 Codex/App Server 对话沉淀、自动 Candidate Preview、用户承诺、知识演进、CodeGraph 事实层、代码变化保鲜、Markdown/SQLite、混合召回、渐进注入、MCP 展开、有限闭环、控制台观测、Codex/CCM Hook 共存和可回滚部署。当前发行版 `0.4.1` 仍默认运行在 `SHADOW + PREVIEW_ONLY`；只有经过显式 ACTIVE 资格与灰度门禁后才会把内容实际注入模型，自动发布 consumer 仍保持关闭。

CodeGraph 实时代码事实层、CodeAnchor、变化驱动复验、召回前 Freshness Gate 与显式初始化控制面均已接通。CodeGraph 读取不会隐式写仓库；只有本地操作者完成 preview → commit 后才会创建初始化任务。

## 文档入口

- [产品介绍与分享材料](docs/zhiloop-product-introduction.md)
- [技术设计](docs/design/codex-knowledge-layer-tdd.md)
- [CodeGraph 集成与知识保鲜技术设计](docs/design/codegraph-integration-and-knowledge-freshness-tdd.md)
- [实施计划](docs/implementation/implementation-plan.md)
- [实施进度与验证记录](docs/implementation/progress.md)
- [MVP 最终验收报告](docs/implementation/mvp-final-acceptance-report.md)
- [实施计划完成审计](docs/implementation/completion-audit.md)
- [版本兼容矩阵](docs/implementation/version-compatibility-matrix.md)
- [本地部署与回滚](docs/deployment.md)
- [CKL-706：本地 sidecar 与可回滚部署](docs/implementation/ckl-706-local-deployment.md)
- [CKL-707：指定 Codex 会话主动采集](docs/implementation/ckl-707-codex-session-capture.md)
- [Console P4 实施与真实验收报告](docs/implementation/zhiloop-console-p4-report.md)
- [ADR-0001：模块化单体](docs/adr/0001-modular-monolith.md)
- [ADR-0002：Markdown 与 SQLite](docs/adr/0002-markdown-sqlite-storage.md)
- [ADR-0003：Codex 接入](docs/adr/0003-codex-integration.md)
- [ADR-0004：可控复杂度知识注入与闭环验证](docs/adr/0004-context-orchestration-and-closure.md)
- [ADR-0005：使用 CodeGraph 作为实时代码事实层](docs/adr/0005-codegraph-as-live-code-fact-layer.md)

## 当前状态

- 系统设计：MVP Implementation Baseline
- P0-P4 Console、运行时与本地部署：全部完成并通过模块、集成和浏览器 Gate
- 自动化验证：超过 1,680 项单元/集成测试，另有 60 项架构/发布 Gate、依赖、lint、build、typecheck、coverage 与隔离部署门禁
- 运行模式：当前发行版 `0.4.1` READY/SHADOW，LaunchAgent `dev.zhiloop.sidecar`
- 真实验收：会话 `019f837a-34d4-7e60-800c-6361f6fb6d49` 沉淀 98 条事件、49 个 Turn，生成 8 条候选并发布 6 条可召回知识；搜索与本地 Codex 问答均成功且可追溯，CCM 配置 hash 保持不变

## 本地验证

```bash
npm ci
npm run clean
npm run check
```

`npm run check` 通过只表示源码与隔离部署门禁通过；真实 HOME 的安装/升级、ACTIVE 切换和 purge 仍是彼此独立的授权动作。当前已完成本机 SHADOW 安装与真实链路验收，未授权 ACTIVE 或数据 purge。
